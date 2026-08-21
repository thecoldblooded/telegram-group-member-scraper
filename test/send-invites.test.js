const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("node:http");
const { getPersonalizedMessage, loadExistingDMResults, sendInviteDM } = require("../send-invites.js");
const { CamofoxClient } = require("../script.js");

test("getPersonalizedMessage generates personalized text with channel link", () => {
  const link = "https://t.me/firsattakipkanali";
  const msg = getPersonalizedMessage("Ahmet Yılmaz", link);
  assert.ok(msg.includes(link));
  assert.ok(msg.includes("Ahmet"));
});

test("loadExistingDMResults parses previous results CSV", () => {
  const tmpPath = path.resolve(__dirname, "test-dm-results.csv");
  const csvContent = `"username","id","name","status","detail"
"@alice","1001","Alice","SENT_SUCCESSFULLY","OK"
"@bob","1002","Bob","PRIVACY_RESTRICTED","Restricted"`;

  fs.writeFileSync(tmpPath, csvContent, "utf-8");

  try {
    const map = loadExistingDMResults(tmpPath);
    assert.equal(map.size, 2);
    assert.ok(map.has("alice"));
    assert.ok(map.has("bob"));
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
});

test("sendInviteDM sends message in mock environment", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.url.startsWith("/tabs/tab-1/evaluate")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          result: {
            username: "testuser",
            id: "555",
            name: "Test User",
            status: "SENT_SUCCESSFULLY",
            detail: "Davet mesajı gönderildi"
          }
        }));
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
    const res = await sendInviteDM(client, "tab-1", { username: "testuser", id: "555", name: "Test User" }, "https://t.me/firsattakipkanali");
    assert.equal(res.status, "SENT_SUCCESSFULLY");
    assert.equal(res.username, "testuser");
  } finally {
    server.close();
  }
});
