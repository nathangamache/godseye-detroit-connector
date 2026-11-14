// /locate PWA. No inline script (strict CSP). The device token lives in localStorage
// and is only ever sent to this origin's /api/location.
(function () {
  'use strict';
  var KEY = 'gw_device_token';
  var statusEl = document.getElementById('status');
  var setupEl = document.getElementById('setup');
  var watchEl = document.getElementById('watch');
  var watchId = null;
  var lastSent = { t: 0, lat: 0, lon: 0 };

  function token() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }
  function say(msg) {
    statusEl.textContent = msg;
  }
  function refreshSetup() {
    setupEl.hidden = Boolean(token());
  }

  function claim(code) {
    say('Setting up this device…');
    return fetch('/locate/claim', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'godseye-locate' },
      body: JSON.stringify({ code: code }),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok || !j.device_token) throw new Error(j.error || 'HTTP ' + r.status);
          localStorage.setItem(KEY, j.device_token);
          say('This phone is set up as "' + j.device_name + '". Tap Update My Location.');
        });
      })
      .catch(function (e) {
        say('Setup failed: ' + e.message + '. Ask for a new setup link.');
      });
  }

  // A setup link opens in the browser; a Home Screen app has its own storage and always
  // starts at /locate/, so it is set up by pasting the link or code instead.
  function codeFrom(text) {
    var m = /(gsc_[A-Za-z0-9_-]+)/.exec(text || '');
    return m ? m[1] : null;
  }

  function claimFromHash() {
    var m = /[#&]setup=(gsc_[A-Za-z0-9_-]+)/.exec(location.hash);
    if (!m) return Promise.resolve();
    history.replaceState(null, '', location.pathname);
    return claim(m[1]);
  }

  function distM(a, b, c, d) {
    var R = 6371000,
      r = Math.PI / 180;
    var x = (d - b) * r * Math.cos(((a + c) / 2) * r),
      y = (c - a) * r;
    return Math.sqrt(x * x + y * y) * R;
  }

  function send(pos, quiet) {
    var t = token();
    if (!t) {
      refreshSetup();
      say('No device token on this phone.');
      return;
    }
    var c = pos.coords;
    var body = {
      lat: c.latitude,
      lon: c.longitude,
      accuracy: c.accuracy,
      timestamp: pos.timestamp,
    };
    if (typeof c.speed === 'number' && c.speed >= 0) body.speed_kmh = c.speed * 3.6;
    return fetch('/api/location', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        if (r.status === 401) {
          say('This device token was revoked. Set the phone up again.');
          localStorage.removeItem(KEY);
          refreshSetup();
          return;
        }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        lastSent = { t: Date.now(), lat: c.latitude, lon: c.longitude };
        var when = new Date(pos.timestamp).toLocaleTimeString();
        say(
          'Sent ' +
            c.latitude.toFixed(5) +
            ', ' +
            c.longitude.toFixed(5) +
            ' (±' +
            Math.round(c.accuracy) +
            ' m) at ' +
            when +
            (quiet ? ' — watching' : '') +
            '.',
        );
      })
      .catch(function (e) {
        say('Could not send: ' + e.message + '. Will retry on the next fix.');
      });
  }

  function fail(err) {
    say('Location error: ' + err.message + ' (check Location permission for this site).');
  }

  document.getElementById('update').addEventListener('click', function () {
    say('Getting a high-accuracy fix…');
    navigator.geolocation.getCurrentPosition(
      function (p) {
        send(p, false);
      },
      fail,
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  });

  watchEl.addEventListener('change', function () {
    if (watchEl.checked) {
      watchId = navigator.geolocation.watchPosition(
        function (p) {
          var moved = distM(lastSent.lat, lastSent.lon, p.coords.latitude, p.coords.longitude);
          if (Date.now() - lastSent.t > 30000 || moved > 25) send(p, true);
        },
        fail,
        { enableHighAccuracy: true, maximumAge: 5000 },
      );
    } else if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
      say('Stopped watching.');
    }
  });

  var setupForm = document.getElementById('setup-form');
  if (setupForm)
    setupForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var input = document.getElementById('setup-code');
      var code = codeFrom(input.value);
      input.value = '';
      if (!code) {
        say('That is not a setup code (it starts with gsc_).');
        return;
      }
      claim(code).then(refreshSetup);
    });

  document.getElementById('forget').addEventListener('click', function () {
    localStorage.removeItem(KEY);
    refreshSetup();
    say('Forgot the device token on this phone (revoke it on the server too).');
  });

  if ('serviceWorker' in navigator)
    navigator.serviceWorker.register('/locate/sw.js', { scope: '/locate/' }).catch(function () {});
  if (!('geolocation' in navigator)) say('This browser has no geolocation.');
  claimFromHash().then(refreshSetup);
})();
