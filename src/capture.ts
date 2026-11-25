/**
 * Captures pages with Browser Run Quick Actions and stores the results in R2.
 * Identical requests within CACHE_TTL_SECONDS reuse the stored capture (KV
 * maps a hash of the request to it), so repeat calls don't spend browser time.
 */
import { accessPlan } from "./access.ts";
import type { Bindings } from "./env.ts";
import { BLOCK_PATTERNS, checkDns, checkUrl, UrlRefused } from "./urlguard.ts";
import { base64Decode, EXT, HttpError, imageSize, randomId, sha256Hex, sniffType } from "./util.ts";

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, scale: 1, mobile: false },
  laptop: { width: 1280, height: 800, scale: 1, mobile: false },
  tablet: { width: 820, height: 1180, scale: 2, mobile: true },
  mobile: { width: 390, height: 844, scale: 2, mobile: true },
} as const;
export type ViewportName = keyof typeof VIEWPORTS | "custom";
export const VIEWPORT_NAMES = [...Object.keys(VIEWPORTS), "custom"] as ViewportName[];

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

const NAV_TIMEOUT_MS = 30_000;
const MAX_WAIT_MS = 10_000;

export interface CaptureRequest {
  url: string;
  viewport: ViewportName;
  width?: number;
  height?: number;
  scale?: number;
  fullPage: boolean;
  element?: string;
  waitFor?: string;
  waitMs: number;
  format: "png" | "jpeg";
  fresh: boolean;
}

export interface StoredFile {
  id: string;
  key: string;
  link: string;
  contentType: string;
  bytes: number;
}

export interface ScreenshotResult extends StoredFile {
  data: Uint8Array;
  width: number | null;
  height: number | null;
  viewport: { name: ViewportName; width: number; height: number; scale: number };
  cached: boolean;
  capturedAt: string;
  browserMs: number | null;
  accessMode: "cookie" | "headers" | null;
}

export interface SnapshotResult {
  screenshot: ScreenshotResult | null;
  markdown: string;
  accessibility: string;
  title: string;
  status: number | null;
  finalUrl: string;
  cached: boolean;
  capturedAt: string;
  browserMs: number | null;
}

// ── argument parsing ────────────────────────────────────────────────────────

function int(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  return Math.round(n);
}

function selector(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 500) throw new HttpError(400, `${name} must be a CSS selector`);
  return value;
}

