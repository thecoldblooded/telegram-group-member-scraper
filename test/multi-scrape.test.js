const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("node:http");
const { loadExistingParticipants, initTargetChat, scrapeGroupMessages } = require("../multi-scrape.js");
const { CamofoxClient } = require("../script.js");

test("loadExistingParticipants parses existing CSV", () => {
  const tmpPath = path.resolve(__dirname, "test-existing.csv");
  const csvContent = `"id","username","first_name","last_name","name","phone","is_bot","status","message_count","last_active_at","target","scraped_at"
"1001","@alice","Alice","","Alice","",false,"online",5,"2026-08-18","@kodu_group","2026-08-18"`;

  fs.writeFileSync(tmpPath, csvContent, "utf-8");

  try {
    const map = loadExistingParticipants(tmpPath);
    assert.equal(map.size, 1);
    const alice = map.get("1001");
    assert.equal(alice.username, "@alice");
    assert.equal(alice.name, "Alice");
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
});

test("initTargetChat and scrapeGroupMessages execute successfully in mock", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.url.startsWith("/tabs/tab-1/evaluate")) {
        const payload = body ? JSON.parse(body) : {};
        const expr = payload.expression || "";
        if (expr.includes("contacts.resolveUsername")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            result: { ok: true, chatTitle: "Mock Group", chatId: 8888 }
          }));
        } else if (expr.includes("messages.getHistory")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            result: {
              batchProcessed: 2,
              totalMessages: 2,
              reachedEnd: true,
              offsetId: 50,
              batchUsers: [
                {
                  id: "2001",
                  username: "@mockuser",
                  first_name: "Mock",
                  last_name: "User",
                  name: "Mock User",
                  phone: "",
                  is_bot: false,
                  status: "Recently"
                }
              ]
            }
          }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result: { ok: true } }));
        }
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const client = new CamofoxClient({ baseUrl: `http://127.0.0.1:${port}` });

  try {
    const map = new Map();
    await scrapeGroupMessages(client, "tab-1", "mockgroup", map, 100, 100);
    assert.equal(map.size, 1);
    const u = map.get("2001");
    assert.ok(u);
    assert.equal(u.username, "@mockuser");
  } finally {
    server.close();
  }
});
