/**
 * Location ingest and the /locate PWA.
 *
 *   POST /api/location   public listener (OwnTracks) and private listener (PWA); per-device token:
 *                        Authorization: Bearer gdt_...   or   Basic <any user>:<gdt_...> (OwnTracks)
 *                        Body: OwnTracks JSON ({_type:"location", lat, lon, acc, tst, batt, vel})
 *                              or the PWA's {lat, lon, accuracy, timestamp}. Responds [] (OwnTracks).
 *   GET  /locate/        owner-only page (tailnet); static shell + service worker
 *   POST /locate/claim   owner-only; exchanges a one-time setup code for a device token
 */
import path from 'node:path';
import express, { type Express, type Request, type Response } from 'express';
import type { AppContext } from '../app.js';
import type { Audit } from '../audit.js';
import type { Login } from '../auth/login.js';
import type { Config } from '../config.js';
import { ipOf, pageHeaders, rateLimit, sameOriginPost } from '../http/security.js';
import type { Logger } from '../log.js';
import { isValidLatLon } from '../util/geo.js';
import { rateKeyIp } from '../util/net.js';
import type { Fix, LocationStore } from './store.js';

export interface LocationDeps {
  config: Config;
  locations: LocationStore;
  audit: Audit;
  logger: Logger;
  webRoot: string;
  now: () => number;
}

export type ParsedFix = Omit<Fix, 'deviceId'>;

const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : undefined;

/** Parses one location payload. Returns null for non-location OwnTracks messages, or an error string. */
export function parseLocation(body: unknown, now: number): ParsedFix | null | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  const b = body as Record<string, unknown>;
  const owntracks = typeof b._type === 'string';
  if (owntracks && b._type !== 'location') return null; // transition, waypoint, lwt, status, ... ignored
  const lat = num(b.lat ?? b.latitude);
  const lon = num(b.lon ?? b.lng ?? b.longitude);
  if (!isValidLatLon(lat, lon)) return 'lat/lon missing or out of range';
  const acc = num(owntracks ? b.acc : (b.accuracy ?? b.accuracy_m ?? b.acc));
  if (acc !== undefined && (acc < 0 || acc > 100_000)) return 'accuracy out of range';
  let ts: number;
  if (owntracks) {
    const tst = num(b.tst);
    if (tst === undefined) return 'tst missing';
    ts = tst * 1000;
  } else {
    const t = num(b.timestamp ?? b.ts);
    ts = t === undefined ? now : t < 1e11 ? t * 1000 : t; // seconds or ms
  }
  if (ts < now - 7 * 86_400_000 || ts > now + 10 * 60_000) return 'timestamp out of range';
  const batt = num(b.batt ?? b.battery);
  const vel = num(b.vel ?? b.speed_kmh);
  return {
    lat: lat as number,
    lon: lon as number,
    accuracyM: acc,
    fixTs: Math.round(ts),
    battery: batt !== undefined && batt >= 0 && batt <= 100 ? Math.round(batt) : undefined,
    speedKmh: vel !== undefined && vel >= 0 && vel <= 1000 ? vel : undefined,
    source: owntracks ? 'owntracks' : 'pwa',
  };
}

export function deviceTokenFrom(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return undefined;
  const bearer = /^Bearer\s+(\S+)$/i.exec(h);
  if (bearer) return bearer[1];
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(h);
  if (basic) {
    const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    return i >= 0 ? decoded.slice(i + 1) : undefined;
  }
  return undefined;
}

/** POST /api/location (public listener for OwnTracks; private listener for the tailnet PWA). */
export function installLocationIngest(app: Express, ctx: AppContext, d: LocationDeps): void {
  const ip = (req: Request) => ipOf(req, ctx.sec);
  const json = express.json({
    limit: '16kb',
    type: ['application/json', 'text/json', 'application/octet-stream'],
  });

  app.post(
    '/api/location',
    rateLimit(ctx.limiter, 'loc-ip', 300, 60_000, ip),
    (req: Request, res: Response, next) => {
      const token = deviceTokenFrom(req);
      const device = token ? d.locations.verifyDeviceToken(token) : null;
      if (!device) {
        const r = ctx.limiter.hit(`loc-auth-fail:${rateKeyIp(ip(req))}`, 20, 15 * 60_000);
        if (!r.ok) {
          res
            .status(429)
            .set('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)))
            .json({ error: 'rate_limited' });
          return;
        }
        res
          .status(401)
          .set('WWW-Authenticate', 'Basic realm="godseye-location", charset="UTF-8"')
          .json({ error: 'unauthorized' });
        return;
      }
      res.locals.device = device;
      next();
    },
    (req, res, next) => {
      const r = ctx.limiter.hit(`loc-dev:${res.locals.device.id}`, 120, 60_000);
      if (!r.ok) {
        res.status(429).json({ error: 'rate_limited' });
        return;
      }
      next();
    },
    json,
    (req, res) => {
      const device = res.locals.device as { id: number; name: string };
      const items = Array.isArray(req.body) ? req.body.slice(0, 50) : [req.body];
      let stored = 0;
      for (const item of items) {
        const parsed = parseLocation(item, d.now());
        if (parsed === null) continue;
        if (typeof parsed === 'string') {
          res.status(400).json({ error: 'invalid_location', error_description: parsed });
          return;
        }
        d.locations.insert({ ...parsed, deviceId: device.id });
        stored++;
        d.logger.debug('location_fix', {
          device: device.name,
          source: parsed.source,
          acc: parsed.accuracyM,
          lat: parsed.lat,
          lon: parsed.lon,
        });
      }
      if (stored) d.logger.info('location_stored', { device: device.name, fixes: stored });
      // OwnTracks expects a JSON array (of cards/commands); we send none.
      res.status(200).type('application/json').send('[]');
    },
  );
}

/** /locate PWA and its setup-code claim (private listener only). */
export function installLocate(app: Express, ctx: AppContext, d: LocationDeps, login: Login): void {
  const ip = (req: Request) => ipOf(req, ctx.sec);
  const owner = login.require();
  const locateDir = path.join(d.webRoot, 'locate');
  // Exact /locate only (Express' non-strict routing would also match /locate/).
  app.use((req, res, next) =>
    req.method === 'GET' && req.originalUrl.split('?')[0] === '/locate'
      ? res.redirect(301, '/locate/')
      : next(),
  );
  app.post(
    '/locate/claim',
    rateLimit(ctx.limiter, 'claim', 10, 15 * 60_000, ip),
    owner,
    express.json({ limit: '2kb' }),
    (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!sameOriginPost(ctx.sec, req) || req.headers['x-requested-with'] !== 'godseye-locate') {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      const claimed = d.locations.claimSetupCode(code);
      if (!claimed) {
        d.audit.record('device_claim_failed', { ip: ip(req), subject: req.owner!.subject });
        res.status(400).json({ error: 'invalid_or_expired_code' });
        return;
      }
      d.audit.record('device_claimed', {
        ip: ip(req),
        subject: req.owner!.subject,
        detail: { device: claimed.name },
      });
      res.json({ device_token: claimed.token, device_name: claimed.name });
    },
  );
  app.use(
    '/locate/',
    owner,
    (_req, res, next) => {
      pageHeaders(res);
      res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
      res.setHeader('Service-Worker-Allowed', '/locate/');
      next();
    },
    express.static(locateDir, {
      index: 'index.html',
      dotfiles: 'deny',
      fallthrough: false,
      cacheControl: false,
    }),
  );
}