function bool(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

export function parseCaptureArgs(args: Record<string, unknown>): CaptureRequest {
  const viewport = (args.viewport ?? "desktop") as ViewportName;
  if (!VIEWPORT_NAMES.includes(viewport)) {
    throw new HttpError(400, `viewport must be one of ${VIEWPORT_NAMES.join(", ")}`);
  }
  const width = int(args.width, "width", 240, 3840);
  const height = int(args.height, "height", 240, 4320);
  if (viewport === "custom" && (!width || !height)) throw new HttpError(400, "custom viewport needs width and height");
  const fullPage = bool(args.full_page);
  const format = args.format ?? (fullPage ? "jpeg" : "png");
  if (format !== "png" && format !== "jpeg") throw new HttpError(400, "format must be png or jpeg");
  if (typeof args.url !== "string") throw new HttpError(400, "url is required");
  return {
    url: args.url,
    viewport,
    width,
    height,
    scale: int(args.scale, "scale", 1, 3),
    fullPage,
    element: selector(args.element, "element"),
    waitFor: selector(args.wait_for, "wait_for"),
    waitMs: int(args.wait_ms, "wait_ms", 0, MAX_WAIT_MS) ?? 0,
    format,
    fresh: bool(args.fresh),
  };
}

function resolveViewport(req: CaptureRequest) {
  const preset = req.viewport === "custom" ? null : VIEWPORTS[req.viewport];
  const width = req.width ?? preset?.width ?? 1440;
  const height = req.height ?? preset?.height ?? 900;
  const mobile = preset?.mobile ?? width < 768;
  // Full-page captures of tall mobile pages get huge at 2x; default to 1x for those.
  const scale = req.scale ?? (req.fullPage ? 1 : (preset?.scale ?? 1));
  return { name: req.viewport, width, height, scale, mobile };
}

// ── shared helpers ──────────────────────────────────────────────────────────

/** Validate the URL (syntax, then DNS). Throws HttpError(400) when refused. */
export async function guard(rawUrl: string): Promise<URL> {
  try {
    const url = checkUrl(rawUrl);
    await checkDns(url);
    return url;
  } catch (err) {
    if (err instanceof UrlRefused) throw new HttpError(400, `Refused: ${err.message}`);
    throw err;
  }
}

/** The landing URL after redirects must pass the same syntax checks. */
function guardFinalUrl(finalUrl: string | undefined) {
  if (!finalUrl) return;
  try {
    checkUrl(finalUrl);
  } catch (err) {
    if (err instanceof UrlRefused) throw new HttpError(400, `Refused: the page redirected to a blocked address (${err.message})`);
    throw err;
  }
}

export function ttlHours(env: Bindings): number {
  const n = Number(env.SHOT_TTL_HOURS ?? 72);
  return Number.isFinite(n) && n > 0 ? n : 72;
}

function cacheTtl(env: Bindings): number {
  const n = Number(env.CACHE_TTL_SECONDS ?? 300);
  return Number.isFinite(n) ? Math.max(60, Math.min(n, 3600)) : 300;
}

async function allowBrowser(env: Bindings): Promise<void> {
  if (!env.BROWSER_LIMITER) return;
  let ok = true;
  try {
    ok = (await env.BROWSER_LIMITER.limit({ key: "browser" })).success;
  } catch {
    ok = true;
  }
  if (!ok) throw new HttpError(429, "Peek is rate limited right now. Try again in a minute.");
}

async function browserError(res: Response, what: string): Promise<HttpError> {
  let detail = "";
  try {
    const body = (await res.json()) as { errors?: Array<{ message?: string; detail?: string }> };
    detail = (body.errors ?? []).map((e) => [e.message, e.detail].filter(Boolean).join(": ")).join("; ");
  } catch {
    detail = "";
  }
  if (res.status === 429) return new HttpError(429, "Browser Run is rate limited right now (the free plan allows one capture every 10 seconds and 10 minutes a day). Try again shortly.");
  const status = res.status >= 500 ? 502 : 422;
  return new HttpError(status, `Could not ${what} (${res.status})${detail ? `: ${detail.slice(0, 500)}` : ""}`);
}

/** Wait before the one retry after a 429 (the free plan allows one request every 10 seconds). */
const RETRY_AFTER_429_MS = 10_500;

/**
 * Run a quick action, retrying once after a short wait if Browser Run answers
 * 429, so back-to-back calls (desktop then mobile) don't fail.
 */
async function runAction(env: Bindings, action: "screenshot" | "snapshot" | "pdf", options: Record<string, unknown>): Promise<Response> {
  const call = () => {
    switch (action) {
      case "screenshot":
        return env.BROWSER.quickAction("screenshot", options as unknown as BrowserRunScreenshotOptions);
      case "snapshot":
        return env.BROWSER.quickAction("snapshot", options as unknown as BrowserRunSnapshotOptions);
      case "pdf":
        return env.BROWSER.quickAction("pdf", options as unknown as BrowserRunPDFOptions);
    }
  };
  const first = await call();
  if (first.status !== 429) return first;
  await first.body?.cancel();
  await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_429_MS));
  return call();
}

function msUsed(res: Response): number | null {
  const v = Number(res.headers.get("X-Browser-Ms-Used"));
  return Number.isFinite(v) && v > 0 ? v : null;
}

