# Peek

Lets Claude see web pages from anywhere, including cloud sessions where no computer or Chrome is attached. Peek is a remote MCP server at **https://peek.nradix.com** that opens a URL in a real browser ([Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/)) and returns a screenshot, the page as Markdown, or a PDF.

Uses: showcase screenshots for nradix.com, checking preview deploys, and confirming that a fix actually shows up on the page.

## Tools

| Tool | What it returns |
| --- | --- |
| `peek_screenshot` | The image inline, plus a link. `viewport`: `desktop` 1440x900, `laptop` 1280x800, `tablet` 820x1180 @2x, `mobile` 390x844 @2x, or `custom` (`width`, `height`). Options: `full_page`, `element` (CSS selector), `wait_for` (selector), `wait_ms`, `format` (png/jpeg), `scale`, `fresh`. |
| `peek_snapshot` | Screenshot + the page as Markdown + its accessibility tree in one call, plus final URL, HTTP status and title. `max_chars` caps the text. |
| `peek_pdf` | A link to the page rendered as a PDF (`paper` letter/a4, `landscape`). |

Images too large for Claude to view inline (over ~3.75 MB or 7900 px on a side, e.g. very long full-page shots) come back as a link with a hint to retry smaller.

Every capture is stored in R2 under an unguessable 24-character id and served at `/s/<id>.png|jpg|pdf` until the hourly cron deletes it (`SHOT_TTL_HOURS`, default 72). To share one more durably, hand the link to Plonk (`plonk_create` with `image_urls`).

Identical requests within `CACHE_TTL_SECONDS` (default 300) reuse the stored capture instead of starting the browser again. Pass `fresh: true` to recapture, e.g. right after a deploy.

## Security

- **Auth:** one secret, `PEEK_TOKEN` (24+ characters), as `Authorization: Bearer <token>` or in the path (`/mcp/<token>`) for Claude custom connectors. Peek refuses to serve MCP or the API until it's set. Failed attempts are rate limited per IP. Invocation logs are off so tokens in paths aren't logged.
- **Public pages only.** Before any browser work Peek refuses non-http(s) schemes, embedded credentials, `localhost`, internal-only names (`.local`, `.internal`, `.lan`, `.home.arpa`, single-label hosts, cloud metadata names), and private, loopback, link-local, CGNAT, reserved and IPv6 tunnel addresses in any spelling (`2130706433`, `0x7f000001`, `[::ffff:127.0.0.1]`...). It then resolves the hostname over DNS-over-HTTPS and refuses it if any A/AAAA record is private, so `127.0.0.1.nip.io` is refused too.
- **Inside the browser:** every request the page makes, including redirects and subresources, goes through Browser Run's `rejectRequestPattern` with the same private-IP and internal-name patterns, and `peek_snapshot` re-checks the final URL. (DNS rebinding of a public name to a private address mid-load can't be fully ruled out, but Browser Run's browsers run on Cloudflare's network, not yours.)
- **Cost cap:** `BROWSER_LIMITER` allows 20 browser launches a minute; cache hits don't count. Navigation times out at 30 s; waits are capped at 10 s.
- **Untrusted content:** the server instructions tell Claude that page text, Markdown, accessibility names and anything in a screenshot are data, not instructions. Snapshot text is wrapped in `<untrusted_page_content>` tags.

### Your own Access-protected previews

Set `OWNER_DOMAINS` (default `nradix.com`) and the secrets `ACCESS_CLIENT_ID` / `ACCESS_CLIENT_SECRET` from a Cloudflare Access **service token**. Credentials are never taken from tool arguments and are only used for hosts in `OWNER_DOMAINS` (exact domain or subdomain):

1. Peek calls the host once with the service token. If Access answers with a `CF_Authorization` cookie, the browser gets that cookie for that host only.
2. If the host isn't behind Access, nothing extra is sent.
3. If Access is there but issues no cookie, Peek falls back to sending the service-token headers, and restricts the browser to `OWNER_DOMAINS` for that capture, so the token can't reach a third-party host. Third-party assets (fonts, CDNs) won't load in that mode.

The result is cached for 15 minutes per host. To set up: Zero Trust → Access controls → Service credentials → Service Tokens → Create; then on each Access application add a policy with action **Service Auth**, include **Service Token** = that token.

Keep `OWNER_DOMAINS` to domains you control. Never list a shared suffix like `pages.dev` or `workers.dev`; list your exact project hostname instead.

## Deploying (Cloudflare Workers Builds)

Like Plonk, deploys happen in Cloudflare on every push to `main`; no deploy secrets live in GitHub.

1. **Workers & Pages → Create → Import a repository**, pick `RyWhal/PhantomRelay`.
2. Project name **`peek`** (must match `name` in `wrangler.jsonc`). Build command: `npm run build`. Deploy command: `npm run deploy`. Root directory: `/`.
3. The `peek-shots` R2 bucket and the `peek-CACHE` KV namespace (id pinned in `wrangler.jsonc`) already exist. The deploy creates the `peek.nradix.com` custom domain and the cron.
4. Open the `peek` Worker → **Settings → Variables and Secrets → Add**, type **Secret**, name `PEEK_TOKEN`, value from `openssl rand -hex 32`. Optionally add `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET`.

Browser Run needs the Workers Paid plan for real use: it includes 10 browser hours a month, then $0.09/hour. A screenshot takes a few seconds, so thousands a month fit in the included time. The free plan allows 10 minutes a day.

Optional, as a backstop to the cron: an R2 lifecycle rule, `npx wrangler r2 bucket lifecycle add peek-shots expire-captures --expire-days 4`.

## Connecting Claude

- **Claude (web, desktop, mobile):** Settings → Connectors → Add custom connector. Name `Peek`, URL `https://peek.nradix.com/mcp/<PEEK_TOKEN>`. Leave the OAuth fields empty.
- **Claude Code:**
  ```
  claude mcp add --transport http peek https://peek.nradix.com/mcp --header "Authorization: Bearer <PEEK_TOKEN>"
  ```

Treat the connector URL like a password. To rotate, change the secret and update the connector.

There's also a plain HTTP endpoint for scripts: `GET /api/screenshot?url=...&viewport=mobile&full_page=1` with the bearer token returns the image (link in the `X-Peek-Link` header).

## Local development

```
npm install
printf 'PEEK_TOKEN=test-peek-token-0123456789abcdef\nPUBLIC_URL=http://localhost:8787\n' > .dev.vars
npm run dev            # Worker on http://localhost:8787 (Wrangler runs a local Chrome for the browser binding)
npm test               # unit tests (URL guard, block patterns, helpers)
npm run test:e2e       # in another terminal: auth, refusals and routing against :8787
```

Add `"remote": true` to the `browser` binding to use the real Browser Run from `wrangler dev`.

```
src/index.ts      routes: landing page, /mcp, /api/screenshot, /s/<file>, cron cleanup
src/mcp.ts        MCP server (stateless JSON-RPC over Streamable HTTP), tools, instructions
src/capture.ts    Browser Run calls, viewports, KV cache, R2 storage, cleanup
src/urlguard.ts   which URLs may be opened (syntax, DNS, in-browser block patterns)
src/access.ts     Cloudflare Access service-token handling for your own domains
```

## Later

- Cloudflare's Playwright MCP on Browser Run for click-through flows (e.g. testing a checkout).
- OAuth on the MCP endpoint instead of a token in the URL.
