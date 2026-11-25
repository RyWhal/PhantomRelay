import type { Context } from "hono";
import type { AppEnv } from "./env.ts";

/** Base URL for links: PUBLIC_URL when set, else the request's origin. */
export function publicOrigin(c: Context<AppEnv>): string {
  const configured = c.env.PUBLIC_URL?.replace(/\/+$/, "");
  return configured || new URL(c.req.url).origin;
}
