#!/usr/bin/env node
// Bring back a relay whose execution Aleph tore down and rebuilt blank
// (relay-button#233). Two steps, because the owner signs in between:
//
//   pnpm relay-button relay-reconfigure prepare --instance <hash> [--state <file>]
//   pnpm relay-button relay-reconfigure apply --state <file> --signature 0x…
//
// `prepare` reads the instance and the CRN's current port mapping, checks
// that the guest is waiting for its configuration, generates a publisher key
// and a libp2p identity, and prints the owner authorization to sign. `apply`
// checks the signature, configures the guest, waits for the relay, closes
// the setup server and waits for the new registration.
//
// The state file holds the generated private keys (mode 0600). `apply`
// deletes it once the relay is registered.
import { readFile, rm, writeFile } from "node:fs/promises";

import {
  assertOwnerSignature,
  assertReconfigurableProfile,
  configureBody,
  configurePortsFromMapping,
  generateRelayKeys,
  hostPortFor,
  isAwaitingConfiguration,
  ownerAuthorizationMessage,
  ownerAuthorizationPayload,
  RELAY_RECONFIGURE_PROFILES,
} from "../packages/node/src/relay-reconfigure.ts";
import {
  fetchVmRuntime,
  waitForRelayBootstrapRegistration,
} from "../packages/core/src/index.ts";

const API_HOSTS = ["https://api2.aleph.im", "https://api.aleph.im"];
const log = (...parts) => console.error("[relay-reconfigure]", ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function help() {
  console.log(`Usage:
  relay-reconfigure prepare --instance <hash> [--profile orbitdb-relay] [--state <file>] [--proxy-url <url>]
  relay-reconfigure apply --state <file> --signature 0x…

prepare prints a message for the instance owner to sign (personal_sign).
apply needs that signature. See docs: guides/relay-recovery.`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument ${key}`);
    options[key.slice(2)] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

async function fetchJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body };
}

async function fetchInstance(itemHash) {
  for (const host of API_HOSTS) {
    const { ok, body } = await fetchJson(`${host}/api/v0/messages/${itemHash}`).catch(() => ({ ok: false }));
    if (ok && body?.message) return body;
  }
  throw new Error(`No Aleph API host returned the message ${itemHash}.`);
}

async function setupStatus(hostIpv4, setupPort) {
  return fetchJson(`http://${hostIpv4}:${setupPort}/`).then((r) => r.body).catch(() => null);
}

async function prepare(options) {
  const itemHash = String(options.instance ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(itemHash)) throw new Error("--instance needs the 64-hex INSTANCE item hash.");
  const profile = assertReconfigurableProfile(options.profile ?? "orbitdb-relay");

  const instance = await fetchInstance(itemHash);
  const content = instance.message.content ?? {};
  if (instance.status !== "processed" || instance.message.type !== "INSTANCE") {
    throw new Error(`${itemHash} is ${instance.status} ${instance.message.type}, not a processed INSTANCE.`);
  }
  const ownerAddress = content.address;
  const instanceName = content.metadata?.name ?? null;
  const crnHash = content.requirements?.node?.node_hash ?? undefined;

  const runtime = await fetchVmRuntime({ itemHash, fetch, crnHash });
  const setupPort = hostPortFor(runtime.mappedPorts, RELAY_RECONFIGURE_PROFILES[profile].setup);
  if (!runtime.hostIpv4 || setupPort == null) {
    throw new Error("The CRN reports no host IPv4 or no mapping for port 80 yet; is the instance running?");
  }
  const status = await setupStatus(runtime.hostIpv4, setupPort);
  if (!isAwaitingConfiguration(status)) {
    throw new Error(
      `The guest at http://${runtime.hostIpv4}:${setupPort}/ is not waiting for a configuration (${JSON.stringify(status)}). Nothing to do.`,
    );
  }

  const ports = configurePortsFromMapping(profile, runtime.mappedPorts);
  const proxyUrl = options["proxy-url"] ?? runtime.proxyUrl ?? null;
  const keys = await generateRelayKeys();
  const payload = ownerAuthorizationPayload({ ownerAddress, keys, profile, instanceName, instanceItemHash: itemHash });
  const message = ownerAuthorizationMessage(payload);

  const statePath = options.state ?? `relay-reconfigure-${itemHash.slice(0, 12)}.json`;
  const state = { itemHash, profile, hostIpv4: runtime.hostIpv4, setupPort, ports, proxyUrl, keys, payload };
  await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });

  log(`instance ${itemHash} of ${ownerAddress}, ${instanceName ?? "unnamed"}`);
  log(`CRN host ${runtime.hostIpv4}, setup port ${setupPort}, ports ${JSON.stringify(ports)}`);
  log(`2n6 proxy ${proxyUrl ?? "none"}`);
  log(`new peer ID ${keys.peerId}, publisher ${keys.publisherAddress}`);
  log(`state (private keys, mode 0600): ${statePath}`);
  log(`Sign this message with ${ownerAddress} (personal_sign), then run apply --state ${statePath} --signature 0x…`);
  console.log(message);
}

