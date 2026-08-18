const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeTarget } = require("../script.js");

test("normalizeTarget handles full https t.me URLs", () => {
  const res = normalizeTarget("https://t.me/examplegroup");
  assert.equal(res.handle, "examplegroup");
  assert.equal(res.webUrl, "https://web.telegram.org/k/#@examplegroup");
});

test("normalizeTarget handles http t.me URLs", () => {
  const res = normalizeTarget("http://t.me/examplegroup");
  assert.equal(res.handle, "examplegroup");
  assert.equal(res.webUrl, "https://web.telegram.org/k/#@examplegroup");
});

test("normalizeTarget handles t.me/ prefix without protocol", () => {
  const res = normalizeTarget("t.me/my_test_chat");
  assert.equal(res.handle, "my_test_chat");
  assert.equal(res.webUrl, "https://web.telegram.org/k/#@my_test_chat");
});

test("normalizeTarget handles @username handle format", () => {
  const res = normalizeTarget("@cryptocommunity");
  assert.equal(res.handle, "cryptocommunity");
  assert.equal(res.webUrl, "https://web.telegram.org/k/#@cryptocommunity");
});

test("normalizeTarget handles bare handle name", () => {
  const res = normalizeTarget("simplegroup");
  assert.equal(res.handle, "simplegroup");
  assert.equal(res.webUrl, "https://web.telegram.org/k/#@simplegroup");
});

test("normalizeTarget handles web.telegram.org/k/#@ URLs", () => {
  const res = normalizeTarget("https://web.telegram.org/k/#@webgroup");
  assert.equal(res.handle, "webgroup");
  assert.equal(res.webUrl, "https://web.telegram.org/k/#@webgroup");
});

test("normalizeTarget handles numeric Telegram Web K URLs", () => {
  const res = normalizeTarget("https://web.telegram.org/k/#-3205023502");
  assert.equal(res.handle, "-3205023502");
  assert.equal(res.webUrl, "https://web.telegram.org/k/#-3205023502");
});

test("normalizeTarget handles raw numeric peer IDs", () => {
  const res = normalizeTarget("-3205023502");
  assert.equal(res.handle, "-3205023502");
  assert.equal(res.webUrl, "https://web.telegram.org/k/#-3205023502");
});

test("normalizeTarget throws on empty or invalid inputs", () => {
  assert.throws(() => normalizeTarget(""), /TARGET is required|TARGET cannot be empty/);
  assert.throws(() => normalizeTarget(null), /TARGET is required/);
  assert.throws(() => normalizeTarget(undefined), /TARGET is required/);
  assert.throws(() => normalizeTarget("   "), /TARGET cannot be empty/);
  assert.throws(() => normalizeTarget("http://invalid$%*&"), /Invalid Telegram target handle/);
});
