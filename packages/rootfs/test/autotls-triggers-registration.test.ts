import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A relay publishes its bootstrap registration on a timer: once about 20
// minutes after boot, then every six hours. AutoTLS issues the certificate on
// its own schedule. When the certificate lands after that first refresh, the
// published record keeps the address set it had without it -- webtransport and
// webrtc-direct, which no Node client can dial -- for up to six hours.
//
// That is not hypothetical. js-peer's bootstrap:resolve verifies a peer over a
// websocket and refuses to bake a list it cannot verify, so a relay deployed
// minutes earlier fails the build that depends on it. Measured on a live
// relay: AutoTLS ready 07:04, registration refreshed 07:30, next refresh
// 13:36 -- and nothing in between connected the two.
const PROFILES = ["uc-go-peer", "orbitdb-relay"];

for (const profile of PROFILES) {
  test(profile + ": finishing AutoTLS re-publishes the registration at once", () => {
    const unit = readFileSync(
      fileURLToPath(
        new URL(
          "../reference/" + profile + "/rootfs/" + profile + "-autotls-refresh.service",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    const expected =
      "ExecStartPost=/usr/bin/systemctl start --no-block " +
      profile +
      "-bootstrap-refresh.service";

    assert.ok(
      unit.includes(expected),
      profile +
        "-autotls-refresh.service must trigger the bootstrap refresh, otherwise the\n" +
        "AutoTLS address waits for the next timer tick before anyone can discover it.",
    );

    // --no-block matters: both units are Type=oneshot, and starting one
    // synchronously from inside the other's ExecStartPost deadlocks systemd.
    assert.match(unit, /ExecStartPost=.*--no-block/);
  });
}
