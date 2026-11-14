/** Server-rendered HTML helpers. No inline scripts or styles (strict CSP). */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The two tailnet origins: the UIs (globe, Pulse) and the owner pages (locate, admin). */
export interface NavOrigins {
  ui: string;
  auth: string;
}

export const navFor = (c: { uiOrigin: string; privateOrigin: string }): NavOrigins => ({
  ui: c.uiOrigin,
  auth: c.privateOrigin,
});

export function page(title: string, body: string, opts: { nav?: NavOrigins } = {}): string {
  const n = opts.nav;
  const nav = n
    ? `<nav class="gw-nav"><a href="${esc(n.ui)}/">Globe</a><a href="${esc(n.ui)}/pulse/">Pulse</a><a href="${esc(n.auth)}/locate/">Locate</a><a href="${esc(n.auth)}/oauth/admin">Admin</a></nav>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/gw/static/app.css">
</head>
<body>
${nav}
<main class="gw-main">
${body}
</main>
</body>
</html>`;
}
