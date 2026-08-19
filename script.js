const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { parse } = require("json2csv");

dotenv.config();

/**
 * Normalizes user-supplied target string into a target identifier/handle and Telegram Web K URL.
 * Supports:
 * - https://t.me/groupname or t.me/groupname
 * - @groupname or groupname
 * - Numeric IDs: -3205023502, -1001234567890, or 3205023502
 * - Direct Telegram Web K URLs:
 *   - https://web.telegram.org/k/#@groupname
 *   - https://web.telegram.org/k/#-3205023502
 *   - https://web.telegram.org/k/#-1001234567890
 *   - https://web.telegram.org/k/#/im?p=@groupname
 */
function normalizeTarget(target) {
  if (!target || typeof target !== "string") {
    throw new Error("TARGET is required and must be a non-empty string.");
  }

  const trimmed = target.trim();
  if (!trimmed) {
    throw new Error("TARGET cannot be empty.");
  }

  let handle = trimmed;
  let webUrl = "";

  // Check direct web.telegram.org URL forms
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed);
      if (url.hostname === "t.me" || url.hostname === "telegram.me") {
        handle = url.pathname.replace(/^\/+/, "").split("/")[0];
      } else if (url.hostname === "web.telegram.org") {
        const hash = url.hash.replace(/^#/, "");
        if (hash) {
          // Matches #@groupname, #-3205023502, #3205023502, #/im?p=@groupname, #/im?p=-3205023502
          const peerMatch = hash.match(/(?:@|p=@?|#?)(-?\d+|[a-zA-Z0-9_]{3,64})/);
          if (peerMatch) {
            handle = peerMatch[1];
            if (/^-?\d+$/.test(handle)) {
              webUrl = `https://web.telegram.org/k/#${handle}`;
            } else {
              webUrl = `https://web.telegram.org/k/#@${handle}`;
            }
          } else if (hash.startsWith("-") || /^\d+$/.test(hash)) {
            handle = hash;
            webUrl = `https://web.telegram.org/k/#${handle}`;
          }
        }
      }
    } catch {
      // Fallback
    }
  } else if (trimmed.startsWith("t.me/") || trimmed.startsWith("telegram.me/")) {
    handle = trimmed.split("/")[1] || "";
  }

  if (!webUrl) {
    // Numeric peer ID (e.g. -3205023502, -1001234567890, 123456789)
    if (/^-?\d+$/.test(handle)) {
      webUrl = `https://web.telegram.org/k/#${handle}`;
    } else {
      // Handle username / invite slug
      handle = handle.replace(/^[@/]+/, "").trim();
      const handleRegex = /^[a-zA-Z0-9_]{3,64}$/;
      if (!handleRegex.test(handle)) {
        throw new Error(
          `Invalid Telegram target handle: "${target}". Expected a valid username, group link, or numeric peer ID (e.g. https://t.me/example, @example, https://web.telegram.org/k/#-3205023502).`
        );
      }
      webUrl = `https://web.telegram.org/k/#@${handle}`;
    }
  }

  return {
    handle,
    webUrl,
  };
}

/**
 * Lightweight native fetch-based client for Camofox browser server.
 */
class CamofoxClient {
  constructor({ baseUrl = "http://127.0.0.1:9377", apiKey = "", userId = "tg-scraper-user" } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.userId = userId;
  }