export async function store(
  env: Bindings,
  origin: string,
  data: Uint8Array,
  meta: Record<string, string>
): Promise<StoredFile> {
  const contentType = sniffType(data);
  if (!contentType) throw new HttpError(502, "Browser Run returned something that isn't an image or PDF");
  const id = randomId(24);
  const key = `${id}.${EXT[contentType]}`;
  await env.SHOTS.put(key, data, {
    httpMetadata: { contentType },
    customMetadata: { ...meta, capturedAt: new Date().toISOString() },
  });
  return { id, key, link: `${origin}/s/${key}`, contentType, bytes: data.byteLength };
}

/** Options every quick action gets: navigation, waits, request blocking, Access. */
async function baseOptions(env: Bindings, url: URL, req: Pick<CaptureRequest, "waitFor" | "waitMs">, vp?: ReturnType<typeof resolveViewport>) {
  const access = await accessPlan(env, url);
  const options: Record<string, unknown> = {
    url: url.toString(),
    gotoOptions: { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS },
    bestAttempt: true,
    cacheTTL: 0,
  };
  if (vp) {
    options.viewport = {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.scale,
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
    };
    if (vp.mobile) options.userAgent = MOBILE_UA;
  }
  if (req.waitFor) options.waitForSelector = { selector: req.waitFor, visible: true, timeout: 15_000 };
  if (req.waitMs) options.waitForTimeout = req.waitMs;
  if (access?.allowRequestPattern) {
    options.allowRequestPattern = access.allowRequestPattern;
  } else {
    options.rejectRequestPattern = BLOCK_PATTERNS;
  }
  if (access?.cookies) options.cookies = access.cookies;
  if (access?.headers) options.setExtraHTTPHeaders = access.headers;
  return { options, accessMode: access?.mode ?? null };
}

// ── screenshot ──────────────────────────────────────────────────────────────

interface CachedShot {
  key: string;
  contentType: string;
  width: number | null;
  height: number | null;
  viewport: ScreenshotResult["viewport"];
  capturedAt: string;
  accessMode: ScreenshotResult["accessMode"];
}

/** A cached capture, or null if its file is gone from R2. */
async function loadCached(env: Bindings, origin: string, shot: CachedShot): Promise<ScreenshotResult | null> {
  const obj = await env.SHOTS.get(shot.key);
  if (!obj) return null;
  const data = new Uint8Array(await obj.arrayBuffer());
  return {
    ...shot,
    id: shot.key.split(".")[0],
    link: `${origin}/s/${shot.key}`,
    bytes: data.byteLength,
    data,
    cached: true,
    browserMs: 0,
  };
}

export async function screenshot(env: Bindings, origin: string, req: CaptureRequest): Promise<ScreenshotResult> {
  const url = await guard(req.url);
  const vp = resolveViewport(req);
  const cacheKey = `shot:${await sha256Hex(JSON.stringify({ u: url.toString(), vp, f: req.fullPage, e: req.element, w: req.waitFor, m: req.waitMs, t: req.format }))}`;

  if (!req.fresh) {
    const hit = await env.CACHE.get<CachedShot>(cacheKey, "json");
    const found = hit && (await loadCached(env, origin, hit));
    if (found) return found;
  }

  await allowBrowser(env);
  const { options, accessMode } = await baseOptions(env, url, req, vp);
  options.screenshotOptions = {
    type: req.format,
    fullPage: req.fullPage,
    ...(req.format === "jpeg" ? { quality: 80 } : {}),
  };
  if (req.element) options.selector = req.element;

  const res = await runAction(env, "screenshot", options);
  if (!res.ok) throw await browserError(res, `screenshot ${url.host}`);
  const browserMs = msUsed(res);
  let data: Uint8Array = new Uint8Array(await res.arrayBuffer());
  if (!sniffType(data) && (res.headers.get("Content-Type") ?? "").startsWith("text/plain")) {
    data = base64Decode(new TextDecoder().decode(data)); // base64 encoding fallback
  }
  const size = imageSize(data);
  const stored = await store(env, origin, data, { url: url.toString(), viewport: vp.name, kind: "screenshot" });
  const capturedAt = new Date().toISOString();
  const viewport = { name: vp.name, width: vp.width, height: vp.height, scale: vp.scale };
  const cached: CachedShot = {
    key: stored.key,
    contentType: stored.contentType,
    width: size?.width ?? null,
    height: size?.height ?? null,
    viewport,
    capturedAt,
    accessMode,
  };
  await env.CACHE.put(cacheKey, JSON.stringify(cached), { expirationTtl: cacheTtl(env) });
  return { ...stored, ...cached, data, cached: false, browserMs };
}

