import test from "node:test";
import assert from "node:assert/strict";

import {
  loadRootfsManifestForDeploy,
  parseDeployPlan,
  resolveDeployPlanRootfs,
} from "../src/deploy-plan.ts";

test("parseDeployPlan reads required deploy env and defaults", () => {
  const plan = parseDeployPlan({
    ALEPH_VM_PRIVATE_KEY: "0xabc",
    ALEPH_VM_NAME: "uc-go-peer",
    ALEPH_VM_SSH_PUBLIC_KEY:
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest key@example",
    ALEPH_VM_ROOTFS_ITEM_HASH: "a".repeat(64),
  });

  assert.equal(plan.profile, "uc-go-peer");
  assert.equal(plan.bootstrapPublisherPrivateKey, "");
  assert.equal(plan.bootstrapOwnerPrivateKey, "");
  assert.equal(plan.apiHost, "https://api.aleph.im");
  assert.equal(plan.crnListUrl, "https://crns-list.aleph.sh/crns.json");
  assert.equal(plan.rootfsSizeMiB, 20480);
  assert.equal(plan.channel, "TEST");
  assert.equal(plan.placementStrategy, "scheduler");
  assert.equal(plan.preferredCountryCode, "DE");
  assert.equal(plan.geoCrnLimit, 30);
  assert.equal(plan.maxCrnAttempts, 5);
  assert.equal(plan.runtimeAttempts, 40);
  assert.equal(plan.runtimeDelayMs, 5000);
  assert.equal(plan.setupAttempts, 15);
  assert.equal(plan.setupDelayMs, 4000);
  assert.equal(plan.verifyAttempts, 25);
  assert.equal(plan.verifyDelayMs, 5000);
  assert.equal(plan.tcpTimeoutMs, 5000);
  assert.equal(plan.httpTimeoutMs, 10000);
  assert.equal(plan.metadataAttempts, 80);
  assert.equal(plan.metadataDelayMs, 3000);
  assert.equal(plan.metadataTimeoutMs, 240000);
  assert.equal(plan.configureTimeoutMs, 180000);
  assert.equal(plan.enableCaddyProxy, false);
  assert.equal(plan.autoConfigure, true);
  assert.equal(plan.verifyReachability, true);
  assert.equal(plan.publishPortForwards, true);
  assert.deepEqual(plan.requiredPorts, []);
});

test("parseDeployPlan pins placement manually when a CRN hash is supplied", () => {
  const plan = parseDeployPlan({
    ALEPH_VM_PRIVATE_KEY: "0xabc",
    ALEPH_VM_NAME: "uc-go-peer",
    ALEPH_VM_SSH_PUBLIC_KEY:
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest key@example",
    ALEPH_VM_ROOTFS_ITEM_HASH: "a".repeat(64),
    ALEPH_VM_CRN_HASH: "crn-1",
  });

  assert.equal(plan.placementStrategy, "manual");
  assert.equal(plan.crnHash, "crn-1");
});

