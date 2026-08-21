const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { parse } = require("json2csv");
const { CamofoxClient, ensureAuthenticated, normalizeTarget } = require("./script.js");
const { loadUsernamesFromCSV } = require("./add-subscribers.js");

dotenv.config();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Message templates with variations to ensure natural messaging.
 */
function getPersonalizedMessage(name, channelLink) {
  const cleanName = name && name.trim() ? name.split(" ")[0].replace(/[^a-zA-ZçğıöşüÇĞİÖŞÜ0-9]/g, "") : "";
  const greeting = cleanName ? `Merhaba ${cleanName}` : "Merhaba";
  const link = channelLink.startsWith("http") ? channelLink : `https://${channelLink}`;

  const templates = [
    `${greeting} 👋 Amazon, Trendyol ve Hepsiburada'daki anlık fiyat hataları, kuponlar ve sıcak indirimleri anında paylaştığımız fırsat kanalımıza göz atmak istersen bekleriz:\n👉 ${link}`,
    `${greeting} ✨ İnternet alışverişlerinde geçerli indirim kodları, bedava kuponlar ve dip fiyat fırsatlarını anlık bildirimle paylaşıyoruz. Fırsatları kaçırmamak için davet bağlantımız:\n👉 ${link}`,
    `${greeting}, e-ticaretteki en iyi kampanya ve kaçırılmayacak fiyat düşüşlerini anlık olarak topladığımız Telegram kanalımıza katılabilirsin:\n👉 ${link}`,
    `Selamlar ${cleanName ? cleanName : ""} 🙌 Online alışverişte tasarruf etmeyi seviyorsan; sıcak fırsatlar, anlık kuponlar ve indirimleri kaçırmamak için aramıza katılabilirsin:\n👉 ${link}`,
    `${greeting} 🛍️ Günlük sıcak fırsatlar, market/yemek indirimleri ve teknoloji kampanyalarını takip ettiğimiz kanalımıza davetlisin:\n👉 ${link}`,
    `${greeting} 🎯 Fiyatı aniden düşen ürünleri ve özel kampanya kuponlarını paylaştığımız ücretsiz fırsat takip kanalımıza bekleriz:\n👉 ${link}`
  ];

  const index = Math.floor(Math.random() * templates.length);
  return templates[index];
}

/**
 * Loads previously sent DMs to prevent duplicate messaging.
 */
