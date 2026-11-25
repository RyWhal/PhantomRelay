import { Hono, type Context } from "hono";
import { checkToken } from "./auth.ts";
import { cleanup, parseCaptureArgs, screenshot } from "./capture.ts";
import type { AppEnv, Bindings } from "./env.ts";
import { LANDING_HTML } from "./landing.ts";
import { handleMcp } from "./mcp.ts";
import { publicOrigin } from "./origin.ts";
import { HttpError } from "./util.ts";

const app = new Hono<AppEnv>();

const FILE_PATTERN = /^[A-Za-z0-9]{24}\.(png|jpg|webp|pdf)$/;

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error("Unhandled error", err);
  return c.json({ error: "Internal error" }, 500);
});

app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "no-referrer");
  c.res.headers.set("X-Robots-Tag", "noindex, nofollow");
});

/** Slow down token guessing: failed attempts are limited per IP. */
async function authFailureAllowed(c: Context<AppEnv>): Promise<boolean> {
  if (!c.env.AUTH_LIMITER) return true;
  try {
    return (await c.env.AUTH_LIMITER.limit({ key: `auth:${c.req.header("CF-Connecting-IP") ?? "unknown"}` })).success;
  } catch {
    return true;
  }
}

async function requireToken(c: Context<AppEnv>, pathToken: string | null): Promise<Response | null> {
  const result = checkToken(c.env, c.req.raw, pathToken);
  if (result === "ok") return null;
  if (result === "not_configured") {
    return c.json({ error: "Peek is not configured (set the PEEK_TOKEN secret, at least 24 characters)" }, 503);
  }
  if (!(await authFailureAllowed(c))) return c.json({ error: "Too many attempts" }, 429);
  return c.json({ error: "Unauthorized" }, 401, { "Cache-Control": "no-store" });
}

// ── pages ───────────────────────────────────────────────────────────────────

app.get("/", (c) =>
  c.html(LANDING_HTML.replaceAll("{{ORIGIN}}", publicOrigin(c)), 200, {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Cache-Control": "public, max-age=300",
  })
);

app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"));

app.get("/healthz", (c) => c.json({ ok: true }));

// ── stored captures: unguessable ids, deleted after SHOT_TTL_HOURS ──────────

app.get("/s/:file", async (c) => {
  const file = c.req.param("file");
  if (!FILE_PATTERN.test(file)) return c.text("Not found", 404);
  const obj = await c.env.SHOTS.get(file);
  if (!obj) return c.text("Not found (captures are deleted after a few days)", 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "Content-Length": String(obj.size),
      "Content-Disposition": `inline; filename="peek-${file}"`,
      "Cache-Control": "private, max-age=3600",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
});

// ── HTTP API (same token as MCP) ────────────────────────────────────────────

// GET /api/screenshot?url=...&viewport=mobile&full_page=1  -> the image itself
app.get("/api/screenshot", async (c) => {
  const denied = await requireToken(c, null);
  if (denied) return denied;
  const shot = await screenshot(c.env, publicOrigin(c), parseCaptureArgs(c.req.query()));
  return new Response(shot.data, {
    headers: {
      "Content-Type": shot.contentType,
      "Cache-Control": "no-store",
      "X-Peek-Link": shot.link,
      "X-Peek-Cached": String(shot.cached),
      ...(shot.width && shot.height ? { "X-Peek-Size": `${shot.width}x${shot.height}` } : {}),
    },
  });
});

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// ── MCP ─────────────────────────────────────────────────────────────────────

app.all("/mcp", async (c) => (await requireToken(c, null)) ?? handleMcp(c));
app.all("/mcp/:token", async (c) => (await requireToken(c, c.req.param("token"))) ?? handleMcp(c));

app.all("*", (c) => c.text("Not found", 404));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(cleanup(env).then((n) => console.log(`cleanup: deleted ${n} captures`)));
  },
};