test("parseDeployPlan parses integer, boolean, and JSON overrides", () => {
  const plan = parseDeployPlan({
    ALEPH_VM_PRIVATE_KEY: "0xabc",
    ALEPH_VM_BOOTSTRAP_PUBLISHER_PRIVATE_KEY: "0xdef",
    ALEPH_VM_BOOTSTRAP_OWNER_PRIVATE_KEY: "0xghi",
    ALEPH_VM_NAME: "relay",
    ALEPH_VM_SSH_PUBLIC_KEY:
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest key@example",
    ALEPH_VM_ROOTFS_ITEM_HASH: "b".repeat(64),
    ALEPH_VM_ROOTFS_SIZE_MIB: "1024",
    ALEPH_VM_PLACEMENT_STRATEGY: "manual",
    ALEPH_VM_PREFERRED_COUNTRY_CODE: "US",
    ALEPH_VM_GEO_CRN_LIMIT: "12",
    ALEPH_VM_MAX_CRN_ATTEMPTS: "3",
    ALEPH_VM_WAIT_ATTEMPTS: "9",
    ALEPH_VM_WAIT_DELAY_MS: "250",
    ALEPH_VM_RUNTIME_ATTEMPTS: "7",
    ALEPH_VM_RUNTIME_DELAY_MS: "400",
    ALEPH_VM_SETUP_ATTEMPTS: "4",
    ALEPH_VM_SETUP_DELAY_MS: "200",
    ALEPH_VM_VERIFY_ATTEMPTS: "6",
    ALEPH_VM_VERIFY_DELAY_MS: "700",
    ALEPH_VM_TCP_TIMEOUT_MS: "800",
    ALEPH_VM_HTTP_TIMEOUT_MS: "900",
    ALEPH_VM_METADATA_ATTEMPTS: "10",
    ALEPH_VM_METADATA_DELAY_MS: "1100",
    ALEPH_VM_METADATA_TIMEOUT_MS: "1200",
    ALEPH_VM_CONFIGURE_TIMEOUT_MS: "1300",
    ALEPH_VM_ENABLE_CADDY_PROXY: "true",
    ALEPH_VM_AUTO_CONFIGURE: "false",
    ALEPH_VM_VERIFY_REACHABILITY: "false",
    ALEPH_VM_PUBLISH_PORT_FORWARDS: "false",
    ALEPH_VM_REQUIRED_PORTS_JSON:
      '[{"port":22,"tcp":true,"udp":false,"purpose":"SSH"}]',
  });

  assert.equal(plan.rootfsSizeMiB, 1024);
  assert.equal(plan.placementStrategy, "manual");
  assert.equal(plan.bootstrapPublisherPrivateKey, "0xdef");
  assert.equal(plan.bootstrapOwnerPrivateKey, "0xghi");
  assert.equal(plan.preferredCountryCode, "US");
  assert.equal(plan.geoCrnLimit, 12);
  assert.equal(plan.maxCrnAttempts, 3);
  assert.equal(plan.waitAttempts, 9);
  assert.equal(plan.waitDelayMs, 250);
  assert.equal(plan.runtimeAttempts, 7);
  assert.equal(plan.runtimeDelayMs, 400);
  assert.equal(plan.setupAttempts, 4);
  assert.equal(plan.setupDelayMs, 200);
  assert.equal(plan.verifyAttempts, 6);
  assert.equal(plan.verifyDelayMs, 700);
  assert.equal(plan.tcpTimeoutMs, 800);
  assert.equal(plan.httpTimeoutMs, 900);
  assert.equal(plan.metadataAttempts, 10);
  assert.equal(plan.metadataDelayMs, 1100);
  assert.equal(plan.metadataTimeoutMs, 1200);
  assert.equal(plan.configureTimeoutMs, 1300);
  assert.equal(plan.enableCaddyProxy, true);
  assert.equal(plan.autoConfigure, false);
  assert.equal(plan.verifyReachability, false);
  assert.equal(plan.publishPortForwards, false);
  assert.deepEqual(plan.requiredPorts, [
    { port: 22, tcp: true, udp: false, purpose: "SSH" },
  ]);
});

test("parseDeployPlan accepts a canonical ucan-store bootstrap package", () => {
  const plan = parseDeployPlan({
    ALEPH_VM_PROFILE: "ucan-store",
    ALEPH_VM_PRIVATE_KEY: "0xabc",
    ALEPH_VM_NAME: "ucan-store",
    ALEPH_VM_SSH_PUBLIC_KEY:
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest key@example",
    ALEPH_VM_ROOTFS_ITEM_HASH: "c".repeat(64),
    ALEPH_VM_UCAN_STORE_ADMIN_API_TOKEN: "admin-secret",
    ALEPH_VM_UCAN_STORE_BOOTSTRAP_JSON: JSON.stringify({
      operatorAddress: "0x1234000000000000000000000000000000000000",
      adminDid: "did:key:zAdmin",
      serviceDid: "did:key:zService",
      spaceDid: "did:key:zSpace",
      rootDelegationProof: "uEgVjYW5wcm9vZg",
      allowedCapabilities: ["space/blob/add", "space/blob/list"],
      defaultUserDelegationExpiration: 86400,
      maxUserDelegationExpiration: 604800,
      pwaOrigin: "https://store.example.com",
      serviceOrigin: "https://upload.example.com",
    }),
  });

  assert.equal(plan.profile, "ucan-store");
  assert.equal(plan.adminDid, "did:key:zAdmin");
  assert.equal(plan.ucanStoreAdminApiToken, "admin-secret");
  assert.deepEqual(plan.ucanStoreBootstrapPackage, {
    operatorAddress: "0x1234000000000000000000000000000000000000",
    adminDid: "did:key:zAdmin",
    serviceDid: "did:key:zService",
    spaceDid: "did:key:zSpace",
    rootDelegationProof: "uEgVjYW5wcm9vZg",
    allowedCapabilities: ["space/blob/add", "space/blob/list"],
    defaultUserDelegationExpiration: 86400,
    maxUserDelegationExpiration: 604800,
    pwaOrigin: "https://store.example.com",
    serviceOrigin: "https://upload.example.com",
  });
});

