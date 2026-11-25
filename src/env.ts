export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Bindings {
  BROWSER: BrowserRun;
  /** Screenshots and PDFs, deleted after SHOT_TTL_HOURS by the cron. */
  SHOTS: R2Bucket;
  /** Short-lived capture cache (URL + options -> stored capture). */
  CACHE: KVNamespace;
  /** Caps browser launches; cache hits don't count. */
  BROWSER_LIMITER?: RateLimiter;
  /** Caps failed auth attempts per IP. */
  AUTH_LIMITER?: RateLimiter;

  /** Public base URL for links, e.g. https://peek.nradix.com */
  PUBLIC_URL?: string;
  /** Hours to keep captures (default 72). */
  SHOT_TTL_HOURS?: string;
  /** Seconds to reuse an identical capture (default 300, min 60). */
  CACHE_TTL_SECONDS?: string;
  /** Comma-separated domains that belong to you (e.g. "nradix.com"). Access headers are only ever sent to these. */
  OWNER_DOMAINS?: string;

  /** Secret: unlocks /mcp and /api. */
  PEEK_TOKEN?: string;
  /** Secrets: a Cloudflare Access service token for your own protected previews. */
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
}

export type AppEnv = { Bindings: Bindings };
