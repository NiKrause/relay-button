import test from "node:test";
import assert from "node:assert/strict";

import { normalizeAlephApiHost } from "../src/aleph-api-hosts.ts";

test("normalizeAlephApiHost accepts supported hosts and removes trailing slashes", () => {
  assert.equal(
    normalizeAlephApiHost("https://api2.aleph.im/"),
    "https://api2.aleph.im",
  );
  assert.equal(
    normalizeAlephApiHost("https://api.aleph.im"),
    "https://api.aleph.im",
  );
});

test("normalizeAlephApiHost rejects api3 regardless of casing or path", () => {
  assert.throws(
    () => normalizeAlephApiHost("https://API3.ALEPH.IM/api/v0"),
    /api3\.aleph\.im is not supported/,
  );
});
