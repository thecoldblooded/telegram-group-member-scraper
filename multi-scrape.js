const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { parse } = require("json2csv");
const { CamofoxClient, normalizeTarget, ensureAuthenticated } = require("./script.js");

dotenv.config();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Loads existing participants from CSV if it already exists to append/update without losing prior scrapes.
 */
function loadExistingParticipants(csvPath) {
  const map = new Map();
  if (!fs.existsSync(csvPath)) return map;

  try {
    const content = fs.readFileSync(csvPath, "utf-8");
    const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length <= 1) return map;

    const header = lines[0].split(",").map((h) => h.replace(/^["']|["']$/g, "").trim());
    const idIdx = header.indexOf("id");
    const usernameIdx = header.indexOf("username");
    const firstIdx = header.indexOf("first_name");
    const lastIdx = header.indexOf("last_name");
    const nameIdx = header.indexOf("name");
    const phoneIdx = header.indexOf("phone");
    const botIdx = header.indexOf("is_bot");
    const statusIdx = header.indexOf("status");
    const msgCountIdx = header.indexOf("message_count");
    const lastActiveIdx = header.indexOf("last_active_at");
    const targetIdx = header.indexOf("target");
    const scrapedAtIdx = header.indexOf("scraped_at");

    for (let i = 1; i < lines.length; i++) {
      const rowMatches = lines[i].match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || lines[i].split(",");
      const cleanRow = rowMatches.map((c) => c.replace(/^["']|["']$/g, "").trim());
      const id = cleanRow[idIdx] || "";
      if (id) {
        map.set(id, {
          id,
          username: cleanRow[usernameIdx] || "",
          first_name: cleanRow[firstIdx] || "",
          last_name: cleanRow[lastIdx] || "",
          name: cleanRow[nameIdx] || "",
          phone: cleanRow[phoneIdx] || "",
          is_bot: (cleanRow[botIdx] || "").toLowerCase() === "true",
          status: cleanRow[statusIdx] || "",
          message_count: parseInt(cleanRow[msgCountIdx] || "0", 10),
          last_active_at: cleanRow[lastActiveIdx] || "",
          target: cleanRow[targetIdx] || "",
          scraped_at: cleanRow[scrapedAtIdx] || new Date().toISOString(),
        });
      }
    }
  } catch {}

  return map;
}

/**
 * Initializes target chat inside Telegram Web K session.
 */
async function initTargetChat(client, tabId, handle) {
  const cleanHandle = handle.replace(/^[@/]+/, "");

  const initScript = `(async () => {
    const m = window.rootScope?.managers || {};
    if (!m.apiManager) {
      return { error: "Telegram API manager is not ready." };
    }

    try {
      const resolved = await m.apiManager.invokeApi('contacts.resolveUsername', { username: ${JSON.stringify(cleanHandle)} });
      if (!resolved || !resolved.chats || resolved.chats.length === 0) {
        return { error: 'Username @' + ${JSON.stringify(cleanHandle)} + ' not found or is not a group/channel.' };
      }
      const chat = resolved.chats[0];
      const inputPeer = {
        _: 'inputPeerChannel',
        channel_id: chat.id,
        access_hash: chat.access_hash
      };
      const inputChannel = {
        _: 'inputChannel',
        channel_id: chat.id,
        access_hash: chat.access_hash
      };

      window._scrapeState = {
        inputPeer,
        inputChannel,
        chatTitle: chat.title || cleanHandle,
        chatId: chat.id,
        offsetId: 0,
        userMap: new Map(),
        totalMessages: 0,
      };

      return {
        ok: true,
        chatTitle: chat.title || cleanHandle,
        chatId: chat.id,
      };
    } catch (err) {
      return { error: err.message || String(err) };
    }
  })()`;

  const res = await client.evaluate(tabId, initScript);
  const result = res?.result || res?.value || res;
  if (!result || result.error) {
    throw new Error(result?.error || "Failed to initialize target chat in Telegram Web.");
  }
  return result;
}

/**
 * Scrapes a single target until per-group limit or global user goal is met.
 */
async function scrapeGroupMessages(
  client,
  tabId,
  targetHandle,
  globalUserMap,
  overallUserGoal = 10000,
  maxGroupMessages = 150000,
  saveCallback = null
) {
  console.log(`\n========================================================`);
  console.log(`Hedef Grup Başlatılıyor: @${targetHandle}`);
  const chatInfo = await initTargetChat(client, tabId, targetHandle);
  console.log(`✓ Grup Başlığı: "${chatInfo.chatTitle}" (ID: ${chatInfo.chatId})`);
  console.log(`Maksimum incelenecek mesaj limiti: ${maxGroupMessages}`);
  console.log(`========================================================\n`);

  let groupMessages = 0;
  let idleCount = 0;
  let prevGlobalCount = globalUserMap.size;
  const startGlobalCount = globalUserMap.size;

  while (groupMessages < maxGroupMessages && globalUserMap.size < overallUserGoal) {
    const batchScript = `(async () => {
      const m = window.rootScope?.managers || {};
      const state = window._scrapeState;
      if (!state || !state.inputPeer) {
        return { error: "Scrape state is not initialized." };
      }

      let batchProcessed = 0;
      let reachedEnd = false;
      const batchUsers = [];

      // Process 3 pages (300 messages) per evaluate
      for (let p = 0; p < 3; p++) {
        let history = null;
        try {
          history = await m.apiManager.invokeApi('messages.getHistory', {
            peer: state.inputPeer,
            offset_id: state.offsetId,
            offset_date: 0,
            add_offset: 0,
            limit: 100,
            max_id: 0,
            min_id: 0,
            hash: '0'
          });
        } catch (err) {
          break;
        }

        if (!history || !history.messages || history.messages.length === 0) {
          if (state.offsetId > 25000) {
            state.offsetId -= 25000;
            continue;
          } else if (state.offsetId > 1500) {
            state.offsetId -= 1500;
            continue;
          } else if (state.offsetId > 100) {
            state.offsetId -= 100;
            continue;
          } else {
            reachedEnd = true;
            break;
          }
        }

        batchProcessed += history.messages.length;
        state.totalMessages += history.messages.length;

        if (history.users) {
          for (const u of history.users) {
            const uid = String(u.id);
            const firstName = u.first_name || '';
            const lastName = u.last_name || '';
            const fullName = [firstName, lastName].filter(Boolean).join(' ');
            batchUsers.push({
              id: uid,
              username: u.username ? ('@' + u.username) : '',
              first_name: firstName,
              last_name: lastName,
              name: fullName || (u.username ? ('@' + u.username) : uid),
              phone: u.phone || '',
              is_bot: !!(u.pFlags && u.pFlags.bot),
              status: (u.status && u.status._) ? u.status._.replace(/^userStatus/, '') : '',
            });
          }
        }

        const lastMsg = history.messages[history.messages.length - 1];
        if (!lastMsg || lastMsg.id <= 1 || lastMsg.id === state.offsetId) {
          reachedEnd = true;
          break;
        }
        state.offsetId = lastMsg.id;
      }

      return {
        batchProcessed,
        totalMessages: state.totalMessages,
        batchUsers,
        offsetId: state.offsetId,
        reachedEnd,
      };
    })()`;

    let res = null;
    try {
      res = await client.evaluate(tabId, batchScript);
    } catch (e) {
      await sleep(150);
      continue;
    }

    const data = res?.result || res?.value || res;
    if (!data || data.error) {
      await sleep(100);
      continue;
    }

    groupMessages = data.totalMessages || groupMessages;
    const incomingUsers = data.batchUsers || [];

    for (const u of incomingUsers) {
      if (!globalUserMap.has(u.id)) {
        globalUserMap.set(u.id, {
          ...u,
          message_count: 1,
          last_active_at: new Date().toISOString(),
          target: `@${targetHandle}`,
          scraped_at: new Date().toISOString(),
        });
      } else {
        const existing = globalUserMap.get(u.id);
        existing.message_count = (existing.message_count || 0) + 1;
        if (!existing.target.includes(targetHandle)) {
          existing.target += `, @${targetHandle}`;
        }
      }
    }
    const currentGlobal = globalUserMap.size;
    const addedInGroup = currentGlobal - startGlobalCount;
    process.stdout.write(
      `\r[@${targetHandle}] ${groupMessages} mesaj tarandı | Bu gruptan: +${addedInGroup} üye | Toplam Tekil Üye: ${currentGlobal}/${overallUserGoal}...`
    );

    if (currentGlobal >= overallUserGoal) {
      console.log(`\n✓ Genel hedef olan ${overallUserGoal} tekil kullanıcı sayısına ulaşıldı!`);
      break;
    }

    if (data.batchProcessed === 0) {
      idleCount++;
      if (idleCount >= 3 || data.reachedEnd) {
        console.log(`\nBu grupta taranacak mesaj kalmadı.`);
        break;
      }
    } else if (currentGlobal > prevGlobalCount) {
      idleCount = 0;
      prevGlobalCount = currentGlobal;
    } else {
      idleCount++;
      if (idleCount >= 20 && data.reachedEnd) {
        console.log(`\nSohbet geçmişinin sonuna ulaşıldı.`);
        break;
      }
    }

    if (data.reachedEnd) {
      console.log(`\nBu grubun tüm mesajları tarandı.`);
      break;
    }

    // Save CSV periodically every ~1500 messages
    if (groupMessages % 1500 < 300 && saveCallback) {
      saveCallback();
    }

    await sleep(25);
  }

  process.stdout.write("\n");
  const finalAdded = globalUserMap.size - startGlobalCount;
  console.log(`✓ @${targetHandle} tamamlandı: ${groupMessages} mesaj tarandı, +${finalAdded} yeni tekil üye bulundu.\n`);
}
async function main() {
  const defaultTargets = [
    "https://web.telegram.org/k/#@arayises",
    "https://web.telegram.org/k/#@benimhocamkpss",
    "https://web.telegram.org/k/#@kodu_group",
    "https://web.telegram.org/k/#@kriptoemrechat",
    "https://web.telegram.org/k/#@teknofestchat"
  ];
  const targetsEnv = process.env.TARGETS || process.argv.slice(2).join(",");
  const rawTargetList = targetsEnv ? targetsEnv.split(",").map((t) => t.trim()).filter(Boolean) : defaultTargets;

  const targetHandles = rawTargetList.map((t) => normalizeTarget(t).handle);

  const overallUserGoal = parseInt(process.env.USER_GOAL || process.env.USER_LIMIT || "10000", 10);
  const maxMessagesPerGroup = parseInt(process.env.MAX_MESSAGES_PER_GROUP || "250000", 10);
  const camofoxUrl = process.env.CAMOFOX_URL || "http://127.0.0.1:9377";
  const userId = process.env.CAMOFOX_USER_ID || "tg-scraper-user";
  const csvOutput = process.env.CSV_OUTPUT || "participants.csv";

  console.log("=== Telegram Çoklu Grup Üye Kazıma (Multi-Group Scraper) ===");
  console.log(`Hedef Gruplar: ${targetHandles.map((h) => "@" + h).join(", ")}`);
  console.log(`Toplam Hedeflenen Tekil Üye Sayısı: ${overallUserGoal}`);
  console.log(`Grup Başı Maksimum Mesaj: ${maxMessagesPerGroup}`);
  console.log(`Camofox URL: ${camofoxUrl}`);
  console.log(`Session User ID: ${userId}`);
  console.log(`Çıktı Dosyası: ${path.resolve(csvOutput)}\n`);

  // Load existing participants to build upon previous runs
  const globalUserMap = loadExistingParticipants(csvOutput);
  console.log(`ℹ Mevcut CSV'den ${globalUserMap.size} kayıt yüklendi.`);

  const saveCSV = () => {
    try {
      const fields = [
        "id",
        "username",
        "first_name",
        "last_name",
        "name",
        "phone",
        "is_bot",
        "status",
        "message_count",
        "last_active_at",
        "target",
        "scraped_at",
      ];
      const csvData = parse(Array.from(globalUserMap.values()), { fields });
      fs.writeFileSync(csvOutput, csvData, "utf-8");
    } catch {}
  };

  const client = new CamofoxClient({ baseUrl: camofoxUrl, userId });
  const isHealthy = await client.checkHealth();
  if (!isHealthy) {
    console.error(`Error: Cannot connect to Camofox server at ${camofoxUrl}`);
    process.exit(1);
  }

  let tabId = null;
  try {
    tabId = await client.createTab({ sessionKey: "tg-multi-scrape-session", url: "https://web.telegram.org/k/" });
    await ensureAuthenticated(client, tabId);

    for (const handle of targetHandles) {
      if (globalUserMap.size >= overallUserGoal) {
        console.log(`✓ 10,000 tekil kullanıcı hedefine ulaşıldı!`);
        break;
      }

      try {
        await scrapeGroupMessages(
          client,
          tabId,
          handle,
          globalUserMap,
          overallUserGoal,
          maxMessagesPerGroup,
          saveCSV
        );
      } catch (err) {
        console.error(`Hata oluştu (@${handle}):`, err.message);
      }

      saveCSV();
    }

    console.log("\n========================================================");
    console.log(`✓ TARAMA TAMAMLANDI!`);
    console.log(`Toplam Bulunan Tekil Üye Sayısı: ${globalUserMap.size}`);
    const validWithUname = Array.from(globalUserMap.values()).filter((u) => u.username && !u.is_bot);
    console.log(`Kullanıcı Adı Olan (@username) Üye Sayısı: ${validWithUname.length}`);
    console.log(`Veriler kaydedildi: ${path.resolve(csvOutput)}`);
    console.log("========================================================\n");

    saveCSV();
  } catch (err) {
    console.error("Scraper Error:", err.message);
    process.exit(1);
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
  loadExistingParticipants,
  initTargetChat,
  scrapeGroupMessages,
};
