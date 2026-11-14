# Phone location setup

Claude's `where_am_i` and `whats_happening_here` use the **latest** fix any of your devices posted
to `https://godseye.gamachecloud.com/api/location`. Only that one fix is ever shown to Claude.
Fixes older than `LOCATION_RETENTION_HOURS` (default 24 h) are deleted every 10 minutes, and logs
round coordinates to 2 decimals (about 1 km).

Each device has its own revocable token (stored hashed). Use one device entry per app, because
claiming a PWA setup link re-keys that device.

```sh
cd ~/projects/godseye/godseye-detroit-connector
npm run build
npm run devices -- add iphone-owntracks          # prints a token once (for OwnTracks)
npm run devices -- add iphone-pwa --pwa          # prints a one-time setup link (15 min)
npm run devices -- list
npm run devices -- revoke iphone-owntracks       # also deletes that device's stored fixes
```

Docker mode: `docker exec -it godseye-gateway node dist/scripts/devices.js add iphone-owntracks`.

The `--pwa` setup link uses `PRIVATE_ORIGIN` (your tailnet URL).

## Option A: OwnTracks (background, recommended for driving)

OwnTracks is free and open source (iOS and Android). Use **HTTP mode**, not MQTT.

### iPhone

1. Install OwnTracks from the App Store and allow location **Always** (Settings, OwnTracks,
   Location: Always; Precise Location on).
2. In OwnTracks, tap (i) then **Settings**:
   * **Mode**: HTTP
   * **URL**: `https://godseye.gamachecloud.com/api/location`
   * **Authentication**: on. **UserID**: the device name (e.g. `iphone-owntracks`).
     **Password**: the token printed by `npm run devices -- add`.
   * **Device ID / Tracker ID**: anything short (e.g. `np`).
3. Pick a monitoring mode on the map screen (the arrow icon):
   * **Significant changes**: iOS wakes OwnTracks after moves of roughly 500 m or every few
     minutes. Very light on battery; a fix may be several minutes old. Good default.
   * **Move**: continuous GPS updates while moving (OwnTracks' `locatorInterval` and
     `locatorDisplacement` settings control how often). Best while driving or when you want
     `whats_happening_here` to be current; uses noticeably more battery. Switch back afterwards.
   * **Manual**: only when you tap publish.
4. Tap the publish (upload) button once and confirm the gateway answered: `npm run devices -- list`
   shows a recent `last fix`.

The gateway replies `[]` to every post, which OwnTracks treats as success. Non-location messages
(transitions, waypoints, status) are accepted and ignored.

### Android

1. Install OwnTracks (Google Play or F-Droid). Grant location **Allow all the time**, and exempt
   it from battery optimization so Android doesn't kill it.
2. **Preferences, Connection**:
   * **Mode**: HTTP
   * **Host / URL**: `https://godseye.gamachecloud.com/api/location`
   * **Identification**: Username = device name, Password = device token, Device ID = anything.
3. **Monitoring mode** (the top-bar icon cycles it): *Significant* for everyday use, *Move* while
   driving (set **Preferences, Advanced, Locator interval** to e.g. 30 s and displacement to
   50 m for driving).
4. Use **Publish location now** from the menu to test.

## Option B: the /locate web app (no install, foreground only; needs Tailscale)

The page lives on the private listener, so the phone must be on your tailnet (Tailscale app
connected). It opens at `https://godseye.<tailnet>.ts.net/locate/` and posts fixes to the same
host. OwnTracks (option A) needs no Tailscale: it posts to the public `/api/location`.

1. Run `npm run devices -- add iphone-pwa --pwa` and open the printed link on the phone within
   15 minutes. Tailscale identifies you (no password). The link is single use: the page exchanges
   it for a device token and keeps that token in the browser's local storage.
2. Tap **Update My Location**. Allow location access for the site. The page shows the fix it sent
   and its accuracy.
3. Optional: tick **Keep updating while this page is open** (sends at most every 30 s or after
   moving 25 m). Browsers stop this when the page is in the background or the screen locks.
4. Install it: Safari, Share, **Add to Home Screen** (iOS), or Chrome's **Install app** (Android).
   The service worker caches only the page shell and icon, so the button still opens offline;
   sending needs a connection.

If you clear the site's data, run the `--pwa` command again for a new link.

## Option C: iOS Shortcuts (documented, not set up)

A Shortcut can post a fix on a trigger (for example, when CarPlay connects):

1. New Shortcut: **Get Current Location**.
2. **Get Contents of URL**: `https://godseye.gamachecloud.com/api/location`, Method **POST**,
   Headers `Authorization: Bearer <device token>` and `Content-Type: application/json`,
   Request Body **JSON** with `lat` = Latitude, `lon` = Longitude, `accuracy` = Horizontal
   Accuracy (all from Current Location).
3. Automation tab: create a personal automation (CarPlay connect, arrive/leave, time of day)
   that runs it, with **Ask Before Running** off.

Use a separate device entry (e.g. `iphone-shortcut`) so it can be revoked on its own. The token
is stored inside the Shortcut, so don't share that Shortcut.

## Lost or stolen phone

Revoke its devices immediately (`npm run devices -- revoke <name>`, or the **Location devices**
table on `/oauth/admin`). Revocation also deletes that device's stored fixes. Also remove the
claude.ai connector session from that phone's Claude app if it was signed in.
