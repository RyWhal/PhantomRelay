// End-to-end checks against a running Peek (default: `npm run dev` on :8787).
// These need no outside network: they cover auth, refusals and routing.
// Run: PEEK_URL=http://localhost:8787 PEEK_TOKEN=... npm run test:e2e
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.PEEK_URL ?? "http://localhost:8787";
const TOKEN = process.env.PEEK_TOKEN ?? "test-peek-token-0123456789abcdef";

const rpc = async (method, params = {}, path = `/mcp/${TOKEN}`, headers = {}) => {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { res, body: res.status === 200 ? await res.json() : null };
};

const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).body.result;

test("landing page is public and holds no token", async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>Peek<\/title>/);
  assert.ok(!html.includes(TOKEN));
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("MCP needs the token, by path or bearer header", async () => {
  assert.equal((await rpc("ping", {}, "/mcp")).res.status, 401);
  assert.equal((await rpc("ping", {}, "/mcp/wrong-token-wrong-token-wrong")).res.status, 401);
  assert.equal((await rpc("ping", {}, "/mcp", { Authorization: "Bearer nope" })).res.status, 401);
  assert.equal((await rpc("ping", {}, "/mcp", { Authorization: `Bearer ${TOKEN}` })).res.status, 200);
  assert.equal((await rpc("ping")).res.status, 200);
  assert.equal((await fetch(`${BASE}/mcp/${TOKEN}`)).status, 405);
});

test("initialize and tools/list", async () => {
  const init = (await rpc("initialize", { protocolVersion: "2025-06-18" })).body.result;
  assert.equal(init.serverInfo.name, "peek");
  assert.match(init.instructions, /untrusted/i);
  const { tools } = (await rpc("tools/list")).body.result;
  assert.deepEqual(tools.map((t) => t.name).sort(), ["peek_pdf", "peek_screenshot", "peek_snapshot"]);
});

test("private and internal targets are refused before any browser work", async () => {
  for (const url of [
    "http://localhost:8787/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://metadata.google.internal/",
    "http://router/",
    "file:///etc/passwd",
    "https://user:pw@example.com/",
  ]) {
    for (const tool of ["peek_screenshot", "peek_snapshot", "peek_pdf"]) {
      const result = await call(tool, { url });
      assert.equal(result.isError, true, `${tool} ${url}`);
      assert.match(result.content[0].text, /^Refused/, `${tool} ${url}`);
    }
  }
});

test("bad arguments are tool errors, not crashes", async () => {
  assert.match((await call("peek_screenshot", {})).content[0].text, /url is required/);
  assert.match((await call("peek_screenshot", { url: "https://example.com", viewport: "watch" })).content[0].text, /viewport/);
  assert.match((await call("peek_screenshot", { url: "https://example.com", wait_ms: 999999 })).content[0].text, /wait_ms/);
  const unknown = (await rpc("tools/call", { name: "nope", arguments: {} })).body;
  assert.equal(unknown.error.code, -32602);
});

test("HTTP API needs the token and refuses private targets", async () => {
  assert.equal((await fetch(`${BASE}/api/screenshot?url=https://example.com`)).status, 401);
  const res = await fetch(`${BASE}/api/screenshot?url=${encodeURIComponent("http://127.0.0.1/")}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Refused/);
});

test("stored-file route only serves well-formed ids", async () => {
  assert.equal((await fetch(`${BASE}/s/..%2f..%2fetc`)).status, 404);
  assert.equal((await fetch(`${BASE}/s/short.png`)).status, 404);
  assert.equal((await fetch(`${BASE}/s/${"a".repeat(24)}.png`)).status, 404);
});