test("parseDeployPlan rejects raw numeric required port arrays", () => {
  assert.throws(
    () =>
      parseDeployPlan({
        ALEPH_VM_PRIVATE_KEY: "0xabc",
        ALEPH_VM_NAME: "relay",
        ALEPH_VM_SSH_PUBLIC_KEY:
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest key@example",
        ALEPH_VM_ROOTFS_ITEM_HASH: "b".repeat(64),
        ALEPH_VM_REQUIRED_PORTS_JSON: "[22,80,443,9095,9097]",
      }),
    /ALEPH_VM_REQUIRED_PORTS_JSON entry 0 is invalid/,
  );
});

test("parseDeployPlan accepts a manifest URL without a direct rootfs item hash", () => {
  const plan = parseDeployPlan({
    ALEPH_VM_PRIVATE_KEY: "0xabc",
    ALEPH_VM_NAME: "relay",
    ALEPH_VM_SSH_PUBLIC_KEY:
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest key@example",
    ALEPH_VM_ROOTFS_MANIFEST_URL: "https://example.com/rootfs/latest.json",
  });

  assert.equal(
    plan.rootfsManifestUrl,
    "https://example.com/rootfs/latest.json",
  );
  assert.equal(plan.rootfsItemHash, "");
});

test("loadRootfsManifestForDeploy validates and returns a deployable manifest", async () => {
  const manifest = await loadRootfsManifestForDeploy({
    manifestUrl: "https://example.com/rootfs/latest.json",
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          profile: "uc-go-peer",
          version: "uc-go-peer-git-20260523-8d4867d",
          rootfsInstallStrategy: "prebaked",
          rootfsItemHash: "f".repeat(64),
          rootfsSizeMiB: 20480,
          requiredPortForwards: [
            { port: 22, tcp: true, udp: false, purpose: "SSH" },
          ],
          createdAt: "2026-05-23T14:08:29.851Z",
        };
      },
    }),
  });

  assert.equal(manifest.rootfsItemHash, "f".repeat(64));
  assert.equal(manifest.rootfsSizeMiB, 20480);
  assert.deepEqual(manifest.requiredPortForwards, [
    { port: 22, tcp: true, udp: false, purpose: "SSH" },
  ]);
});

test("resolveDeployPlanRootfs derives hash, size, version, and ports from a manifest URL", async () => {
  const plan = parseDeployPlan({
    ALEPH_VM_PRIVATE_KEY: "0xabc",
    ALEPH_VM_NAME: "relay",
    ALEPH_VM_SSH_PUBLIC_KEY:
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest key@example",
    ALEPH_VM_ROOTFS_MANIFEST_URL: "https://example.com/rootfs/latest.json",
  });

  const resolved = await resolveDeployPlanRootfs(plan, async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        profile: "uc-go-peer",
        version: "uc-go-peer-git-20260523-8d4867d",
        rootfsInstallStrategy: "prebaked",
        rootfsItemHash: "e".repeat(64),
        rootfsSizeMiB: 20480,
        requiredPortForwards: [
          { port: 22, tcp: true, udp: false, purpose: "SSH" },
          { port: 9095, tcp: true, udp: true, purpose: "Relay" },
        ],
        createdAt: "2026-05-23T14:08:29.851Z",
      };
    },
  }));

  assert.equal(resolved.profile, "uc-go-peer");
  assert.equal(resolved.rootfsItemHash, "e".repeat(64));
  assert.equal(resolved.rootfsVersion, "uc-go-peer-git-20260523-8d4867d");
  assert.equal(resolved.rootfsSizeMiB, 20480);
  assert.deepEqual(resolved.requiredPorts, [
    { port: 22, tcp: true, udp: false, purpose: "SSH" },
    { port: 9095, tcp: true, udp: true, purpose: "Relay" },
  ]);
});
