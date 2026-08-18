const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { parse } = require("json2csv");
const { CamofoxClient, normalizeTarget, ensureAuthenticated } = require("./script.js");

dotenv.config();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Random jitter sleep between min and max milliseconds.
 */
async function jitterSleep(minMs = 3000, maxMs = 7000) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await sleep(ms);
}

/**
 * Loads usernames from CSV file.
 */
function loadUsernamesFromCSV(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file not found at: ${csvPath}`);
  }

  const content = fs.readFileSync(csvPath, "utf-8");
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return [];

  const header = lines[0].split(",").map((h) => h.replace(/^["']|["']$/g, "").trim());
  const usernameIdx = header.indexOf("username");
  const idIdx = header.indexOf("id");
  const nameIdx = header.indexOf("name");
  const isBotIdx = header.indexOf("is_bot");

  const candidates = [];
  for (let i = 1; i < lines.length; i++) {
    const rowMatches = lines[i].match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || lines[i].split(",");
    const cleanRow = rowMatches.map((c) => c.replace(/^["']|["']$/g, "").trim());

    const username = usernameIdx !== -1 ? (cleanRow[usernameIdx] || "").replace(/^@/, "").trim() : "";
    const id = idIdx !== -1 ? cleanRow[idIdx] || "" : "";
    const name = nameIdx !== -1 ? cleanRow[nameIdx] || "" : "";
    const isBot = isBotIdx !== -1 ? (cleanRow[isBotIdx] || "").toLowerCase() === "true" : false;

    if (username && !isBot) {
      candidates.push({
        username,
        id,
        name: name || username,
      });
    }
  }

  // Deduplicate by username
  const uniqueMap = new Map();
  for (const c of candidates) {
    if (!uniqueMap.has(c.username.toLowerCase())) {
      uniqueMap.set(c.username.toLowerCase(), c);
    }
  }

  return Array.from(uniqueMap.values());
}

/**
 * Loads existing processed status map from previous results CSV if available.
 */
function loadExistingResults(resultCsvPath) {
  const map = new Map();
  if (!fs.existsSync(resultCsvPath)) return map;

  try {
    const content = fs.readFileSync(resultCsvPath, "utf-8");
    const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length <= 1) return map;

    const header = lines[0].split(",").map((h) => h.replace(/^["']|["']$/g, "").trim());
    const usernameIdx = header.indexOf("username");
    const statusIdx = header.indexOf("status");
    const detailIdx = header.indexOf("detail");
    const idIdx = header.indexOf("id");
    const nameIdx = header.indexOf("name");

    for (let i = 1; i < lines.length; i++) {
      const rowMatches = lines[i].match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || lines[i].split(",");
      const cleanRow = rowMatches.map((c) => c.replace(/^["']|["']$/g, "").trim());
      const uname = (cleanRow[usernameIdx] || "").replace(/^@/, "").toLowerCase();
      if (uname) {
        map.set(uname, {
          username: cleanRow[usernameIdx] || "",
          id: cleanRow[idIdx] || "",
          name: cleanRow[nameIdx] || "",
          status: cleanRow[statusIdx] || "",
          detail: cleanRow[detailIdx] || "",
        });
      }
    }
  } catch {}

  return map;
}

/**
 * Initializes target channel in Telegram Web K session.
 */
async function initChannel(client, tabId, channelHandle) {
  const cleanHandle = channelHandle.replace(/^[@/]+/, "");

  const res = await client.evaluate(
    tabId,
    `(async () => {
      const m = window.rootScope?.managers || {};
      if (!m.apiManager) {
        return { error: "Telegram API manager is not ready." };
      }

      try {
        const resolved = await m.apiManager.invokeApi('contacts.resolveUsername', { username: ${JSON.stringify(cleanHandle)} });
        if (!resolved || !resolved.chats || resolved.chats.length === 0) {
          return { error: "Channel @" + ${JSON.stringify(cleanHandle)} + " could not be resolved." };
        }

        const channel = resolved.chats[0];
        window._inviteChannel = {
          _: 'inputChannel',
          channel_id: channel.id,
          access_hash: channel.access_hash
        };
        window._inviteChannelTitle = channel.title;
        window._inviteChannelId = channel.id;

        return {
          ok: true,
          title: channel.title,
          id: channel.id,
          creator: !!(channel.pFlags && channel.pFlags.creator),
        };
      } catch(err) {
        return { error: err.message || String(err) };
      }
    })()`
  );

  const data = res?.result || res?.value || res;
  if (!data || data.error) {
    throw new Error(data?.error || "Failed to initialize channel in Telegram Web.");
  }
  return data;
}

/**
 * Invites a single candidate username into the initialized channel with error classification.
 */
async function inviteSingleUser(client, tabId, item) {
  const payloadJson = JSON.stringify(item);

  const res = await client.evaluate(
    tabId,
    `(async () => {
      const m = window.rootScope?.managers || {};
      const channel = window._inviteChannel;
      if (!channel) return { error: "No channel initialized." };

      const item = ${payloadJson};
      const uname = item.username;

      try {
        const resolved = await m.apiManager.invokeApi('contacts.resolveUsername', { username: uname });
        if (!resolved || !resolved.users || resolved.users.length === 0) {
          return {
            username: uname,
            id: item.id || '',
            name: item.name || uname,
            status: 'NOT_FOUND',
            detail: 'Kullanıcı adı bulunamadı'
          };
        }

        const u = resolved.users[0];
        const inputUser = {
          _: 'inputUser',
          user_id: u.id,
          access_hash: u.access_hash
        };

        const inviteRes = await m.apiManager.invokeApi('channels.inviteToChannel', {
          channel,
          users: [inputUser]
        });

        const isMissing = inviteRes.missing_invitees && inviteRes.missing_invitees.length > 0;
        if (isMissing) {
          return {
            username: uname,
            id: String(u.id),
            name: [u.first_name, u.last_name].filter(Boolean).join(' ') || item.name,
            status: 'PRIVACY_RESTRICTED',
            detail: 'Gizlilik kısıtlaması (Kullanıcı ayarı: Sadece Rehberim)'
          };
        } else {
          return {
            username: uname,
            id: String(u.id),
            name: [u.first_name, u.last_name].filter(Boolean).join(' ') || item.name,
            status: 'ADDED_SUCCESSFULLY',
            detail: 'Kanala başarıyla abone yapıldı'
          };
        }
      } catch(err) {
        const errMsg = (err && (err.message || err.text || err.type || err.error)) || String(err);
        let status = 'ERROR';
        let detail = errMsg;
        let floodWaitSeconds = 0;

        if (/USER_ALREADY_PARTICIPANT/i.test(errMsg)) {
          status = 'ALREADY_PARTICIPANT';
          detail = 'Kullanıcı zaten kanal abonesi';
        } else if (/USER_PRIVACY_RESTRICTED/i.test(errMsg)) {
          status = 'PRIVACY_RESTRICTED';
          detail = 'Gizlilik kısıtlaması (Kullanıcı ayarı: Sadece Rehberim)';
        } else if (/USER_NOT_MUTUAL_CONTACT/i.test(errMsg)) {
          status = 'NOT_MUTUAL_CONTACT';
          detail = 'Karşılıklı rehber kaydı gerektiriyor';
        } else if (/FLOOD_WAIT/i.test(errMsg)) {
          const match = errMsg.match(/FLOOD_WAIT[ _:]*(\d+)/i);
          floodWaitSeconds = match ? parseInt(match[1], 10) : 120;
          status = 'FLOOD_WAIT';
          detail = 'Telegram hız sınırı: ' + floodWaitSeconds + ' saniye beklenmeli';
        } else if (/PEER_FLOOD/i.test(errMsg)) {
          status = 'PEER_FLOOD';
          detail = 'Telegram PEER_FLOOD hız koruması';
        }

        return {
          username: uname,
          id: item.id || '',
          name: item.name || uname,
          status,
          detail,
          floodWaitSeconds,
        };
      }
    })()`
  );

  const data = res?.result || res?.value || res;
  if (!data || data.error) {
    throw new Error(data?.error || "Execution error");
  }
  return data;
}

/**
 * Backward compatibility helper for batch tests.
 */
async function inviteBatch(client, tabId, userBatch) {
  const results = [];
  for (const u of userBatch) {
    const r = await inviteSingleUser(client, tabId, u);
    results.push(r);
  }
  return results;
}

async function main() {
  const channelTarget = process.argv[2] || process.env.CHANNEL_TARGET || "https://web.telegram.org/k/#@firsattakipkanali";
  const csvFile = process.argv[3] || process.env.CSV_INPUT || "participants.csv";
  const camofoxUrl = process.env.CAMOFOX_URL || "http://127.0.0.1:9377";
  const userId = process.env.CAMOFOX_USER_ID || "tg-scraper-user";
  const minDelayMs = parseInt(process.env.DELAY_MIN_MS || "3000", 10);
  const maxDelayMs = parseInt(process.env.DELAY_MAX_MS || "6000", 10);
  const maxAdds = parseInt(process.env.MAX_ADDS || "500", 10);

  const { handle: channelHandle } = normalizeTarget(channelTarget);

  console.log("=== Telegram Channel Subscriber Adder (Camofox) ===");
  console.log(`Hedef Kanal: @${channelHandle}`);
  console.log(`Kaynak CSV: ${path.resolve(csvFile)}`);
  console.log(`İstekler Arası Bekleme (Jitter): ${minDelayMs / 1000}s - ${maxDelayMs / 1000}s`);
  console.log(`Camofox URL: ${camofoxUrl}`);
  console.log(`Session User ID: ${userId}\n`);

  // 1. Load candidate usernames
  const candidates = loadUsernamesFromCSV(csvFile);
  console.log(`✓ CSV dosyasından ${candidates.length} tekil kullanıcı adı yüklendi.`);

  if (candidates.length === 0) {
    console.log("Eklenecek kullanıcı bulunamadı.");
    process.exit(0);
  }

  // 2. Load existing results to skip previously successful/restricted users
  const resultCsvPath = "subscribers-result.csv";
  const existingMap = loadExistingResults(resultCsvPath);
  if (existingMap.size > 0) {
    console.log(`ℹ Önceki çalıştırmadan ${existingMap.size} kayıt bulundu. Kesinleşenler atlanacak.`);
  }

  // Filter candidates: skip those already successfully added, already participants, or permanently privacy-restricted
  const pendingCandidates = candidates.filter((c) => {
    const prev = existingMap.get(c.username.toLowerCase());
    if (!prev) return true;
    if (
      prev.status === "ADDED_SUCCESSFULLY" ||
      prev.status === "ALREADY_PARTICIPANT" ||
      prev.status === "PRIVACY_RESTRICTED"
    ) {
      return false; // Skip
    }
    return true;
  });

  console.log(`✓ İşleme alınacak aday sayısı: ${pendingCandidates.length} / ${candidates.length}\n`);

  if (pendingCandidates.length === 0) {
    console.log("Tüm kullanıcılar daha önce işlenmiş. Yeni kullanıcı bulunmuyor.");
    process.exit(0);
  }

  // 3. Connect to Camofox
  const client = new CamofoxClient({ baseUrl: camofoxUrl, userId });
  const isHealthy = await client.checkHealth();
  if (!isHealthy) {
    console.error(`Error: Cannot connect to Camofox server at ${camofoxUrl}`);
    process.exit(1);
  }

  let tabId = null;
  const resultMap = new Map(existingMap);

  try {
    tabId = await client.createTab({ sessionKey: "tg-subscribers-session", url: "https://web.telegram.org/k/" });
    await ensureAuthenticated(client, tabId);

    console.log(`Hedef kanal bilgileri alınıyor: @${channelHandle}...`);
    const chanInfo = await initChannel(client, tabId, channelHandle);
    console.log(`✓ Kanal bulundu: "${chanInfo.title}" (ID: ${chanInfo.id})\n`);

    console.log("--- Hız Korumalı Abone Ekleme Başlatıldı ---");
    let addedCount = 0;
    let restrictedCount = 0;
    let floodCount = 0;
    let errorCount = 0;
    let alreadyCount = 0;

    for (let i = 0; i < pendingCandidates.length; i++) {
      if (addedCount >= maxAdds) {
        console.log(`\n✓ Belirlenen maksimum ekleme sınırına (${maxAdds}) ulaşıldı.`);
        break;
      }

      const item = pendingCandidates[i];
      let res;
      try {
        res = await inviteSingleUser(client, tabId, item);
      } catch (err) {
        res = {
          username: item.username,
          id: item.id || '',
          name: item.name || item.username,
          status: 'ERROR',
          detail: err.message || String(err),
        };
      }

      resultMap.set(item.username.toLowerCase(), res);

      const symbol =
        res.status === "ADDED_SUCCESSFULLY"
          ? "✓"
          : res.status === "ALREADY_PARTICIPANT"
          ? "ℹ"
          : res.status === "PRIVACY_RESTRICTED"
          ? "⚠️"
          : res.status === "FLOOD_WAIT" || res.status === "PEER_FLOOD"
          ? "⏳"
          : "✖";

      console.log(
        `[${i + 1}/${pendingCandidates.length}] ${symbol} @${res.username} (${res.name}): ${res.detail}`
      );

      if (res.status === "ADDED_SUCCESSFULLY") addedCount++;
      else if (res.status === "PRIVACY_RESTRICTED") restrictedCount++;
      else if (res.status === "ALREADY_PARTICIPANT") alreadyCount++;
      else if (res.status === "FLOOD_WAIT" || res.status === "PEER_FLOOD") floodCount++;
      else errorCount++;

      // Save progressive CSV after each attempt
      try {
        const fields = ["username", "id", "name", "status", "detail"];
        const csvData = parse(Array.from(resultMap.values()), { fields });
        fs.writeFileSync(resultCsvPath, csvData, "utf-8");
      } catch {}

      // Handle FLOOD_WAIT with live countdown or graceful halt
      if (res.status === "FLOOD_WAIT" && res.floodWaitSeconds > 0) {
        const waitSec = res.floodWaitSeconds + 3;
        if (waitSec > 60) {
          const waitMin = Math.ceil(waitSec / 60);
          console.log(`\n======================================================`);
          console.log(`⏳ Telegram Hız Sınırı (FLOOD_WAIT) Aktif!`);
          console.log(`Telegram sunucusu bu hesap için ${waitSec} saniye (~${waitMin} dakika) bekleme süresi uyguladı.`);
          console.log(`Hesabın güvenliği için ekleme işlemi durduruldu.`);
          console.log(`Tüm ilerleme kaydedildi: ${path.resolve(resultCsvPath)}`);
          console.log(`Süre dolduktan sonra komutu tekrar çalıştırarak kaldığınız yerden devam edebilirsiniz.`);
          console.log(`======================================================\n`);
          break;
        } else {
          console.log(`⏳ Telegram hız sınırı: ${waitSec} saniye bekleniyor...`);
          for (let s = waitSec; s > 0; s--) {
            process.stdout.write(`\rKalan bekleme süresi: ${s} saniye...   `);
            await sleep(1000);
          }
          process.stdout.write("\nBekleme tamamlandı, devam ediliyor...\n");
        }
      } else if (res.status === "PEER_FLOOD") {
        // Progressive backoff for PEER_FLOOD
        const backoffMs = 15000 + Math.floor(Math.random() * 10000);
        console.log(`⏳ PEER_FLOOD koruması. ${Math.round(backoffMs / 1000)}s bekleniyor...`);
        await sleep(backoffMs);
      } else {
        // Standard human-like jitter sleep between requests
        await jitterSleep(minDelayMs, maxDelayMs);
      }

      // Small breather every 10 invites
      if ((i + 1) % 10 === 0 && i + 1 < pendingCandidates.length) {
        console.log("☕ 10 kullanıcı işlendi, 12 saniyelik güvenlik molası veriliyor...");
        await sleep(12000);
      }
    }

    console.log("\n========================================");
    console.log("İşlem Özeti:");
    console.log(`Bu Oturumda İncelenen: ${pendingCandidates.length}`);
    console.log(`Yeni Başarıyla Eklenen: ${addedCount}`);
    console.log(`Zaten Abone Olan: ${alreadyCount}`);
    console.log(`Gizlilik Kısıtlamalı (Rehber Şartı): ${restrictedCount}`);
    console.log(`Hız Sınırı (Flood): ${floodCount}`);
    console.log(`Hata / Bulunamayan: ${errorCount}`);
    console.log(`Toplam Kayıtlı Sonuç: ${resultMap.size}`);
    console.log("========================================\n");

    console.log(`✓ Güncel ekleme raporu kaydedildi: ${path.resolve(resultCsvPath)}`);
  } catch (err) {
    console.error("Hata oluştu:", err.message);
  } finally {
    if (tabId) {
      await client.closeTab(tabId);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadUsernamesFromCSV,
  loadExistingResults,
  initChannel,
  inviteSingleUser,
  inviteBatch,
};
