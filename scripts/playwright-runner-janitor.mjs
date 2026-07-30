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
// Ephemeral VMs a repository names by its own scheme (simple-todo's relay
// runners are `simple-todo-e2e-<timestamp>`) never match the
// `playwright-<repository>-` prefix, so without this they leak forever (#88).
const additionalNamePrefixes =
  process.env.ALEPH_PLAYWRIGHT_JANITOR_EXTRA_NAME_PREFIXES?.split(/[\s,]+/u).filter(
    Boolean,
  ) ?? [];
const failOnUnswept =
  process.env.ALEPH_PLAYWRIGHT_JANITOR_FAIL_ON_UNSWEPT?.trim() === "true";

const selection = selectExpiredAlephPlaywrightRunners({
  candidates,
  ownerAddress: identity.address,
  repository,
  additionalNamePrefixes,
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
  namePrefixes: [`playwright-${repository.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}-`, ...additionalNamePrefixes],
  cleaned,
  retained: selection.retained,
  unswept: selection.unswept,
  finishedAt: new Date().toISOString(),
};
// stdout stays pure JSON: the workflow tees it into the evidence artifact.
console.log(JSON.stringify(evidence));

// Annotations go to stderr so they cannot corrupt that artifact.
for (const leak of selection.unswept)
  console.error(
    `::warning::Unswept Aleph INSTANCE ${leak.itemHash} (${leak.instanceName || "unnamed"}) is ${Math.round(leak.ageMs / 3_600_000)}h old and still burning credits, but matches no configured name prefix.`,
  );

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import("node:fs/promises");
  const unsweptSection = selection.unswept.length
    ? `\n### ⚠️ Unswept instances still burning credits\n\nThese are allocated, past the TTL, and match none of the name prefixes above — extend the prefixes or forget them by hand:\n\n${selection.unswept
        .map(
          (leak) =>
            `- \`${leak.itemHash}\` — \`${leak.instanceName || "unnamed"}\`, ${Math.round(leak.ageMs / 3_600_000)}h old`,
        )
        .join("\n")}\n`
    : "";
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## Aleph Playwright runner janitor\n\n- Repository scope: \`${repository}\`\n- Owner: \`${identity.address}\`\n- Swept name prefixes: ${evidence.namePrefixes.map((prefix) => `\`${prefix}\``).join(", ")}\n- Cleaned exact INSTANCE hashes: \`${cleaned.length}\`\n- Retained candidates: \`${selection.retained.length}\`\n- Unswept (leaking) instances: \`${selection.unswept.length}\`\n- API order: ${apiHosts.map((host) => `\`${host}\``).join(" → ")}\n${unsweptSection}`,
  );
}

// A green run must never again mean "an unrecognised name was silently left
// running". Callers whose wallet only ever holds ephemeral VMs opt into a hard
// failure; wallets that also fund long-lived relays keep the warning instead.
if (failOnUnswept && selection.unswept.length)
  throw new Error(
    `${selection.unswept.length} Aleph INSTANCE(s) are past the TTL but match no configured name prefix: ${selection.unswept.map((leak) => `${leak.itemHash} (${leak.instanceName || "unnamed"})`).join(", ")}`,
  );
