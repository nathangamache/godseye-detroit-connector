/** Server-rendered HTML helpers. No inline scripts or styles (strict CSP). */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function page(title: string, body: string, opts: { nav?: boolean } = {}): string {
  const nav = opts.nav
    ? `<nav class="gw-nav"><a href="/">Globe</a><a href="/pulse/">Pulse</a><a href="/locate">Locate</a><a href="/oauth/admin">Admin</a></nav>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
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
