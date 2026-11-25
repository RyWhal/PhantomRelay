// Unit tests: URL safety, request-blocking patterns, image helpers.
// Run: npm test   (Node 22.18+ runs TypeScript directly)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCK_PATTERNS,
  checkDns,
  checkUrl,
  isBlockedIp,
  isOwnerHost,
  ownerOnlyPattern,
  parseDomainList,
  parseIPv6,
  UrlRefused,
  type Resolver,
} from "../src/urlguard.ts";
import { imageSize, sniffType } from "../src/util.ts";
import { outlineTree, parseCaptureArgs } from "../src/capture.ts";

const refused = (u: string) => assert.throws(() => checkUrl(u), UrlRefused, `expected refusal: ${u}`);
const allowed = (u: string) => assert.doesNotThrow(() => checkUrl(u), `expected allowed: ${u}`);

test("allows ordinary public URLs", () => {
  allowed("https://plonk.nradix.com/");
  allowed("http://example.com/path?q=1#frag");
  allowed("example.com"); // bare domain -> https
  allowed("https://1.1.1.1/");
  allowed("https://[2606:4700:4700::1111]/");
  assert.equal(checkUrl("nradix.com").toString(), "https://nradix.com/");
});

test("refuses non-http schemes and credentials", () => {
  refused("file:///etc/passwd");
  refused("ftp://example.com/");
  refused("javascript:alert(1)");
  refused("data:text/html,<h1>x</h1>");
  refused("chrome://settings");
  refused("https://user:pass@example.com/");
  refused("");
  refused("https://" + "a".repeat(5000) + ".com/");
});

test("refuses localhost and internal names", () => {
  refused("http://localhost/");
  refused("http://localhost:8787/mcp");
  refused("http://LOCALHOST./");
  refused("http://foo.localhost/");
  refused("http://printer.local/");
  refused("http://metadata.google.internal/computeMetadata/v1/");
  refused("http://router/");
  refused("http://nas.lan/");
  refused("http://box.home.arpa/");
});

test("refuses private, loopback, link-local and reserved IPv4 in every spelling", () => {
  for (const u of [
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/", // decimal 127.0.0.1
    "http://0x7f000001/",
    "http://017700000001/", // octal
    "http://0.0.0.0/",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://198.18.0.1/",
    "http://224.0.0.1/",
    "http://255.255.255.255/",
  ]) refused(u);
  allowed("http://172.32.0.1/");
  allowed("http://100.128.0.1/");
  allowed("http://8.8.8.8/");
});

