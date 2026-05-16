import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runBootstrapEnvMode, runProbeMode } from "../src/site-runner.ts"

async function createOutputEnv(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const outputFile = join(dir, 'output.txt')
  const summaryFile = join(dir, 'summary.txt')
  return { dir, outputFile, summaryFile }
}

test('runBootstrapEnvMode emits browser bootstrap outputs', async () => {
  const { outputFile, summaryFile } = await createOutputEnv('site-bootstrap-')
  await runBootstrapEnvMode({
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    BROWSER_BOOTSTRAP_MULTIADDRS_JSON: JSON.stringify(['/dns4/example.com/tcp/443/tls/ws/p2p/abc', ' /dns4/example.org/tcp/443/tls/ws/p2p/def ']),
  })

  const outputs = await readFile(outputFile, 'utf8')
  assert.match(outputs, /available=true/)
  assert.match(outputs, /count=2/)
  assert.match(outputs, /csv=\/dns4\/example.com\/tcp\/443\/tls\/ws\/p2p\/abc,\/dns4\/example.org\/tcp\/443\/tls\/ws\/p2p\/def/)
  assert.match(outputs, /json=\["\/dns4\/example.com/)
})

test('runProbeMode merges unique probe addresses and emits outputs', async () => {
  const { dir, outputFile, summaryFile } = await createOutputEnv('site-probe-')
  const scriptPath = join(dir, 'probe.mjs')
  await writeFile(scriptPath, [
    "const addrs = process.argv.slice(2)",
    "for (const addr of addrs) {",
    "  process.stdout.write(JSON.stringify({ address: addr, ok: true, protocols: [], dialMs: 1, pingMs: 1, remoteAddrs: [], error: null }) + '\\n')",
    "}",
    "",
  ].join('\n'))

  await runProbeMode({
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    ALEPH_SITE_PROBE_WORKDIR: dir,
    ALEPH_SITE_PROBE_SCRIPT: scriptPath,
    PROBE_MULTIADDRS_JSON: JSON.stringify(['/ip4/1.1.1.1/tcp/1234/p2p/peer', '/ip4/1.1.1.1/tcp/1234/p2p/peer']),
    BROWSER_BOOTSTRAP_MULTIADDRS_JSON: JSON.stringify(['/dns4/example.com/tcp/443/tls/ws/p2p/peer']),
  })

  const outputs = await readFile(outputFile, 'utf8')
  assert.match(outputs, /ok=true/)
  assert.match(outputs, /merged_multiaddrs_json=/)
  assert.match(outputs, /dns4\/example.com/)
})
