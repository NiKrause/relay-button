/**
 * Trims an Aleph API host URL and drops its trailing slash. Every host is
 * accepted. api3.aleph.im was rejected here from July to November 2026; it is
 * a core channel node of its own (46.255.204.193), and on 2026-11-01 it took a
 * signed CAR upload while api2.aleph.im and api.aleph.im, which share one
 * backend, answered every upload with HTTP 502 (their IPFS import was broken).
 */
export function normalizeAlephApiHost(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}
