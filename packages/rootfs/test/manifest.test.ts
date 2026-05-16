import test from "node:test";
import assert from "node:assert/strict";

import {
  createRootfsBuildPlan,
  createRootfsManifest,
  readRootfsContractFile,
  referenceProfileContractPath,
  resolveRootfsManifestOutputPaths,
  rootfsSourceSizeBytesFromIpfsAddResponse,
  serializeRootfsManifest,
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
