import type { Request, Response } from 'express';

export function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function setCookie(res: Response, name: string, value: string, opts: { secure: boolean; maxAgeS?: number }): void {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (opts.secure) parts.push('Secure');
  if (opts.maxAgeS !== undefined) parts.push(`Max-Age=${opts.maxAgeS}`);
  res.append('Set-Cookie', parts.join('; '));
}

export function clearCookie(res: Response, name: string, secure: boolean): void {
  setCookie(res, name, '', { secure, maxAgeS: 0 });
}

/** Removes the named cookies from a Cookie header (used before proxying). */
export function stripCookies(header: string | undefined, names: Set<string>): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !names.has(p.split('=')[0]!.trim()));
  return kept.length ? kept.join('; ') : undefined;
}
