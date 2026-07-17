import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);

test("runner action pins API order, exact version, and never outputs its bearer secret", async () => {
  const action = await readFile(
    new URL(".github/actions/aleph-playwright-runner/action.yml", root),
    "utf8",
  );
  assert.match(action, /https:\/\/api2\.aleph\.im,https:\/\/api\.aleph\.im/);
  assert.match(action, /playwright-1\.61\.1/);
  assert.match(action, /\{\"playwrightVersion\":\"1\.61\.1\"\}/);
  assert.doesNotMatch(action, /^  secret:\s*\n\s*value:/mu);
  assert.match(action, /auto_configure: ["']false["']/);
  assert.match(action, /verify_reachability: ["']false["']/);
});

test("cleanup action requires exact INSTANCE input and is documented under always", async () => {
  const [action, cleanup, readme] = await Promise.all([
    readFile(
      new URL(
        ".github/actions/aleph-playwright-runner-cleanup/action.yml",
        root,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        ".github/actions/aleph-playwright-runner-cleanup/cleanup-exact.mjs",
        root,
      ),
      "utf8",
    ),
    readFile(
      new URL(".github/actions/aleph-playwright-runner/README.md", root),
      "utf8",
    ),
  ]);
  assert.match(action, /instance_item_hash:/);
  assert.match(cleanup, /\^\[a-f0-9\]\{64\}\$/);
  assert.match(cleanup, /waitForAlephInstanceDeletion/);
  assert.match(readme, /if: always\(\)/);
});

test("live validation performs a real remote connect and exact cleanup under always", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/playwright-runner-live-validation.yml", root),
    "utf8",
  );
  assert.match(workflow, /chromium\.connect/);
  assert.match(
    workflow,
    /if: always\(\) && steps\.runner\.outputs\.instance_item_hash != ''/,
  );
  assert.match(workflow, /aleph-playwright-runner-cleanup/);
  assert.match(workflow, /playwright-\$\{\{ github\.repository_owner \}\}/);
});
