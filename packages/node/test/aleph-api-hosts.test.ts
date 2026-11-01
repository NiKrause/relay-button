import test from "node:test";
import assert from "node:assert/strict";

import { normalizeAlephApiHost } from "../src/aleph-api-hosts.ts";

test("normalizeAlephApiHost trims and removes trailing slashes", () => {
  assert.equal(
    normalizeAlephApiHost(" https://api2.aleph.im/ "),
    "https://api2.aleph.im",
  );
  assert.equal(
    normalizeAlephApiHost("https://api.aleph.im"),
    "https://api.aleph.im",
  );
});

test("normalizeAlephApiHost accepts api3 (a core channel node of its own)", () => {
  assert.equal(
    normalizeAlephApiHost("https://api3.aleph.im/"),
    "https://api3.aleph.im",
  );
});