// ── snapshot (screenshot + Markdown + accessibility tree) ───────────────────

export interface SnapshotRequest extends Pick<CaptureRequest, "url" | "viewport" | "width" | "height" | "scale" | "waitFor" | "waitMs" | "fresh"> {
  includeScreenshot: boolean;
  maxChars: number;
}

export function parseSnapshotArgs(args: Record<string, unknown>): SnapshotRequest {
  const base = parseCaptureArgs({ ...args, full_page: false, format: "png", element: undefined });
  return {
    url: base.url,
    viewport: base.viewport,
    width: base.width,
    height: base.height,
    scale: base.scale,
    waitFor: base.waitFor,
    waitMs: base.waitMs,
    fresh: base.fresh,
    includeScreenshot: args.include_screenshot !== false,
    maxChars: int(args.max_chars, "max_chars", 1000, 100_000) ?? 20_000,
  };
}

/** Render the accessibility tree as an indented outline: `role "name" [state]`. */
export function outlineTree(node: BrowserRunSerializedAXNode | null | undefined, maxChars: number): string {
  if (!node) return "(no accessibility tree)";
  const lines: string[] = [];
  let used = 0;
  let truncated = false;
  const walk = (n: BrowserRunSerializedAXNode, depth: number, parentName = "") => {
    if (truncated) return;
    // Text runs that only repeat their parent's accessible name are noise.
    const isText = n.role === "StaticText" || n.role === "InlineTextBox";
    if (isText && !n.children?.length && (!n.name || parentName.includes(n.name))) return;
    const bits = [n.role];
    if (n.name) bits.push(JSON.stringify(n.name.length > 200 ? `${n.name.slice(0, 200)}…` : n.name));
    if (n.level) bits.push(`level=${n.level}`);
    if (n.value !== undefined && n.value !== "") bits.push(`value=${JSON.stringify(String(n.value).slice(0, 100))}`);
    for (const flag of ["checked", "disabled", "expanded", "focused", "pressed", "selected", "required"] as const) {
      if (n[flag] !== undefined && n[flag] !== false) bits.push(n[flag] === true ? flag : `${flag}=${n[flag]}`);
    }
    const line = `${"  ".repeat(depth)}${bits.join(" ")}`;
    used += line.length + 1;
    if (used > maxChars) {
      truncated = true;
      return;
    }
    lines.push(line);
    for (const child of n.children ?? []) walk(child, depth + 1, n.name ?? "");
  };
  walk(node, 0);
  if (truncated) lines.push(`… (truncated at ${maxChars} characters)`);
  return lines.join("\n");
}

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n… (truncated at ${maxChars} of ${text.length} characters)` : text;
}

interface CachedSnapshot extends Omit<SnapshotResult, "screenshot" | "cached" | "browserMs"> {
  shot: CachedShot | null;
}

export async function snapshot(env: Bindings, origin: string, req: SnapshotRequest): Promise<SnapshotResult> {
  const url = await guard(req.url);
  const vp = resolveViewport({ ...req, fullPage: false, format: "png" });
  const cacheKey = `snap:${await sha256Hex(JSON.stringify({ u: url.toString(), vp, w: req.waitFor, m: req.waitMs, s: req.includeScreenshot, c: req.maxChars }))}`;

  if (!req.fresh) {
    const hit = await env.CACHE.get<CachedSnapshot>(cacheKey, "json");
    if (hit) {
      const { shot, ...rest } = hit;
      const screenshot = shot ? await loadCached(env, origin, shot) : null;
      if (screenshot || !shot) return { ...rest, screenshot, cached: true, browserMs: 0 };
    }
  }

  await allowBrowser(env);
  const { options, accessMode } = await baseOptions(env, url, req, vp);
  options.formats = req.includeScreenshot ? ["screenshot", "markdown", "accessibilityTree"] : ["markdown", "accessibilityTree"];
  if (req.includeScreenshot) options.screenshotOptions = { type: "png" };

  const res = await runAction(env, "snapshot", options);
  if (!res.ok) throw await browserError(res, `snapshot ${url.host}`);
  const browserMs = msUsed(res);
  const body = (await res.json()) as BrowserRunSnapshotSuccessResponse | BrowserRunErrorResponse;
  if (!body.success) {
    throw new HttpError(422, `Could not snapshot ${url.host}: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  guardFinalUrl(body.meta?.finalUrl);

  let shot: CachedShot | null = null;
  let screenshot: ScreenshotResult | null = null;
  if (body.result.screenshot) {
    const data = base64Decode(body.result.screenshot);
    const size = imageSize(data);
    const stored = await store(env, origin, data, { url: url.toString(), viewport: vp.name, kind: "snapshot" });
    shot = {
      key: stored.key,
      contentType: stored.contentType,
      width: size?.width ?? null,
      height: size?.height ?? null,
      viewport: { name: vp.name, width: vp.width, height: vp.height, scale: vp.scale },
      capturedAt: new Date().toISOString(),
      accessMode,
    };
    screenshot = { ...stored, ...shot, data, cached: false, browserMs };
  }

  const fields: Omit<CachedSnapshot, "shot"> = {
    markdown: clip(body.result.markdown ?? "", req.maxChars),
    accessibility: outlineTree(body.result.accessibilityTree, req.maxChars),
    title: body.meta?.title ?? "",
    status: body.meta?.status ?? null,
    finalUrl: body.meta?.finalUrl ?? url.toString(),
    capturedAt: new Date().toISOString(),
  };
  await env.CACHE.put(cacheKey, JSON.stringify({ ...fields, shot }), { expirationTtl: cacheTtl(env) });
  return { ...fields, screenshot, cached: false, browserMs };
}

