import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// The confidential path drives aleph-rs's CLI instead of building the INSTANCE
// message here: an SEV-SNP message has to pin the launch measurements, which
// are computed from the runtime bundle (OVMF, kernel, initrd) and the
// owner-bound boot cmdline. Attestation (AMD certificate chain, measurement,
// policy, TCB) and the passphrase injection over the attested channel are the
// CLI's too. See #154.

export interface AlephCliRunner {
  (args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ stdout: string; stderr: string }>;
}

export const runAlephCli = (cli: string): AlephCliRunner =>
  (args, options) =>
    new Promise((resolve, reject) => {
      execFile(
        cli,
        args,
        { env: options.env, timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const reason = `${stderr || stdout || error.message}`.trim().split("\n").slice(-6).join("\n");
            reject(new Error(`aleph ${args[0]} ${args[1] ?? ""} failed: ${reason}`));
            return;
          }
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });

function cliEnv(privateKey: string): NodeJS.ProcessEnv {
  // The key goes through the environment, never argv, so it stays out of
  // process listings and of the error text above.
  return { ...process.env, ALEPH_PRIVATE_KEY: privateKey.replace(/^0x/u, "") };
}

export function parseInstanceItemHash(output: string): string | null {
  return output.match(/Item hash:\s+([0-9a-f]{64})/u)?.[1] ?? null;
}

export async function createConfidentialInstance(args: {
  run: AlephCliRunner;
  privateKey: string;
  name: string;
  rootfsItemHash: string;
  rootfsSizeMiB: number;
  vcpus: number;
  memoryMiB: number;
  crnHash: string;
  sshPublicKey: string;
  channel: string;
}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rb-confidential-"));
  try {
    // The CLI requires an authorized key on the message even though an
    // encrypted rootfs carries its own; it is the same key, baked in at build.
    const keyFile = path.join(dir, "authorized_key.pub");
    await writeFile(keyFile, `${args.sshPublicKey.trim()}\n`, { mode: 0o600 });
    const { stdout, stderr } = await args.run(
      [
        "instance", "create", args.name,
        "--confidential",
        "--image", args.rootfsItemHash,
        "--vcpus", String(args.vcpus),
        "--memory", `${args.memoryMiB}MiB`,
        "--disk-size", `${args.rootfsSizeMiB}MiB`,
        "--crn", args.crnHash,
        "--ssh-pubkey-file", keyFile,
        "--channel", args.channel,
        "--chain", "eth",
      ],
      { env: cliEnv(args.privateKey), timeoutMs: 10 * 60 * 1000 },
    );
    const itemHash = parseInstanceItemHash(`${stdout}\n${stderr}`);
    if (!itemHash) {
      throw new Error(`aleph instance create printed no INSTANCE item hash:\n${`${stdout}\n${stderr}`.trim().slice(-800)}`);
    }
    return itemHash;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Failures that say the node cannot be trusted as it is (outdated firmware,
// no AMD certificate for its TCB, a measurement or policy that does not
// match): retrying cannot fix them, so the deploy moves to the next node.
const PERMANENT_ATTESTATION_FAILURE =
  /TCB below the required floor|AMD KDS returned HTTP 4\d\d|measurement (?:does not match|mismatch)|policy (?:does not match|mismatch)|certificate chain|signature/iu;

export function isPermanentAttestationFailure(message: string): boolean {
  return PERMANENT_ATTESTATION_FAILURE.test(message);
}

export interface ConfidentialAttestation {
  verified: boolean;
  measurement: string | null;
  policy: string | null;
  raw: Record<string, unknown>;
}

/**
 * Attest the guest (it needs a moment after the node reports it running),
 * then inject the LUKS passphrase over the same attested channel. Nothing is
 * sent before the attestation holds.
 */
export async function attestAndUnlock(args: {
  run: AlephCliRunner;
  privateKey: string;
  itemHash: string;
  crnHash: string;
  luksPassphrase: string;
  attempts: number;
  delayMs: number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}): Promise<ConfidentialAttestation> {
  let attestation: ConfidentialAttestation | null = null;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= args.attempts; attempt += 1) {
    try {
      const { stdout } = await args.run(
        ["instance", "attest", args.itemHash, "--crn", args.crnHash, "--json"],
        { env: cliEnv(args.privateKey), timeoutMs: 2 * 60 * 1000 },
      );
      const raw = JSON.parse(stdout) as Record<string, unknown>;
      attestation = {
        verified: raw.verified === true,
        measurement: typeof raw.measurement === "string" ? raw.measurement : null,
        policy: typeof raw.policy === "string" ? raw.policy : null,
        raw,
      };
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const reason = lastError.message.split("\n").at(-1) ?? lastError.message;
      if (isPermanentAttestationFailure(lastError.message)) {
        args.log(`[deploy] attestation of ${args.itemHash} refused: ${reason}`);
        break;
      }
      args.log(`[deploy] attestation ${attempt}/${args.attempts} for ${args.itemHash} not yet: ${reason}`);
      if (attempt < args.attempts) await args.sleep(args.delayMs);
    }
  }
  if (!attestation) {
    throw new Error(`Attestation of ${args.itemHash} failed: ${lastError?.message ?? "no answer"}`);
  }
  if (!attestation.verified) {
    throw new Error(`Attestation of ${args.itemHash} did not verify; the passphrase was not sent.`);
  }
  args.log(`[deploy] attested ${args.itemHash}: measurement=${attestation.measurement} policy=${attestation.policy}`);

  const dir = await mkdtemp(path.join(tmpdir(), "rb-confidential-"));
  try {
    const passphraseFile = path.join(dir, "luks.pass");
    await writeFile(passphraseFile, args.luksPassphrase, { mode: 0o600 });
    await args.run(
      ["instance", "unlock", args.itemHash, "--crn", args.crnHash, "--passphrase-file", passphraseFile, "--chain", "eth"],
      { env: cliEnv(args.privateKey), timeoutMs: 2 * 60 * 1000 },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  args.log(`[deploy] unlocked the encrypted rootfs of ${args.itemHash}`);
  return attestation;
}
