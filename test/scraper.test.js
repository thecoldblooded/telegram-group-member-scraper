const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  CamofoxClient,
  scrapeParticipants,
  scrapeMembersFromMessages,
  scrapeParticipantsFromMemberList,
} = require("../script.js");

test("CamofoxClient handles REST methods and error handling", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });

      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else if (req.url === "/tabs" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tabId: "tab-123" }));
      } else if (req.url.startsWith("/tabs/tab-123/evaluate") && req.method === "POST") {
        const payload = body ? JSON.parse(body) : {};
        const expr = payload.expression || "";

        if (expr.includes("contacts.resolveUsername")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            result: {
              ok: true,
              chatTitle: "Test Group",
              chatId: 123456789,
            }
          }));
        } else if (expr.includes("channels.getParticipants")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            result: {
              count: 2,
              users: [
                {
                  id: "1001",
                  username: "@alice",
                  first_name: "Alice",
                  last_name: "Smith",
                  name: "Alice Smith",
                  phone: "",
                  is_bot: false,
                  status: "online",
                  message_count: 0,
                  last_active_at: "",
                },
                {
                  id: "1002",
                  username: "@bob_bot",
                  first_name: "Bob Bot",
                  last_name: "",
                  name: "Bob Bot",
                  phone: "",
                  is_bot: true,
                  status: "",
                  message_count: 0,
                  last_active_at: "",
                },
              ]
            }
          }));
        } else if (expr.includes("messages.getHistory")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            result: {
              batchProcessed: 2,
              totalMessages: 2,
              uniqueUsers: 2,
              reachedEnd: true,
              offsetId: 99,
            }
          }));
        } else if (expr.includes("state.userMap.values()")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            result: {
              users: [
                {
                  id: "1001",
                  username: "@alice",
                  first_name: "Alice",
                  last_name: "Smith",
                  name: "Alice Smith",
                  phone: "",
                  is_bot: false,
                  status: "online",
                  message_count: 5,
                  last_active_at: "2026-08-18T10:00:00.000Z",
                },
                {
                  id: "1003",
                  username: "@charlie",
                  first_name: "Charlie",
                  last_name: "",
                  name: "Charlie",
                  phone: "123456789",
                  is_bot: false,
                  status: "Recently",
                  message_count: 1,
                  last_active_at: "2026-08-18T09:30:00.000Z",
                },
              ]
            }
          }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result: { ok: true } }));
        }
      } else if (req.url.startsWith("/tabs/tab-123") && req.method === "DELETE") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const client = new CamofoxClient({ baseUrl: `http://127.0.0.1:${port}` });

  try {
    const isHealthy = await client.checkHealth();
    assert.equal(isHealthy, true);

    const tabId = await client.createTab({ url: "https://web.telegram.org/k/" });
    assert.equal(tabId, "tab-123");

    const participants = await scrapeParticipants(client, tabId, "@testgroup", 5, 2, "both", 100, 100);
    assert.equal(participants.length, 3); // Alice (1001), Bob (1002), Charlie (1003)

    const alice = participants.find((p) => p.id === "1001");
    assert.ok(alice);
    assert.equal(alice.name, "Alice Smith");
    assert.equal(alice.username, "@alice");
    assert.equal(alice.message_count, 5);

    const bob = participants.find((p) => p.id === "1002");
    assert.ok(bob);
    assert.equal(bob.is_bot, true);

    const charlie = participants.find((p) => p.id === "1003");
    assert.ok(charlie);
    assert.equal(charlie.phone, "123456789");

    await client.closeTab(tabId);
  } finally {
    server.close();
  }
});
