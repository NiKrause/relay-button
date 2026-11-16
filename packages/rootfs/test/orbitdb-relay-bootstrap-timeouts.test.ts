import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// virt-customize shows a command's output only when it fails, so a download
// that hangs inside the image build leaves no trace (2026-11-16). Every
// network step of the bootstrap therefore needs a time limit.
test("every download in the orbitdb-relay image bootstrap has a time limit", async () => {
  const script = await readFile(
    new URL("../reference/orbitdb-relay/rootfs/orbitdb-relay-bootstrap.sh", import.meta.url),
    "utf8",
  );
  const downloads = script
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("#") && !line.startsWith("step "))
    .filter((line) =>
      /apt-get [^|]*\b(update|install)\b|curl |pip install|runuser -u|sudo -u/.test(line),
    );

  assert.ok(downloads.length >= 6, `expected the download steps, found ${downloads.length}`);
  for (const line of downloads) {
    assert.match(line, /\btimeout \d+\b|--max-time \d+/, `no time limit: ${line}`);
  }
});
