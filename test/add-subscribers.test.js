const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("node:http");
const { loadUsernamesFromCSV, initChannel, inviteSingleUser, inviteBatch } = require("../add-subscribers.js");
const { CamofoxClient } = require("../script.js");

test("loadUsernamesFromCSV parses valid usernames and skips bots", () => {
  const tmpPath = path.resolve(__dirname, "test-users.csv");
  const csvContent = `"id","username","name","is_bot","status"
"101","@user_one","User One",false,"online"
"102","user_two","User Two",false,"offline"
"103","@some_bot","Some Bot",true,""
"104","","No Username",false,"online"
"105","@user_one","Duplicate User",false,"online"`;

  fs.writeFileSync(tmpPath, csvContent, "utf-8");

  try {
    const users = loadUsernamesFromCSV(tmpPath);
    assert.equal(users.length, 2);
    assert.equal(users[0].username, "user_one");
    assert.equal(users[1].username, "user_two");
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
});

test("initChannel and inviteSingleUser execute successfully", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.url.startsWith("/tabs/tab-1/evaluate")) {
        const payload = body ? JSON.parse(body) : {};
        const expr = payload.expression || "";
        if (expr.includes("window._inviteChannel =")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            result: { ok: true, title: "Test Channel", id: 9999 }
          }));
        } else if (expr.includes("channels.inviteToChannel")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            result: {
              username: "alice",
              id: "1",
              name: "Alice",
              status: "ADDED_SUCCESSFULLY",
              detail: "OK"
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
    const chan = await initChannel(client, "tab-1", "mychannel");
    assert.equal(chan.title, "Test Channel");

    const res = await inviteSingleUser(client, "tab-1", { username: "alice", id: "1", name: "Alice" });
    assert.equal(res.status, "ADDED_SUCCESSFULLY");
    assert.equal(res.username, "alice");
  } finally {
    server.close();
  }
});