function loadExistingDMResults(csvPath) {
  const map = new Map();
  if (!fs.existsSync(csvPath)) return map;

  try {
    const content = fs.readFileSync(csvPath, "utf-8");
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
 * Sends a direct message with channel invite link to a single user.
 */
async function sendInviteDM(client, tabId, item, channelLink) {
  const msgText = getPersonalizedMessage(item.name, channelLink);
  const payloadJson = JSON.stringify({
    username: item.username,
    id: item.id,
    name: item.name,
    message: msgText
  });

  const res = await client.evaluate(
    tabId,
    `(async () => {
      const m = window.rootScope?.managers || {};
      if (!m.apiManager) return { error: "No API manager" };

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
            detail: 'Kullanıcı bulunamadı'
          };
        }

        const u = resolved.users[0];
        const inputPeer = {
          _: 'inputPeerUser',
          user_id: u.id,
          access_hash: u.access_hash
        };

        const randomId = String(Math.floor(Math.random() * 1e14));
        const sendRes = await m.apiManager.invokeApi('messages.sendMessage', {
          peer: inputPeer,
          message: item.message,
          random_id: randomId
        });

        return {
          username: uname,
          id: String(u.id),
          name: [u.first_name, u.last_name].filter(Boolean).join(' ') || item.name,
          status: 'SENT_SUCCESSFULLY',
          detail: 'Davet mesajı gönderildi'
        };
      } catch(err) {
        const errMsg = (err && (err.message || err.text || err.type || err.error)) || String(err);
        let status = 'ERROR';
        let detail = errMsg;
        let floodWaitSeconds = 0;

        if (/PEER_FLOOD/i.test(errMsg)) {
          status = 'PEER_FLOOD';
          detail = 'Telegram PEER_FLOOD mesaj koruması';
        } else if (/USER_PRIVACY_RESTRICTED|YOU_CANNOT_WRITE_TO_THIS_USER/i.test(errMsg)) {
          status = 'PRIVACY_RESTRICTED';
          detail = 'Kullanıcı mesaj alımını kısıtlamış';
        } else if (/FLOOD_WAIT/i.test(errMsg)) {
          const match = errMsg.match(/FLOOD_WAIT[ _:]*(\d+)/i);
          floodWaitSeconds = match ? parseInt(match[1], 10) : 120;
          status = 'FLOOD_WAIT';
          detail = 'Hız sınırı: ' + floodWaitSeconds + ' saniye beklenmeli';
        }

        return {
          username: uname,
          id: item.id || '',
          name: item.name || uname,
          status,
          detail,
          floodWaitSeconds
        };
      }
    })()`
  );

  const data = res?.result || res?.value || res;
  if (!data || data.error) {
    throw new Error(data?.error || "DM execution error");
  }
  return data;
}

async function main() {
  const channelLink = process.env.CHANNEL_LINK || process.argv[2] || "https://t.me/firsattakipkanali";
  const csvFile = process.env.CSV_INPUT || process.argv[3] || "participants.csv";
  const camofoxUrl = process.env.CAMOFOX_URL || "http://127.0.0.1:9377";
  const userId = process.env.CAMOFOX_USER_ID || "tg-scraper-user";
  const minDelayMs = parseInt(process.env.DM_DELAY_MIN || "12000", 10);
  const maxDelayMs = parseInt(process.env.DM_DELAY_MAX || "22000", 10);
  const maxDMs = parseInt(process.env.MAX_DMS || "50", 10);

  console.log("=== Telegram Davet Mesajı Gönderici (DM Invite Sender) ===");
  console.log(`Davet Bağlantısı: ${channelLink}`);
  console.log(`Kaynak CSV: ${path.resolve(csvFile)}`);
  console.log(`Mesajlar Arası Güvenli Bekleme: ${minDelayMs / 1000}s - ${maxDelayMs / 1000}s`);
  console.log(`Oturum Başı Maksimum Mesaj: ${maxDMs}`);
  console.log(`Camofox URL: ${camofoxUrl}`);
  console.log(`Session User ID: ${userId}\n`);

  // 1. Load candidates from CSV
  const candidates = loadUsernamesFromCSV(csvFile);
  console.log(`✓ CSV dosyasından ${candidates.length} tekil kullanıcı adı yüklendi.`);

  // 2. Load previous DM results to permanently skip already messaged users
  const dmResultCsv = "dm-result.csv";
  const existingMap = loadExistingDMResults(dmResultCsv);
  if (existingMap.size > 0) {
    console.log(`ℹ Önceki çalıştırmadan ${existingMap.size} kayıt bulundu. Atlanacak.`);
  }

  const pending = candidates.filter((c) => !existingMap.has(c.username.toLowerCase()));
  console.log(`✓ İşleme alınacak yeni aday sayısı: ${pending.length} / ${candidates.length}\n`);

  if (pending.length === 0) {
    console.log("Tüm kullanıcılara daha önce mesaj gönderilmiş.");
    process.exit(0);
  }

  const client = new CamofoxClient({ baseUrl: camofoxUrl, userId });
  const isHealthy = await client.checkHealth();
  if (!isHealthy) {
    console.error(`Error: Cannot connect to Camofox server at ${camofoxUrl}`);
    process.exit(1);
  }

  let tabId = null;
  const resultMap = new Map(existingMap);

  try {
    tabId = await client.createTab({ sessionKey: "tg-dm-session", url: "https://web.telegram.org/k/" });
    await ensureAuthenticated(client, tabId);

    console.log("--- Güvenli Davet Mesajı Gönderimi Başlatıldı ---\n");
    let sentCount = 0;
    let restrictedCount = 0;
    let floodCount = 0;
    let errorCount = 0;

    for (let i = 0; i < pending.length; i++) {
      if (sentCount >= maxDMs) {
        console.log(`\n✓ Belirlenen oturum mesaj sınırına (${maxDMs}) ulaşıldı.`);
        break;
      }

      const item = pending[i];
      let r = null;
      try {
        r = await sendInviteDM(client, tabId, item, channelLink);
      } catch (err) {
        r = {
          username: item.username,
          id: item.id || '',
          name: item.name || item.username,
          status: 'ERROR',
          detail: err.message || String(err),
        };
      }

      resultMap.set(item.username.toLowerCase(), r);

      const symbol =
        r.status === "SENT_SUCCESSFULLY"
          ? "✓ [GÖNDERİLDİ]"
          : r.status === "PRIVACY_RESTRICTED"
          ? "⚠️ [GİZLİLİK]"
          : r.status === "PEER_FLOOD"
          ? "⏳ [FLOOD]"
          : "✖ [HATA]";

      console.log(`[${i + 1}/${pending.length}] ${symbol} @${r.username} (${r.name}): ${r.detail}`);

      if (r.status === "SENT_SUCCESSFULLY") sentCount++;
      else if (r.status === "PRIVACY_RESTRICTED") restrictedCount++;
      else if (r.status === "PEER_FLOOD") floodCount++;
      else errorCount++;

      // Save progressive CSV after each DM
      try {
        const fields = ["username", "id", "name", "status", "detail"];
        const csvData = parse(Array.from(resultMap.values()), { fields });
        fs.writeFileSync(dmResultCsv, csvData, "utf-8");
      } catch {}

      // Handle flood wait
      if (r.status === "FLOOD_WAIT" && r.floodWaitSeconds > 60) {
        console.log(`\n⏳ Telegram hız sınırı (${r.floodWaitSeconds}s). Güvenlik için durduruldu.`);
        break;
      }

      if (r.status === "PEER_FLOOD") {
        console.log("⏳ PEER_FLOOD algılandı, 45 saniye güvenlik molası...");
        await sleep(45000);
      } else {
        const delay = Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1)) + minDelayMs;
        await sleep(delay);
      }

      // 30s breather every 5 DMs
      if ((i + 1) % 5 === 0 && i + 1 < pending.length) {
        console.log("☕ 5 mesaj gönderildi, 30 saniyelik güvenlik molası veriliyor...");
        await sleep(30000);
      }
    }

    console.log("\n========================================");
    console.log("İşlem Özeti:");
    console.log(`Bu Oturumda Gönderilen: ${sentCount}`);
    console.log(`Gizlilik Korumalı: ${restrictedCount}`);
    console.log(`Hız Koruması (Flood): ${floodCount}`);
    console.log(`Diğer / Hata: ${errorCount}`);
    console.log(`Toplam Kayıtlı Sonuç: ${resultMap.size}`);
    console.log("========================================\n");
    console.log(`✓ Rapor kaydedildi: ${path.resolve(dmResultCsv)}`);
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
  getPersonalizedMessage,
  loadExistingDMResults,
  sendInviteDM,
};
