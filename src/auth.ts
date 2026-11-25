import type { Bindings } from "./env.ts";
import { safeEqual } from "./util.ts";

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : null;
}

/** Minimum token length, so a weak secret can't be set by accident. */
export const MIN_TOKEN_LENGTH = 24;

export type AuthResult = "ok" | "unauthorized" | "not_configured";

/**
 * Checks the token from the path (/mcp/<token>, for clients that only take a
 * URL) or the Authorization header. Fails closed when PEEK_TOKEN is unset or
 * too short.
 */
export function checkToken(env: Bindings, req: Request, pathToken: string | null): AuthResult {
  const expected = env.PEEK_TOKEN;
  if (!expected || expected.length < MIN_TOKEN_LENGTH) return "not_configured";
  const supplied = pathToken ?? bearerToken(req);
  return supplied && safeEqual(supplied, expected) ? "ok" : "unauthorized";
}
