/**
 * Cloudflare Access support for your own protected previews.
 *
 * The service token (ACCESS_CLIENT_ID / ACCESS_CLIENT_SECRET) is a Worker
 * secret. It is never taken from tool arguments and is only used for hosts in
 * OWNER_DOMAINS. Preferred path: exchange it for the CF_Authorization cookie,
 * which the browser then sends only to that host. Hosts that aren't behind
 * Access get nothing extra. Fallback when Access answers but issues no
 * cookie: send the headers, but restrict the browser to OWNER_DOMAINS so the
 * token never reaches a third-party host.
 */
import type { Bindings } from "./env.ts";
import { isOwnerHost, ownerOnlyPattern, parseDomainList } from "./urlguard.ts";

export interface AccessPlan {
  cookies?: Array<{ name: string; value: string; url: string; secure: boolean; httpOnly: boolean; sameSite: "Lax" }>;
  headers?: Record<string, string>;
  /** When set, replaces the usual block list: only these URLs may load. */
  allowRequestPattern?: string[];
  mode: "cookie" | "headers";
}

const COOKIE_CACHE_SECONDS = 15 * 60;

function accessConfigured(env: Bindings): boolean {
  return Boolean(env.ACCESS_CLIENT_ID && env.ACCESS_CLIENT_SECRET);
}

export function ownerDomains(env: Bindings): string[] {
  return parseDomainList(env.OWNER_DOMAINS);
}

function extractAuthCookie(res: Response): string | null {
  const all = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  if (all.length === 0) {
    const single = res.headers.get("Set-Cookie");
    if (single) all.push(...single.split(/,(?=\s*[A-Za-z0-9_-]+=)/));
  }
  for (const c of all) {
    const m = /(?:^|\s)CF_Authorization=([^;\s]+)/.exec(c);
    if (m) return m[1];
  }
  return null;
}

type Probe = { kind: "cookie"; value: string } | { kind: "protected" } | { kind: "open" };

function looksLikeAccess(res: Response): boolean {
  if (res.status === 401 || res.status === 403) return true;
  const location = res.headers.get("Location") ?? "";
  return /\.cloudflareaccess\.com\//i.test(location) || /\/cdn-cgi\/access\//.test(location);
}

/**
 * Call the origin with the service token once. Returns the CF_Authorization
 * cookie if Access issued one, "protected" if Access is in the way but gave no
 * cookie, or "open" if the host isn't behind Access at all.
 */
async function probe(env: Bindings, origin: string): Promise<Probe> {
  const cacheKey = `access:${origin}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached === "open" || cached === "protected") return { kind: cached };
  if (cached) return { kind: "cookie", value: cached };

  let result: Probe;
  try {
    const res = await fetch(`${origin}/`, {
      method: "GET",
      redirect: "manual",
      headers: {
        "CF-Access-Client-Id": env.ACCESS_CLIENT_ID!,
        "CF-Access-Client-Secret": env.ACCESS_CLIENT_SECRET!,
      },
      signal: AbortSignal.timeout(10_000),
    });
    const cookie = extractAuthCookie(res);
    result = cookie ? { kind: "cookie", value: cookie } : looksLikeAccess(res) ? { kind: "protected" } : { kind: "open" };
    await res.body?.cancel();
  } catch (err) {
    console.warn("Access probe failed", origin, err);
    return { kind: "protected" };
  }
  const value = result.kind === "cookie" ? result.value : result.kind;
  await env.CACHE.put(cacheKey, value, { expirationTtl: COOKIE_CACHE_SECONDS });
  return result;
}

/**
 * How to authenticate the browser for this URL, or null when the URL isn't
 * one of your domains (or no service token is configured).
 */
export async function accessPlan(env: Bindings, url: URL): Promise<AccessPlan | null> {
  if (!accessConfigured(env)) return null;
  const domains = ownerDomains(env);
  if (!isOwnerHost(url.hostname, domains)) return null;

  const found = await probe(env, url.origin);
  if (found.kind === "open") return null;
  if (found.kind === "cookie") {
    return {
      mode: "cookie",
      cookies: [{ name: "CF_Authorization", value: found.value, url: url.origin, secure: url.protocol === "https:", httpOnly: true, sameSite: "Lax" }],
    };
  }
  return {
    mode: "headers",
    headers: {
      "CF-Access-Client-Id": env.ACCESS_CLIENT_ID!,
      "CF-Access-Client-Secret": env.ACCESS_CLIENT_SECRET!,
    },
    allowRequestPattern: [ownerOnlyPattern(domains)],
  };
}