async function apply(options) {
  if (!options.state || !options.signature) throw new Error("apply needs --state and --signature.");
  const state = JSON.parse(await readFile(options.state, "utf8"));
  const message = ownerAuthorizationMessage(state.payload);
  assertOwnerSignature(message, options.signature, state.payload.ownerAddress);
  log(`signature is from the owner ${state.payload.ownerAddress}`);

  // Someone else may have configured the guest since prepare.
  const status = await setupStatus(state.hostIpv4, state.setupPort);
  if (!isAwaitingConfiguration(status)) {
    throw new Error(`The guest is no longer waiting for a configuration (${JSON.stringify(status)}). Not sending anything.`);
  }

  const body = configureBody({ ...state, signature: options.signature });
  const configured = await fetchJson(`http://${state.hostIpv4}:${state.setupPort}/configure`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!configured.ok || configured.body?.status !== "configured") {
    throw new Error(`POST /configure answered ${configured.status}: ${JSON.stringify(configured.body?.status ?? configured.body)}`);
  }
  log("guest configured");

  if (state.proxyUrl) {
    const healthUrl = new URL("/health", state.proxyUrl).toString();
    let health = null;
    for (let attempt = 0; attempt < 40 && health?.peerId !== state.keys.peerId; attempt += 1) {
      if (attempt > 0) await sleep(15_000);
      health = (await fetchJson(healthUrl).catch(() => ({}))).body;
    }
    if (health?.peerId !== state.keys.peerId) {
      throw new Error(`${healthUrl} does not report the new peer ID after 10 minutes.`);
    }
    log(`relay up at ${healthUrl} (version ${health.version ?? "unknown"})`);
  }

  // The deploy flow ends by fetching the metadata, which shuts the setup
  // server down. Without this it would keep listening on port 80.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const metadata = await fetchJson(`http://${state.hostIpv4}:${state.setupPort}/metadata`).catch(() => null);
    if (metadata?.body?.status === "ready" || metadata?.body?.status === "error") break;
    await sleep(15_000);
  }
  log(`setup server closed: ${(await setupStatus(state.hostIpv4, state.setupPort)) == null}`);

  const registration = await waitForRelayBootstrapRegistration({
    fetch,
    registrationId: state.payload.registrationId,
    peerId: state.keys.peerId,
    attempts: 40,
    delayMs: 15_000,
  });
  if (registration?.peerId !== state.keys.peerId) {
    throw new Error(`No registration with the new peer ID under ${state.payload.registrationId} after 10 minutes.`);
  }
  log(`registered: ${registration.registrationId}, ${registration.multiaddrs.length} addresses`);

  await rm(options.state);
  log(`deleted ${options.state}; the keys now live only on the guest`);
}

try {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "prepare") await prepare(options);
  else if (command === "apply") await apply(options);
  else help();
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
