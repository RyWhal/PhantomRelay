/**
 * Decides which URLs Peek may open. Only public http(s) pages: no localhost,
 * private or link-local ranges, cloud metadata endpoints, internal-only names
 * or IP literals that map onto those.
 *
 * Three layers:
 *  1. checkUrl(): the URL itself (scheme, credentials, hostname, IP literals).
 *  2. checkDns(): the hostname's A/AAAA records, via DNS over HTTPS, so names
 *     like 127.0.0.1.nip.io are refused too.
 *  3. BLOCK_PATTERNS: passed to Browser Run as rejectRequestPattern, so the
 *     browser itself refuses redirects and subresources to private IP
 *     literals and internal names.
 */

export class UrlRefused extends Error {}

const BLOCKED_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "private",
  "home.arpa",
  "localdomain",
  "in-addr.arpa",
  "ip6.arpa",
];

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "kubernetes",
  "kubernetes.default",
]);

const MAX_URL_LENGTH = 4096;

/** Parse an IPv4 dotted quad (already canonicalised by the URL parser). */
export function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** True for any IPv4 address that isn't ordinary public unicast. */
export function isBlockedIPv4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this" network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expand an IPv6 address (no brackets) to 8 16-bit groups. */
export function parseIPv6(input: string): number[] | null {
  let host = input.toLowerCase();
  if (host.includes("%")) return null; // zone ids never belong in a public URL
  // Embedded IPv4 tail, e.g. ::ffff:127.0.0.1
  const v4tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (v4tail) {
    const v4 = parseIPv4(v4tail[1]);
    if (!v4) return null;
    host =
      host.slice(0, -v4tail[1].length) +
      ((v4[0] << 8) | v4[1]).toString(16) +
      ":" +
      ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out.length === 8 ? out : null;
}

/** Only global unicast (2000::/3) is allowed, minus ranges that tunnel to IPv4 or are reserved. */
export function isBlockedIPv6(g: number[]): boolean {
  // IPv4-mapped (::ffff:a.b.c.d): judge the embedded IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return isBlockedIPv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  }
  if ((g[0] & 0xe000) !== 0x2000) return true; // ::, ::1, fc00::/7, fe80::/10, ff00::/8, 64:ff9b::/96 ...
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && (g[1] & 0xfff0) === 0x0010) return true; // ORCHID
  if (g[0] === 0x2002) return true; // 6to4 (embeds an IPv4 address)
  return false;
}

/** True if this IP address (v4 dotted quad or v6) must not be opened. */
export function isBlockedIp(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isBlockedIPv4(v4);
  const v6 = parseIPv6(ip);
  if (v6) return isBlockedIPv6(v6);
  return true; // not an address we understand: refuse
}

