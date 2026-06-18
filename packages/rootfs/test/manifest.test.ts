import test from "node:test";
import assert from "node:assert/strict";

import {
  ITEM_HASH_RE,
  createRootfsBuildPlan,
  createRootfsManifest,
  readRootfsContractFile,
  referenceProfileContractPath,
  resolveRootfsManifestOutputPaths,
  rootfsSourceSizeBytesFromIpfsAddResponse,
  serializeRootfsManifest,
  validateRootfsManifest,
} from "../src/index.ts";

test("rootfsSourceSizeBytesFromIpfsAddResponse extracts the final IPFS add size", () => {
  const size = rootfsSourceSizeBytesFromIpfsAddResponse(
    [
      '{"Name":"chunk-a","Size":"1024"}',
      '{"Name":"aleph-uc-go-peer.qcow2","Hash":"bafytest","Size":"987654"}',
    ].join("\n"),
  );
  assert.equal(size, 987654);
});

test("createRootfsManifest mirrors the UC rootfs manifest shape", async () => {
  const contract = await readRootfsContractFile(referenceProfileContractPath("uc-go-peer"));
  const plan = createRootfsBuildPlan(contract, {
    projectDir: "/workspace/universal-connectivity",
    rootfsVersion: "uc-go-peer-git-20260516-deadbee",
  });

  const manifest = createRootfsManifest(plan, contract, {
    createdAt: "2026-05-16T12:34:56Z",
    rootfsCid: "bafyrootfs",
    rootfsItemHash: "store-item-hash",
    rootfsSourceSizeBytes: 123456789,
  });

  assert.deepEqual(manifest, {
    profile: "uc-go-peer",
    version: "uc-go-peer-git-20260516-deadbee",
    rootfsInstallStrategy: "prebaked",
    requiresBootstrapNetwork: false,
    bootstrapSummary: "Dependencies are preinstalled in the image.",
    rootfsSourceSizeBytes: 123456789,
    requiredPortForwards: contract.ports,
    rootfsCid: "bafyrootfs",
    rootfsItemHash: "store-item-hash",
    rootfsSizeMiB: 20480,
    createdAt: "2026-05-16T12:34:56Z",
    notes: contract.manifest.notes,
  });
});

test("validateRootfsManifest accepts a complete manifest", () => {
  const result = validateRootfsManifest({
    profile: "orbitdb-relay",
    version: "relay-v0.1.0",
    rootfsInstallStrategy: "thin",
    requiresBootstrapNetwork: true,
    bootstrapSummary: "First boot installs runtime packages and dependencies.",
    requiredPortForwards: [
      { port: 22, tcp: true, udp: false, purpose: "SSH" },
      { port: 9091, tcp: true, udp: false, purpose: "libp2p TCP" },
    ],
    rootfsItemHash: "f".repeat(64),
    rootfsSizeMiB: 20480,
    rootfsSourceSizeBytes: 2445860819,
    createdAt: "2026-04-15",
    notes: "",
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateRootfsManifest rejects invalid port-forward and hash declarations", () => {
  const result = validateRootfsManifest({
    profile: "orbitdb-relay",
    version: "relay-v0.1.0",
    rootfsInstallStrategy: "thin",
    requiredPortForwards: [
      { port: 0, tcp: false, udp: false, purpose: " " },
      { port: 9091, tcp: false, udp: false },
    ],
    rootfsItemHash: "",
    rootfsSizeMiB: 20480,
    createdAt: "2026-04-15",
    notes: "",
    requiresBootstrapNetwork: false,
    bootstrapSummary: "",
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("Rootfs ItemHash must be a 64 character hex value."));
  assert.ok(result.errors.includes("Rootfs required port forward #1 must use a TCP/UDP port between 1 and 65535."));
  assert.ok(result.errors.includes("Rootfs required port forward #1 must enable TCP or UDP."));
  assert.ok(result.errors.includes("Rootfs required port forward #1 purpose must be non-empty when provided."));
  assert.ok(result.errors.includes("Rootfs required port forward #2 must enable TCP or UDP."));
});

test("ITEM_HASH_RE matches Aleph store item hashes", () => {
  assert.equal(ITEM_HASH_RE.test("f".repeat(64)), true);
  assert.equal(ITEM_HASH_RE.test(""), false);
});

test("resolveRootfsManifestOutputPaths follows the UC latest and versioned manifest layout", async () => {
  const contract = await readRootfsContractFile(referenceProfileContractPath("uc-go-peer"));
  const plan = createRootfsBuildPlan(contract, {
    projectDir: "/workspace/universal-connectivity",
    rootfsVersion: "uc-go-peer-git-20260516-deadbee",
  });

  assert.deepEqual(resolveRootfsManifestOutputPaths(plan), {
    primaryPath: "/workspace/universal-connectivity/go-peer/aleph/dist-rootfs/rootfs-manifest.json",
    copyTargetPath: "/workspace/universal-connectivity/js-peer/public/rootfs/uc-go-peer/latest.json",
    versionedTargetPath: "/workspace/universal-connectivity/js-peer/public/rootfs/uc-go-peer/uc-go-peer-git-20260516-deadbee.json",
  });
});

test("serializeRootfsManifest emits readable JSON with a trailing newline", async () => {
  const contract = await readRootfsContractFile(referenceProfileContractPath("uc-go-peer"));
  const plan = createRootfsBuildPlan(contract, {
    projectDir: "/workspace/universal-connectivity",
    rootfsVersion: "uc-go-peer-git-20260516-deadbee",
  });

  const json = serializeRootfsManifest(
    createRootfsManifest(plan, contract, {
      createdAt: "2026-05-16T12:34:56Z",
    }),
  );

  assert.match(json, /"profile": "uc-go-peer"/u);
  assert.ok(json.endsWith("\n"));
});
