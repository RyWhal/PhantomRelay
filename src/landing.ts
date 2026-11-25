/** The public page at /. Explains Peek; never shows a token. */
export const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Peek</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23111827'/%3E%3Ccircle cx='16' cy='16' r='6' fill='none' stroke='%23fbbf24' stroke-width='3'/%3E%3C/svg%3E">
<style>
  :root { --bg: #fafaf9; --fg: #1c1917; --muted: #57534e; --card: #ffffff; --line: #e7e5e4; --accent: #b45309; --code: #f5f5f4; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0c0a09; --fg: #f5f5f4; --muted: #a8a29e; --card: #1c1917; --line: #292524; --accent: #fbbf24; --code: #292524; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 680px; margin: 0 auto; padding: 56px 16px 72px; }
  h1 { font-size: 2.25rem; margin: 0 0 4px; letter-spacing: -0.02em; display: flex; align-items: center; gap: 12px; }
  h1 .dot { width: 18px; height: 18px; border-radius: 50%; border: 4px solid var(--accent); display: inline-block; }
  .lede { color: var(--muted); margin: 0 0 32px; font-size: 1.1rem; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 36px 0 12px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px 20px; }
  ul { padding-left: 20px; margin: 0; }
  li { margin: 6px 0; }
  code { background: var(--code); border-radius: 6px; padding: 1px 6px; font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  pre { background: var(--code); border-radius: 8px; padding: 12px 14px; overflow-x: auto; font: 0.85rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 8px 0 0; }
  .muted { color: var(--muted); font-size: 0.95rem; }
  footer { margin-top: 48px; color: var(--muted); font-size: 0.85rem; }
</style>
</head>
<body>
<main>
  <h1><span class="dot" aria-hidden="true"></span>Peek</h1>
  <p class="lede">Lets Claude see web pages. Peek opens a URL in a real browser on Cloudflare and hands back a screenshot, the page as Markdown, or a PDF.</p>

  <h2>Tools</h2>
  <div class="card">
    <ul>
      <li><code>peek_screenshot</code>: desktop, laptop, tablet, mobile or a custom viewport; full page or a single element.</li>
      <li><code>peek_snapshot</code>: screenshot, Markdown and accessibility tree in one call.</li>
      <li><code>peek_pdf</code>: the page as a PDF link.</li>
    </ul>
  </div>

  <h2>Connect Claude</h2>
  <div class="card">
    <p style="margin-top:0"><strong>Claude (web, desktop, mobile):</strong> Settings → Connectors → Add custom connector. Name <code>Peek</code>, URL:</p>
    <pre>{{ORIGIN}}/mcp/&lt;PEEK_TOKEN&gt;</pre>
    <p><strong>Claude Code:</strong></p>
    <pre>claude mcp add --transport http peek {{ORIGIN}}/mcp \\
  --header "Authorization: Bearer &lt;PEEK_TOKEN&gt;"</pre>
    <p class="muted" style="margin-bottom:0">The token is a Worker secret. Treat the connector URL like a password.</p>
  </div>

  <h2>Limits</h2>
  <div class="card">
    <ul>
      <li>Public http(s) pages only. Localhost, private networks, cloud metadata and internal names are refused.</li>
      <li>Captures are kept for a few days, then deleted. Identical requests within a few minutes reuse the last capture.</li>
      <li>Browser launches are rate limited.</li>
    </ul>
  </div>

  <footer>Runs on Cloudflare Workers + Browser Run.</footer>
</main>
</body>
</html>`;
