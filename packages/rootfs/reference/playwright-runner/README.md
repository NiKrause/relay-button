# Playwright runner RootFS

This profile prebakes Node.js 24, Playwright `1.61.1`, matching Chromium, Caddy,
and systemd units. It intentionally contains no endpoint credential or TLS
private key.

After Aleph allocates the VM, the reusable action must inject:

- `/etc/default/playwright-runner` with `PLAYWRIGHT_RUNNER_SECRET` and the exact
  `PLAYWRIGHT_VERSION=1.61.1`;
- a per-run certificate and key readable by the dedicated proxy service;
- the requested TTL override, if shorter than the default 45 minutes.

The bootstrap unit refuses to start the browser and proxy until those files are
present. Caddy protects `/version` and the websocket upgrade with the same
Bearer credential. The Playwright server only listens on `127.0.0.1:3000`.

The TTL is a last-resort shutdown, not authoritative Aleph cleanup. The owner
must still erase and FORGET the exact INSTANCE and verify scheduler
deallocation.
