import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { emitDeployOutputs, emitGeocodedCrnOutputs } from '../src/deploy-outputs.ts'

async function createOutputEnv(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const outputFile = join(dir, 'output.txt')
  const summaryFile = join(dir, 'summary.txt')
  return {
    env: {
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile
    },
    outputFile,
    summaryFile
  }
}

test('emitDeployOutputs writes action outputs and summary content', async () => {
  const { env, outputFile, summaryFile } = await createOutputEnv('shared-aleph-deploy-')

  const result = await emitDeployOutputs(
    {
      sender: '0xabc',
      itemHash: 'instanceHash',
      status: 'processed',
      portForwarding: {
        aggregateItemHash: 'aggregateHash',
        aggregateStatus: 'processed'
      },
      instanceDomain: {
        domain: 'ucan-api.example.com',
        url: 'https://ucan-api.example.com',
        itemHash: 'instanceHash',
        aggregateItemHash: 'domainAggregateHash',
        aggregateStatus: 'processed',
        httpStatus: 200
      },
      runtime: {
        allocation: {
          crnUrl: 'https://crn.example.com'
        },
        hostIpv4: '203.0.113.10',
        ipv6: '2001:db8::10',
        proxyUrl: 'https://relay.example.com',
        sshCommand: 'ssh root@example',
        setupHealth: { ok: true },
        mappedPorts: {
          '22': { host: 45678, tcp: true, udp: false }
        },
        diagnostics: {
          state: 'ready',
          timedOut: false,
          reason: 'none'
        },
        selectedCrn: {
          hash: 'crnHash',
          name: 'CRN One'
        }
      },
      configuration: {
        metadata: {
          peer_id: '12D3KooW...',
          probe_multiaddrs: ['/ip4/203.0.113.10/tcp/45678/p2p/12D3KooW...'],
          browser_bootstrap_multiaddrs: ['/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooW...']
        }
      },
      verification: {
        ok: true
      }
    },
    env
  )

  const outputs = await readFile(outputFile, 'utf8')
  const summary = await readFile(summaryFile, 'utf8')

  assert.match(outputs, /instance_item_hash=instanceHash/)
  assert.match(outputs, /port_forward_aggregate_item_hash=aggregateHash/)
  assert.match(outputs, /instance_custom_domain=ucan-api\.example\.com/)
  assert.match(outputs, /instance_custom_domain_url=https:\/\/ucan-api\.example\.com/)
  assert.match(outputs, /instance_custom_domain_aggregate_item_hash=domainAggregateHash/)
  assert.match(outputs, /relay_peer_id=12D3KooW/)
  assert.match(summary, /Aleph VM deployment/)
  assert.match(summary, /CRN One/)
  assert.match(summary, /ucan-api\.example\.com/)
  assert.equal(typeof result.runtimeJson, 'string')
  assert.equal(typeof result.verificationJson, 'string')
})

test('emitGeocodedCrnOutputs writes CRN outputs and summary content', async () => {
  const { env, outputFile, summaryFile } = await createOutputEnv('shared-aleph-crn-')

  await emitGeocodedCrnOutputs([{ hash: 'a' }, { hash: 'b' }], env)

  const outputs = await readFile(outputFile, 'utf8')
  const summary = await readFile(summaryFile, 'utf8')

  assert.match(outputs, /geocoded_crn_count=2/)
  assert.match(outputs, /geocoded_crns_json=\[/)
  assert.match(summary, /Geocoded CRNs/)
})
