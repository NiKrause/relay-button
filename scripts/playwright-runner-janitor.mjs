import { createHash } from "node:crypto";

import {
  resolveAlephApiHosts,
  selectExpiredAlephPlaywrightRunners,
  waitForAlephInstanceDeletion,
} from "../packages/playwright/src/index.ts";
import {
  eraseInstanceOnCrn,
  forgetAlephMessages,
} from "../packages/core/src/index.ts";
import { createPrivateKeyIdentity } from "../packages/node/src/signer.ts";

const privateKey = process.env.ALEPH_PRIVATE_KEY?.trim();
const repository = process.env.ALEPH_PLAYWRIGHT_JANITOR_REPOSITORY?.trim();
if (!privateKey) throw new Error("ALEPH_PRIVATE_KEY is required");
if (!repository)
  throw new Error("ALEPH_PLAYWRIGHT_JANITOR_REPOSITORY is required");

const apiHosts = resolveAlephApiHosts(
  process.env.ALEPH_VM_API_HOSTS?.split(/[\s,]+/u).filter(Boolean),
);
const identity = await createPrivateKeyIdentity(privateKey);
const fetchImpl = globalThis.fetch.bind(globalThis);
const source = new URL("/api/v0/messages.json", apiHosts[0]);
source.searchParams.set("msgTypes", "INSTANCE");
source.searchParams.set("addresses", identity.address);
source.searchParams.set("message_statuses", "processed,pending,rejected");
source.searchParams.set("pagination", "200");
source.searchParams.set("page", "1");
source.searchParams.set("sortOrder", "-1");

const response = await fetchImpl(source, { cache: "no-store" });
if (!response.ok)
  throw new Error(`Aleph INSTANCE inventory failed: HTTP ${response.status}`);
const payload = await response.json();
const candidates = (payload.messages ?? []).map((message) => {
  const timestamp = Number(message.reception_time ?? message.time ?? 0) * 1000;
  return {
    itemHash: String(message.item_hash ?? ""),
    ownerAddress: String(message.sender ?? message.address ?? ""),
    instanceName: String(message.content?.metadata?.name ?? ""),
    createdAt:
      Number.isFinite(timestamp) && timestamp > 0
        ? new Date(timestamp).toISOString()
        : "",
    status: String(
      message.confirmed ? "processed" : (message.status ?? "pending"),
    ),
  };
});
const selection = selectExpiredAlephPlaywrightRunners({
  candidates,
  ownerAddress: identity.address,
  repository,
  ttlMs: Number(process.env.ALEPH_PLAYWRIGHT_JANITOR_TTL_MS ?? 60 * 60_000),
});

const cleaned = [];
for (const candidate of selection.expired) {
  let erase = null;
  for (const apiHost of apiHosts) {
    try {
      erase = await eraseInstanceOnCrn({
        sender: identity.address,
        signer: identity.signer,
        instanceHash: candidate.itemHash,
        fetch: fetchImpl,
        apiHost,
      });
      break;
    } catch {
      // FORGET below remains mandatory and exact-hash scoped.
    }
  }
  let forgotten = null;
  for (const apiHost of apiHosts) {
    try {
      forgotten = await forgetAlephMessages({
        sender: identity.address,
        hashes: [candidate.itemHash],
        reason: `Expired ephemeral Playwright runner for ${repository}`,
        signer: identity.signer,
        hasher: (content) => createHash("sha256").update(content).digest("hex"),
        fetch: fetchImpl,
        apiHost,
        sync: true,
      });
      if (forgotten.status === "rejected") throw new Error("FORGET rejected");
      break;
    } catch {
      forgotten = null;
    }
  }
  if (!forgotten)
    throw new Error(`Could not FORGET expired INSTANCE ${candidate.itemHash}`);
  const verification = await waitForAlephInstanceDeletion({
    instanceHash: candidate.itemHash,
    apiHosts,
    fetch: fetchImpl,
  });
  cleaned.push({
    candidate,
    erase,
    forgotten: forgotten.itemHash,
    verification,
  });
}

const evidence = {
  repository,
  ownerAddress: identity.address,
  inventorySource: apiHosts[0],
  apiHosts,
  cleaned,
  retained: selection.retained,
  finishedAt: new Date().toISOString(),
};
console.log(JSON.stringify(evidence));

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## Aleph Playwright runner janitor\n\n- Repository scope: \`${repository}\`\n- Owner: \`${identity.address}\`\n- Cleaned exact INSTANCE hashes: \`${cleaned.length}\`\n- Retained candidates: \`${selection.retained.length}\`\n- API order: ${apiHosts.map((host) => `\`${host}\``).join(" → ")}\n`,
  );
}