  _getHeaders(extra = {}) {
    const headers = {
      "Content-Type": "application/json",
      ...extra,
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async request(path, options = {}) {
    const url = `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    const opts = {
      ...options,
      headers: this._getHeaders(options.headers),
    };

    let response;
    try {
      response = await fetch(url, opts);
    } catch (err) {
      throw new Error(
        `Failed to connect to Camofox browser server at ${this.baseUrl}: ${err.message}. Ensure Camofox is running (e.g., npx @askjo/camofox-browser).`
      );
    }

    const contentType = response.headers.get("content-type") || "";
    let data;
    if (contentType.includes("application/json")) {
      data = await response.json().catch(() => null);
    } else {
      data = await response.text().catch(() => null);
    }

    if (!response.ok) {
      const errMsg = (data && (data.error || data.message)) || response.statusText;
      throw new Error(`Camofox request failed [${response.status} ${response.statusText}]: ${errMsg}`);
    }

    return data;
  }

  async checkHealth() {
    try {
      const res = await this.request("/health");
      return res && (res.ok || res.status === "ok");
    } catch {
      return false;
    }
  }
  async listTabs() {
    try {
      const data = await this.request(`/tabs?userId=${encodeURIComponent(this.userId)}`);
      return (data && (data.tabs || data.result)) || [];
    } catch {
      return [];
    }
  }

  async createTab({ sessionKey = "tg-scraper", url } = {}) {
    try {
      const body = {
        userId: this.userId,
        sessionKey,
      };
      if (url) body.url = url;

      const data = await this.request("/tabs", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return data.tabId || data.id;
    } catch (err) {
      if (err.message && err.message.includes("Maximum tabs per session reached")) {
        const existingTabs = await this.listTabs();
        if (existingTabs.length > 0) {
          const primaryTab = existingTabs[0];
          const primaryId = primaryTab.tabId || primaryTab.targetId || primaryTab.id;
          // Close extra tabs
          for (let i = 1; i < existingTabs.length; i++) {
            const extraId = existingTabs[i].tabId || existingTabs[i].targetId || existingTabs[i].id;
            if (extraId) await this.closeTab(extraId).catch(() => {});
          }
          if (url && primaryId) {
            await this.navigate(primaryId, url).catch(() => {});
          }
          return primaryId;
        }
      }
      throw err;
    }
  }
  async getSnapshot(tabId) {
    const path = `/tabs/${encodeURIComponent(tabId)}/snapshot?userId=${encodeURIComponent(this.userId)}`;
    return await this.request(path);
  }

  async click(tabId, { ref, selector } = {}) {
    return await this.request(`/tabs/${encodeURIComponent(tabId)}/click`, {
      method: "POST",
      body: JSON.stringify({
        userId: this.userId,
        ref,
        selector,
      }),
    });
  }

  async type(tabId, { ref, selector, text, pressEnter } = {}) {
    return await this.request(`/tabs/${encodeURIComponent(tabId)}/type`, {
      method: "POST",
      body: JSON.stringify({
        userId: this.userId,
        ref,
        selector,
        text,
        pressEnter: !!pressEnter,
      }),
    });
  }

  async scroll(tabId, { direction = "down", distance = 600 } = {}) {
    return await this.request(`/tabs/${encodeURIComponent(tabId)}/scroll`, {
      method: "POST",
      body: JSON.stringify({
        userId: this.userId,
        direction,
        distance,
      }),
    });
  }

  async navigate(tabId, url) {
    return await this.request(`/tabs/${encodeURIComponent(tabId)}/navigate`, {
      method: "POST",
      body: JSON.stringify({
        userId: this.userId,
        url,
      }),
    });
  }

  async evaluate(tabId, expression) {
    return await this.request(`/tabs/${encodeURIComponent(tabId)}/evaluate`, {
      method: "POST",
      body: JSON.stringify({
        userId: this.userId,
        expression,
      }),
    });
  }

  async getScreenshot(tabId) {
    const url = `${this.baseUrl}/tabs/${encodeURIComponent(tabId)}/screenshot?userId=${encodeURIComponent(this.userId)}`;
    const res = await fetch(url, { headers: this._getHeaders() });
    if (!res.ok) throw new Error(`Screenshot failed: ${res.statusText}`);
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  async toggleDisplay(headless = "virtual") {
    try {
      return await this.request(`/sessions/${encodeURIComponent(this.userId)}/toggle-display`, {
        method: "POST",
        body: JSON.stringify({
          headless,
        }),
      });
    } catch (e) {
      return null;
    }
  }

  async closeTab(tabId) {
    try {
      await this.request(`/tabs/${encodeURIComponent(tabId)}`, {
        method: "DELETE",
        body: JSON.stringify({
          userId: this.userId,
        }),
      });
    } catch {
      // Ignore tab cleanup errors
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Handles Telegram Web K authentication check and interactive login prompt if needed.
 */
async function ensureAuthenticated(client, tabId) {
  console.log("Checking Telegram Web authentication status...");
  // Retry navigate if abort occurs
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await client.navigate(tabId, "https://web.telegram.org/k/");
      break;
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(1500);
    }
  }

  const maxAuthWait = 300000; // 5 minutes
  const startTime = Date.now();
  let vncActivated = false;

  while (Date.now() - startTime < maxAuthWait) {
    let authState = null;
    try {
      const evalRes = await client.evaluate(
        tabId,
        `(() => {
          const isChatList = !!document.querySelector('.chatlist-parts, .chatlist, .chatlist-chat, .folders-tabs, .sidebar-header, .chat-info, .topbar-main');
          const hasLoginText = document.body ? /Log in by QR Code|Log in by phone number|Enter Your Password/i.test(document.body.innerText) : false;
          const isLogin = !isChatList && (hasLoginText || !!document.querySelector('.login-header, .auth-form'));
          const pageTitle = document.title || '';
          return { isChatList, isLogin, pageTitle };
        })()`
      );
      authState = evalRes?.result || evalRes?.value || evalRes;
    } catch {
      // Snapshot or DOM might be loading
    }

    if (authState && authState.isLogin) {
      if (!vncActivated) {
        vncActivated = true;
        console.log("\n========================================================");
        console.log("⚠️  Telegram Web login required (QR Code)");
        try {
          const buffer = await client.getScreenshot(tabId);
          const qrPath = path.resolve("telegram-login-qr.png");
          fs.writeFileSync(qrPath, buffer);
          console.log(`✓ Login QR code saved to: ${qrPath}`);
        } catch (err) {
          console.log(`Failed to save QR code screenshot: ${err.message}`);
        }
        console.log("Please scan the QR code using your Telegram mobile app:");
        console.log("  Settings -> Devices -> Link Desktop Device");
        console.log("Waiting for authentication (polling every 3s)...");
        console.log("========================================================\n");
      }
    } else if (authState && authState.isChatList) {
      console.log("✓ Telegram Web is authenticated.");
      return true;
    }

    await sleep(3000);
  }

  throw new Error("Authentication timed out after 5 minutes. Please run again to complete login.");
}

/**
 * Initializes target chat inside Telegram Web K session.
 * Resolves chat info and initializes `window._scrapeState` for message and participant extraction.
 */
async function initTargetChat(client, tabId, handle) {
  const isNumeric = /^-?\d+$/.test(handle);
  const cleanHandle = handle.replace(/^[@/]+/, "");

  const initScript = `(async () => {
    const m = window.rootScope?.managers || {};
    if (!m.apiManager) {
      return { error: "Telegram API manager is not ready." };
    }

    let inputPeer = null;
    let inputChannel = null;
    let chatTitle = "";
    let chatId = null;
    const isNumeric = ${JSON.stringify(isNumeric)};
    const handle = ${JSON.stringify(cleanHandle)};

    try {
      if (isNumeric) {
        const cleanNumStr = handle.replace(/^-100/, "").replace(/^-/, "");
        const numericId = parseInt(cleanNumStr, 10);
        let chat = null;
        if (m.appChatsManager && m.appChatsManager.getChat) {
          chat = await m.appChatsManager.getChat(numericId).catch(() => null);
        }
        if (!chat && m.appPeersManager && m.appPeersManager.getPeerById) {
          const peer = await m.appPeersManager.getPeerById(numericId).catch(() => null);
          chat = peer;
        }

        if (chat) {
          chatTitle = chat.title || String(chat.id);
          chatId = chat.id;
          inputPeer = {
            _: 'inputPeerChannel',
            channel_id: chat.id,
            access_hash: chat.access_hash || '0'
          };
          inputChannel = {
            _: 'inputChannel',
            channel_id: chat.id,
            access_hash: chat.access_hash || '0'
          };
        } else {
          return { error: 'Could not resolve numeric chat ID: ' + handle };
        }
      } else {
        const resolved = await m.apiManager.invokeApi('contacts.resolveUsername', { username: handle });
        if (!resolved || !resolved.chats || resolved.chats.length === 0) {
          return { error: 'Username @' + handle + ' not found or is not a group/channel.' };
        }
        const chat = resolved.chats[0];
        chatTitle = chat.title;
        chatId = chat.id;
        inputPeer = {
          _: 'inputPeerChannel',
          channel_id: chat.id,
          access_hash: chat.access_hash
        };
        inputChannel = {
          _: 'inputChannel',
          channel_id: chat.id,
          access_hash: chat.access_hash
        };
      }

      window._scrapeState = {
        inputPeer,
        inputChannel,
        chatTitle,
        chatId,
        offsetId: 0,
        userMap: new Map(),
        totalMessages: 0,
      };

      return {
        ok: true,
        chatTitle,
        chatId,
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
 * Scrapes member information from conversation messages (yazışmalardan üye bilgileri).
 * Paginates through chat history and extracts unique senders with full profile details.
 */
async function scrapeMembersFromMessages(client, tabId, target, messageLimit = 50000, idleLimit = 8, userLimit = 1000) {
  console.log(`\n--- Yazışmalardan Üye Bilgilerini Scrape Etme ---`);
  console.log(`Hedef: ${target}`);
  console.log(`Maksimum incelenecek mesaj limiti: ${messageLimit}`);
  console.log(`Hedeflenen tekil kullanıcı sayısı: ${userLimit}`);

  const userMap = new Map();
  let totalProcessed = 0;
  let idleCount = 0;
  let prevUserCount = 0;
  let batchIndex = 0;

  while (totalProcessed < messageLimit && userMap.size < userLimit) {
    batchIndex++;
    const batchScript = `(async () => {
      const m = window.rootScope?.managers || {};
      const state = window._scrapeState;
      if (!state || !state.inputPeer) {
        return { error: "Scrape state is not initialized." };
      }

      let batchProcessed = 0;
      let reachedEnd = false;
      // Process 2 pages of 100 messages per evaluate call (~200 messages for zero timeout risk)
      for (let p = 0; p < 2; p++) {
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
          if (state.offsetId > 5000) {
            state.offsetId -= 5000;
            continue;
          } else if (state.offsetId > 500) {
            state.offsetId -= 500;
            continue;
          } else {
            reachedEnd = true;
            break;
          }
        }

        batchProcessed += history.messages.length;
        state.totalMessages += history.messages.length;

        // Register users in state
        if (history.users) {
          for (const u of history.users) {
            const uid = String(u.id);
            if (!state.userMap.has(uid)) {
              const firstName = u.first_name || '';
              const lastName = u.last_name || '';
              const fullName = [firstName, lastName].filter(Boolean).join(' ');
              const userObj = {
                id: uid,
                username: u.username ? ('@' + u.username) : '',
                first_name: firstName,
                last_name: lastName,
                name: fullName || (u.username ? ('@' + u.username) : uid),
                phone: u.phone || '',
                is_bot: !!(u.pFlags && u.pFlags.bot),
                status: (u.status && u.status._) ? u.status._.replace(/^userStatus/, '') : '',
                message_count: 0,
                last_active_at: '',
              };
              state.userMap.set(uid, userObj);
            }
          }
        }

        // Count messages per user
        for (const msg of history.messages) {
          const fromId = msg.from_id?.user_id || msg.from_id?.channel_id || msg.peer_id?.user_id;
          if (fromId) {
            const u = state.userMap.get(String(fromId));
            if (u) {
              u.message_count = (u.message_count || 0) + 1;
              if (!u.last_active_at && msg.date) {
                u.last_active_at = new Date(msg.date * 1000).toISOString();
              }
            }
          }
        }

        const lastMsg = history.messages && history.messages.length > 0 ? history.messages[history.messages.length - 1] : null;
        if (lastMsg && lastMsg.id > 1) {
          state.offsetId = lastMsg.id;
        } else if (state.offsetId <= 100) {
          reachedEnd = true;
          break;
        }
      }

      return {
        batchProcessed,
        totalMessages: state.totalMessages,
        uniqueUsers: state.userMap.size,
        reachedEnd,
        offsetId: state.offsetId,
      };
    })()`;

    let res = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        res = await client.evaluate(tabId, batchScript);
        break;
      } catch (e) {
        if (attempt === 3) {
          console.warn(`\nEvaluate timeout/hata: ${e.message}. Devam ediliyor...`);
        }
        await sleep(500);
      }
    }
    const data = res?.result || res?.value || res;
    if (!data || data.error) {
      await sleep(100);
      continue;
    }

    totalProcessed = data.totalMessages || totalProcessed;
    const currentCount = data.uniqueUsers || userMap.size;
    process.stdout.write(`\rYazışmalar taranıyor: ${totalProcessed} mesaj incelendi, ${currentCount} tekil üye bulundu...`);

    if (currentCount >= userLimit) {
      console.log(`\n✓ Hedeflenen ${userLimit} tekil kullanıcı sayısına ulaşıldı!`);
      break;
    }

    if (currentCount > prevUserCount) {
      idleCount = 0;
      prevUserCount = currentCount;
    } else {
      idleCount++;
      if (idleCount >= 30 && data.reachedEnd) {
        console.log(`\nSohbet geçmişinin sonuna ulaşıldı.`);
        break;
      }
    }

    if (data.reachedEnd) {
      console.log(`\nTüm sohbet mesajları tarandı.`);
      break;
    }

    await sleep(20);
  }

  // Fetch all collected users in one final evaluate call
  const finalRes = await client.evaluate(
    tabId,
    `(() => {
      const state = window._scrapeState;
      if (!state || !state.userMap) return { users: [] };
      return { users: Array.from(state.userMap.values()) };
    })()`
  );
  const finalData = finalRes?.result || finalRes?.value || finalRes;
  const finalUsers = (finalData && finalData.users) || [];
  for (const u of finalUsers) {
    userMap.set(u.id, {
      ...u,
      target,
      scraped_at: new Date().toISOString(),
    });
  }
  process.stdout.write("\n");
  return Array.from(userMap.values());
}

/**
 * Scrapes participants from participant list endpoint or fallback.
 */
async function scrapeParticipantsFromMemberList(client, tabId, target, maxIterations = 100, idleLimit = 5) {
  console.log(`\n--- Üye Listesini Scrape Etme ---`);

  const listScript = `(async () => {
    const m = window.rootScope?.managers || {};
    const state = window._scrapeState;
    if (!state || !state.inputChannel) {
      return { error: "Chat state not initialized." };
    }

    try {
      const participants = await m.apiManager.invokeApi('channels.getParticipants', {
        channel: state.inputChannel,
        filter: { _: 'channelParticipantsRecent' },
        offset: 0,
        limit: 100,
        hash: '0'
      });

      const users = (participants.users || []).map(u => {
        const firstName = u.first_name || '';
        const lastName = u.last_name || '';
        const fullName = [firstName, lastName].filter(Boolean).join(' ');
        return {
          id: String(u.id),
          username: u.username ? ('@' + u.username) : '',
          first_name: firstName,
          last_name: lastName,
          name: fullName || (u.username ? ('@' + u.username) : String(u.id)),
          phone: u.phone || '',
          is_bot: !!(u.pFlags && u.pFlags.bot),
          status: (u.status && u.status._) ? u.status._.replace(/^userStatus/, '') : '',
          message_count: 0,
          last_active_at: '',
        };
      });

      return {
        count: participants.count || users.length,
        users,
      };
    } catch (e) {
      return { error: e.message, users: [] };
    }
  })()`;

  const res = await client.evaluate(tabId, listScript);
  const data = res?.result || res?.value || res;
  const users = (data && data.users) || [];

  return users.map((u) => ({
    ...u,
    target,
    scraped_at: new Date().toISOString(),
  }));
}
/**
 * Main scraper orchestration function.
 */
async function scrapeParticipants(
  client,
  tabId,
  target,
  maxIterations = 100,
  idleLimit = 5,
  mode = "both",
  messageLimit = 50000,
  userLimit = 1000
) {
  const { handle } = normalizeTarget(target);
  await initTargetChat(client, tabId, handle);

  const mergedMap = new Map();

  // 1. If mode includes member list, scrape member list first
  if (mode === "members" || mode === "both") {
    try {
      const memberListUsers = await scrapeParticipantsFromMemberList(client, tabId, target, maxIterations, idleLimit);
      for (const u of memberListUsers) {
        mergedMap.set(u.id, u);
      }
      console.log(`Üye listesinden bulunan kullanıcı sayısı: ${memberListUsers.length}`);
    } catch (err) {
      console.log(`Üye listesi çekme notu: ${err.message}`);
    }
  }

  // 2. If mode includes messages (or both), scrape conversation messages
  if (mode === "messages" || mode === "both") {
    try {
      const messageUsers = await scrapeMembersFromMessages(client, tabId, target, messageLimit, idleLimit, userLimit);
      for (const u of messageUsers) {
        if (mergedMap.has(u.id)) {
          const existing = mergedMap.get(u.id);
          mergedMap.set(u.id, {
            ...existing,
            ...u,
            message_count: (existing.message_count || 0) + (u.message_count || 0),
            last_active_at: u.last_active_at || existing.last_active_at,
          });
        } else {
          mergedMap.set(u.id, u);
        }
      }
    } catch (err) {
      console.warn(`Yazışmalardan üye çekme hatası: ${err.message}`);
    }
  }

  return Array.from(mergedMap.values());
}

async function main() {
  const targetEnv = process.env.TARGET;
  if (!targetEnv) {
    console.error("Error: TARGET environment variable is required.");
    console.error("Example: TARGET=https://t.me/examplegroup node script.js");
    console.error("Or set TARGET in .env file.");
    process.exit(1);
  }

  const { handle, webUrl } = normalizeTarget(targetEnv);
  const camofoxUrl = process.env.CAMOFOX_URL || "http://127.0.0.1:9377";
  const apiKey = process.env.CAMOFOX_API_KEY || "";
  const userId = process.env.CAMOFOX_USER_ID || "tg-scraper-user";
  const csvOutput = process.env.CSV_OUTPUT || "participants.csv";
  const scrapeMode = process.env.SCRAPE_MODE || "both"; // 'messages', 'members', or 'both'
  const messageLimit = parseInt(process.env.MESSAGE_LIMIT || "50000", 10);
  const userLimit = parseInt(process.env.USER_LIMIT || process.env.TARGET_USERS || "1000", 10);
  const maxIterations = parseInt(process.env.SCROLL_MAX_ITERATIONS || "100", 10);
  const idleLimit = parseInt(process.env.SCROLL_IDLE_LIMIT || "8", 10);

  console.log("=== Telegram Web Group Scraper (Camofox) ===");
  console.log(`Hedef: @${handle}`);
  console.log(`Mod: ${scrapeMode} (messages / members / both)`);
  console.log(`Hedeflenen Kullanıcı Sayısı: ${userLimit}`);
  console.log(`Maksimum Mesaj Limiti: ${messageLimit}`);
  console.log(`Camofox URL: ${camofoxUrl}`);
  console.log(`User ID (Session): ${userId}`);
  console.log(`Çıktı Dosyası: ${csvOutput}\n`);
  const client = new CamofoxClient({
    baseUrl: camofoxUrl,
    apiKey,
    userId,
  });

  const isHealthy = await client.checkHealth();
  if (!isHealthy) {
    console.error(`Error: Cannot connect to Camofox server at ${camofoxUrl}`);
    console.error("Please make sure Camofox is started:");
    console.error("  npx @askjo/camofox-browser");
    process.exit(1);
  }

  let tabId = null;
  try {
    console.log("Creating browser tab...");
    tabId = await client.createTab({ sessionKey: "tg-scrape-session", url: "https://web.telegram.org/k/" });
    console.log(`Tab created: ${tabId}`);

    await ensureAuthenticated(client, tabId);

    const targetFormatted = handle.startsWith("-") || /^\d+$/.test(handle) ? handle : `@${handle}`;
    const participants = await scrapeParticipants(
      client,
      tabId,
      targetFormatted,
      maxIterations,
      idleLimit,
      scrapeMode,
      messageLimit,
      userLimit
    );
    console.log(`Toplam bulunan tekil üye sayısı: ${participants.length}`);
    console.log(`========================================\n`);

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

    if (participants.length > 0) {
      console.table(
        participants.slice(0, 20).map((p) => ({
          id: p.id,
          username: p.username,
          name: p.name,
          messages: p.message_count,
          status: p.status,
        }))
      );
      if (participants.length > 20) {
        console.log(`... ve ${participants.length - 20} kullanıcı daha.`);
      }

      const csv = parse(participants, { fields });
      fs.writeFileSync(csvOutput, csv, "utf-8");
      console.log(`\n✓ Üye verileri CSV dosyasına kaydedildi: ${path.resolve(csvOutput)}`);
    } else {
      console.warn("\nHiç üye bilgisi bulunamadı.");
      const csv = parse([], { fields });
      fs.writeFileSync(csvOutput, csv, "utf-8");
      console.log(`Boş CSV oluşturuldu: ${path.resolve(csvOutput)}`);
    }

    process.exit(0);
  } catch (error) {
    console.error("\nScraper Error:", error.message);
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
  normalizeTarget,
  CamofoxClient,
  scrapeParticipants,
  scrapeMembersFromMessages,
  scrapeParticipantsFromMemberList,
  initTargetChat,
  ensureAuthenticated,
};
