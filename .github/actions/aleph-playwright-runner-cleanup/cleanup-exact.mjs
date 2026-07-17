import { createHash } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";

import {
  eraseInstanceOnCrn,
  forgetAlephMessages,
} from "../../../packages/core/src/index.ts";
import { createPrivateKeyIdentity } from "../../../packages/node/src/signer.ts";
import {
  resolveAlephApiHosts,
  waitForAlephInstanceDeletion,
} from "../../../packages/playwright/src/index.ts";

const instanceHash = process.env.ALEPH_PLAYWRIGHT_INSTANCE_HASH?.trim();
if (!/^[a-f0-9]{64}$/iu.test(instanceHash ?? ""))
  throw new Error("Cleanup requires one exact INSTANCE hash");
const identity = await createPrivateKeyIdentity(process.env.ALEPH_PRIVATE_KEY);
const apiHosts = resolveAlephApiHosts(
  process.env.ALEPH_VM_API_HOSTS?.split(/[\s,]+/u).filter(Boolean),
);
const fetchImpl = globalThis.fetch.bind(globalThis);
let erase;
for (const apiHost of apiHosts) {
  try {
    erase = await eraseInstanceOnCrn({
      sender: identity.address,
      signer: identity.signer,
      instanceHash,
      fetch: fetchImpl,
      apiHost,
    });
    break;
  } catch {
    // Owner-signed FORGET and verification below are still mandatory.
  }
}
let forget;
for (const apiHost of apiHosts) {
  try {
    forget = await forgetAlephMessages({
      sender: identity.address,
      hashes: [instanceHash],
      reason: `Ephemeral Playwright runner cleanup for ${instanceHash}`,
      signer: identity.signer,
      hasher: (content) => createHash("sha256").update(content).digest("hex"),
      fetch: fetchImpl,
      apiHost,
      sync: true,
    });
    if (forget.status === "rejected") throw new Error("FORGET rejected");
    break;
  } catch {
    forget = null;
  }
}
if (!forget) throw new Error(`Owner-signed FORGET failed for ${instanceHash}`);
const verification = await waitForAlephInstanceDeletion({
  instanceHash,
  apiHosts,
  fetch: fetchImpl,
});
const evidencePath = process.env.EVIDENCE_PATH;
await writeFile(
  evidencePath,
  `${JSON.stringify({ instanceHash, owner: identity.address, apiHosts, erase, forget: forget.itemHash, verification }, null, 2)}\n`,
);
await appendFile(process.env.GITHUB_OUTPUT, `evidence_path=${evidencePath}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `\n## Aleph Playwright cleanup\n\n- Exact INSTANCE: \`${instanceHash}\`\n- Runtime erase: \`${erase?.status ?? "unavailable"}\`\n- Owner FORGET: \`${forget.status}\`\n- Verification: ${verification}\n`,
  );
}