test("refuses private and tunnelling IPv6", () => {
  for (const u of [
    "http://[::1]/",
    "http://[::]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[ff02::1]/",
    "http://[64:ff9b::7f00:1]/",
    "http://[2002:7f00:1::]/",
    "http://[2001::1]/",
    "http://[2001:db8::1]/",
  ]) refused(u);
  assert.equal(isBlockedIp("::ffff:8.8.8.8"), false);
  assert.deepEqual(parseIPv6("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(parseIPv6("1:2:3:4:5:6:7:8"), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(parseIPv6("1::2::3"), null);
  assert.equal(parseIPv6("1:2:3:4:5:6:7:8:9"), null);
  assert.equal(isBlockedIp("not-an-ip"), true);
});

const fakeDns = (table: Record<string, string[]>): Resolver => async (name, type) => {
  const all = table[name];
  if (!all) return { status: 3, addresses: [] };
  return { status: 0, addresses: all.filter((ip) => (type === "A" ? !ip.includes(":") : ip.includes(":"))) };
};

test("DNS check refuses names that resolve to private addresses", async () => {
  const dns = fakeDns({
    "good.example": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
    "127.0.0.1.nip.io": ["127.0.0.1"],
    "mixed.example": ["93.184.215.14", "10.0.0.1"],
    "v6local.example": ["::1"],
  });
  await checkDns(new URL("https://good.example/"), dns);
  await assert.rejects(checkDns(new URL("https://127.0.0.1.nip.io/"), dns), /private/);
  await assert.rejects(checkDns(new URL("https://mixed.example/"), dns), /private/);
  await assert.rejects(checkDns(new URL("https://v6local.example/"), dns), /private/);
  await assert.rejects(checkDns(new URL("https://missing.example/"), dns), /does not exist/);
  await assert.rejects(
    checkDns(new URL("https://boom.example/"), async () => {
      throw new Error("network");
    }),
    /Could not look up/
  );
  // IP literals skip DNS
  await checkDns(new URL("https://1.1.1.1/"), dns);
});

test("browser block patterns catch private targets and leave public ones alone", () => {
  const res = BLOCK_PATTERNS.map((p) => new RegExp(p));
  const blocked = (u: string) => res.some((r) => r.test(u));
  for (const u of [
    "http://127.0.0.1/",
    "http://127.0.0.1:8080/x",
    "https://10.1.2.3/",
    "http://169.254.169.254/latest/meta-data/",
    "http://172.20.0.1/",
    "http://192.168.0.1",
    "http://100.100.100.200/",
    "http://0.0.0.0:3000/",
    "http://[::1]/",
    "http://[fd00::1]:80/",
    "http://localhost/",
    "http://localhost:5173/",
    "http://api.localhost/",
    "http://metadata.google.internal/",
    "http://printer.local/",
    "http://router/",
    "http://user@10.0.0.1/",
    "file:///etc/passwd",
    "http://230.0.0.1/",
  ]) assert.ok(blocked(u), `should block ${u}`);
  for (const u of [
    "https://plonk.nradix.com/",
    "https://fonts.googleapis.com/css2?family=Inter",
    "https://cdn.example.com/app.js",
    "https://10.example.com/",
    "https://localhost.example.com/",
    "https://172.32.0.1/",
    "https://1.1.1.1/",
    "data:image/png;base64,AAAA",
    "blob:https://example.com/uuid",
    "https://example.com:8443/",
  ]) assert.ok(!blocked(u), `should allow ${u}`);
});

test("owner domains", () => {
  const domains = parseDomainList("nradix.com, *.example.org  bad");
  assert.deepEqual(domains, ["nradix.com", "example.org"]);
  assert.ok(isOwnerHost("peek.nradix.com", domains));
  assert.ok(isOwnerHost("nradix.com", domains));
  assert.ok(!isOwnerHost("evilnradix.com", domains));
  assert.ok(!isOwnerHost("nradix.com.evil.io", domains));
  const re = new RegExp(ownerOnlyPattern(domains));
  assert.ok(re.test("https://preview.nradix.com/page"));
  assert.ok(re.test("https://nradix.com"));
  assert.ok(!re.test("https://cdn.jsdelivr.net/x.js"));
  assert.ok(!re.test("https://nradix.com.evil.io/"));
  assert.ok(!re.test("https://evilnradix.com/"));
});

test("image sniffing and sizes", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  assert.equal(sniffType(png), "image/png");
  assert.deepEqual(imageSize(png), { width: 1, height: 1 });
  // Minimal JPEG header: SOI, APP0 (16 bytes), SOF0 with 600x800
  const jpeg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x02, 0x58, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
  assert.equal(sniffType(jpeg), "image/jpeg");
  assert.deepEqual(imageSize(jpeg), { width: 600, height: 800 });
  assert.equal(sniffType(new TextEncoder().encode("%PDF-1.7")), "application/pdf");
  assert.equal(sniffType(new TextEncoder().encode("<svg>")), null);
});

test("capture argument parsing", () => {
  const d = parseCaptureArgs({ url: "https://example.com" });
  assert.equal(d.viewport, "desktop");
  assert.equal(d.format, "png");
  assert.equal(parseCaptureArgs({ url: "x.com", full_page: true }).format, "jpeg");
  assert.throws(() => parseCaptureArgs({ url: "x.com", viewport: "watch" }), /viewport/);
  assert.throws(() => parseCaptureArgs({ url: "x.com", viewport: "custom" }), /width and height/);
  assert.throws(() => parseCaptureArgs({ url: "x.com", wait_ms: 60000 }), /wait_ms/);
  assert.throws(() => parseCaptureArgs({}), /url/);
  assert.equal(parseCaptureArgs({ url: "x.com", viewport: "custom", width: "800", height: "600" }).width, 800);
});

test("accessibility outline", () => {
  const tree = {
    role: "RootWebArea",
    name: "Plonk",
    children: [
      { role: "heading", name: "Share something", level: 1, children: [{ role: "StaticText", name: "Share something" }] },
      { role: "link", name: "DocsAPI reference", children: [{ role: "StaticText", name: "Docs" }] },
      { role: "StaticText", name: "Loose text" },
      { role: "button", name: "Create", disabled: true },
      { role: "checkbox", name: "Burn", checked: false },
    ],
  };
  const out = outlineTree(tree, 10_000);
  assert.equal(
    out,
    'RootWebArea "Plonk"\n  heading "Share something" level=1\n  link "DocsAPI reference"\n  StaticText "Loose text"\n  button "Create" disabled\n  checkbox "Burn"'
  );
  assert.match(outlineTree(tree, 30), /truncated/);
  assert.equal(outlineTree(null, 100), "(no accessibility tree)");
});