function isBlockedName(host: string): boolean {
  const h = host.replace(/\.$/, "");
  if (BLOCKED_HOSTS.has(h)) return true;
  if (!h.includes(".")) return true; // single-label names only resolve on internal networks
  return BLOCKED_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

/**
 * Validate a target URL. Returns the parsed URL, or throws UrlRefused with a
 * reason that is safe to show to the caller.
 */
export function checkUrl(raw: unknown): URL {
  if (typeof raw !== "string" || !raw.trim()) throw new UrlRefused("url is required");
  const input = raw.trim();
  if (input.length > MAX_URL_LENGTH) throw new UrlRefused("url is too long");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`);
  } catch {
    throw new UrlRefused("Not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UrlRefused("Only http and https URLs can be opened");
  }
  if (url.username || url.password) throw new UrlRefused("URLs with embedded credentials are not allowed");

  const host = url.hostname.toLowerCase();
  if (host.startsWith("[")) {
    if (isBlockedIp(host.slice(1, -1))) throw new UrlRefused("Private or reserved addresses are not allowed");
    return url;
  }
  if (parseIPv4(host)) {
    if (isBlockedIp(host)) throw new UrlRefused("Private or reserved addresses are not allowed");
    return url;
  }
  if (isBlockedName(host)) throw new UrlRefused(`${host} is an internal-only name`);
  return url;
}

export function isIpLiteral(url: URL): boolean {
  return url.hostname.startsWith("[") || parseIPv4(url.hostname) !== null;
}

export type Resolver = (name: string, type: "A" | "AAAA") => Promise<{ status: number; addresses: string[] }>;

/** DNS over HTTPS (Cloudflare's resolver, JSON API). */
export const dohResolve: Resolver = async (name, type) => {
  const res = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
    { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) throw new Error(`DNS lookup failed (${res.status})`);
  const body = (await res.json()) as { Status: number; Answer?: Array<{ type: number; data: string }> };
  const want = type === "A" ? 1 : 28;
  return {
    status: body.Status,
    addresses: (body.Answer ?? []).filter((a) => a.type === want).map((a) => a.data),
  };
};

/**
 * Resolve the hostname and refuse it if any address is private. IP literals
 * were already checked by checkUrl().
 */
export async function checkDns(url: URL, resolve: Resolver = dohResolve): Promise<void> {
  if (isIpLiteral(url)) return;
  const name = url.hostname.replace(/\.$/, "");
  let results;
  try {
    results = await Promise.all([resolve(name, "A"), resolve(name, "AAAA")]);
  } catch {
    throw new UrlRefused(`Could not look up ${name}`);
  }
  const addresses = results.flatMap((r) => r.addresses);
  if (addresses.length === 0) {
    throw new UrlRefused(results[0].status === 3 ? `${name} does not exist` : `${name} has no addresses`);
  }
  const bad = addresses.find((ip) => isBlockedIp(ip));
  if (bad) throw new UrlRefused(`${name} resolves to a private or reserved address`);
}

// ── browser-side request blocking ───────────────────────────────────────────

const PREFIX = "^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^/?#@]*@)?";
const END = "\\.?(?::\\d+)?(?:[/?#]|$)";
const OCTET = "(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)";

/**
 * Regexes (as strings) for Browser Run's rejectRequestPattern. Any request
 * the page makes, including redirects, to a private IP literal or an
 * internal-only name is blocked inside the browser.
 */
export const BLOCK_PATTERNS: string[] = [
  // internal-only names
  `${PREFIX}(?:${[...BLOCKED_HOSTS].map((h) => h.replace(/\./g, "\\.")).join("|")}|[^/?#:@]*\\.(?:${BLOCKED_SUFFIXES.map((s) => s.replace(/\./g, "\\.")).join("|")}))${END}`,
  // single-label hosts (no dot), e.g. http://router/
  `${PREFIX}[^/?#:@.\\[]+(?::\\d+)?(?:[/?#]|$)`,
  // private and reserved IPv4 literals
  `${PREFIX}(?:0|10|127|2(?:2[4-9]|[3-5]\\d))\\.${OCTET}\\.${OCTET}\\.${OCTET}${END}`,
  `${PREFIX}(?:169\\.254|192\\.168|172\\.(?:1[6-9]|2\\d|3[01])|100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])|198\\.1[89])\\.${OCTET}\\.${OCTET}${END}`,
  // every IPv6 literal (public sites don't need them)
  `${PREFIX}\\[`,
  // local files and browser internals
  "^(?:file|chrome|chrome-extension|devtools|view-source):",
];

/** Host is one of the owner's domains (exact match or a subdomain). */
export function isOwnerHost(host: string, ownerDomains: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return ownerDomains.some((d) => h === d || h.endsWith(`.${d}`));
}

export function parseDomainList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/^\*?\./, "").replace(/\.$/, ""))
    .filter((d) => d.includes("."));
}

/** Regex (as a string) matching any URL on the given domains. */
export function ownerOnlyPattern(domains: string[]): string {
  const alts = domains.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return `^https?://(?:[^/?#@]*@)?(?:[a-z0-9-]+\\.)*(?:${alts})\\.?(?::\\d+)?(?:[/?#]|$)`;
}
