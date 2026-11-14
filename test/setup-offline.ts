/**
 * Every test runs offline: a request to anything but this machine's loopback fails at once,
 * so no test can reach a live third-party service by accident (tests inject mock fetches, or
 * stub this one).
 */
const realFetch = globalThis.fetch;
const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\]|::1)$/i;

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const raw = input instanceof Request ? input.url : String(input);
  const host = URL.canParse(raw) ? new URL(raw).hostname : '';
  if (!host || LOOPBACK.test(host)) return realFetch(input, init);
  return Promise.reject(new TypeError(`fetch failed: tests are offline (${host})`));
}) as typeof fetch;