// ── PDF ─────────────────────────────────────────────────────────────────────

export interface PdfRequest {
  url: string;
  paper: "letter" | "a4";
  landscape: boolean;
  waitFor?: string;
  waitMs: number;
}

export function parsePdfArgs(args: Record<string, unknown>): PdfRequest {
  const paper = args.paper ?? "letter";
  if (paper !== "letter" && paper !== "a4") throw new HttpError(400, "paper must be letter or a4");
  if (typeof args.url !== "string") throw new HttpError(400, "url is required");
  return {
    url: args.url,
    paper,
    landscape: bool(args.landscape),
    waitFor: selector(args.wait_for, "wait_for"),
    waitMs: int(args.wait_ms, "wait_ms", 0, MAX_WAIT_MS) ?? 0,
  };
}

export async function pdf(env: Bindings, origin: string, req: PdfRequest): Promise<StoredFile & { browserMs: number | null }> {
  const url = await guard(req.url);
  await allowBrowser(env);
  const { options } = await baseOptions(env, url, req);
  options.pdfOptions = { format: req.paper, landscape: req.landscape, printBackground: true };
  const res = await runAction(env, "pdf", options);
  if (!res.ok) throw await browserError(res, `render ${url.host} as PDF`);
  const data = new Uint8Array(await res.arrayBuffer());
  const stored = await store(env, origin, data, { url: url.toString(), kind: "pdf" });
  return { ...stored, browserMs: msUsed(res) };
}

// ── cleanup ─────────────────────────────────────────────────────────────────

/** Delete captures older than SHOT_TTL_HOURS. Runs from the cron. */
export async function cleanup(env: Bindings): Promise<number> {
  const cutoff = Date.now() - ttlHours(env) * 3600_000;
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await env.SHOTS.list({ cursor, limit: 1000 });
    const old = page.objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);
    if (old.length) {
      await env.SHOTS.delete(old);
      deleted += old.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}
