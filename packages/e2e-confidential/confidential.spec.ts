// A confidential start from the widget against a real SEV-SNP node
// (relay-button#169, step 4): the browser computes the launch measurements,
// signs the INSTANCE, attests the guest through the attest relay, unlocks it
// with the passphrase and hands it the SSH key with the bootstrap token. The
// relay's bootstrap registration at the end proves the guest got that token.
//
// E2E_PRIVATE_KEY      the paying test wallet (injected as window.ethereum)
// E2E_LUKS_PASSPHRASE  the passphrase of the encrypted rootfs
// E2E_SSH_PUBLIC_KEY   a public key for the VM (the widget requires one)
// E2E_CRN_HASH         optional: the node to pin
// E2E_CHECK_ATTEST_ROUTE  1: attest the VM again through the new relay's own
//                      wss://<host>/attest (images from before the route: 0)
import { expect } from '@playwright/test'
import { privateKeyToAccount } from 'viem/accounts'

import {
  RelayButtonDriver,
  appendRelayGithubSummary,
  createRelayEvidence,
  createRelayTest,
  forwardBrowserConsole,
  installEip1193WalletMock,
  updateRelayEvidenceStep,
} from '../playwright/src/index.ts'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`set ${name}`)
  return value
}

const account = privateKeyToAccount(required('E2E_PRIVATE_KEY') as `0x${string}`)
const passphrase = required('E2E_LUKS_PASSPHRASE')
const sshPublicKey = required('E2E_SSH_PUBLIC_KEY')
const crnHash = process.env.E2E_CRN_HASH?.trim() ?? ''
const instanceName = process.env.E2E_INSTANCE_NAME?.trim() || `rb-confidential-e2e-${Date.now()}`
const checkAttestRoute = process.env.E2E_CHECK_ATTEST_ROUTE === '1'

const evidence = createRelayEvidence({
  instanceName,
  ownerAddress: account.address,
  steps: {
    unlock: 'Guest attested against AMD and unlocked',
    register: 'Relay registered with the bootstrap token',
    ...(checkAttestRoute ? { route: "Guest attested again through the relay's own /attest" } : {}),
  },
})

const test = createRelayTest({ account, evidence })

/** The stock driver, plus the passphrase and an optional pinned node. */
class ConfidentialDriver extends RelayButtonDriver {
  override async prepare(options: { instanceName: string; sshPublicKey: string }): Promise<void> {
    await super.prepare(options)
    await this.page.getByLabel('Rootfs passphrase').fill(passphrase)
    if (crnHash) {
      const select = this.page.getByLabel('Select CRN')
      await expect(select.locator(`option[value="${crnHash}"]`)).toHaveCount(1, { timeout: 180_000 })
      await select.selectOption(crnHash)
    }
  }
}

test.afterAll(async () => {
  await appendRelayGithubSummary(evidence, { title: 'Confidential start E2E' }).catch(() => {})
})

test('a confidential relay starts from the widget: attested, unlocked, registered', async ({ page, relayLifecycle }) => {
  forwardBrowserConsole(page, { label: 'browser', filter: /error|warn|attest|unlock|confidential|failover|CRN/i })
  // The page runs the widget with debug on, so the controller's trace says
  // when the guest was attested and unlocked (the progress line is not text
  // on the page).
  let unlocked: { measurement?: string; policy?: string | number } | null = null
  page.on('console', async (message) => {
    if (!message.text().includes('deploy:confidential-unlocked')) return
    unlocked = {}
    unlocked = ((await message.args()[2]?.jsonValue().catch(() => null)) ?? {}) as typeof unlocked
  })
  await installEip1193WalletMock(page.context(), account)
  await page.goto('/')

  const relay = await relayLifecycle.provision(page, {
    instanceName,
    sshPublicKey,
    driver: new ConfidentialDriver(page),
    onPhase: (phase, detail) => console.log(`[e2e] ${phase}${detail ? `: ${detail}` : ''}`),
  })
  updateRelayEvidenceStep(evidence, 'unlock', unlocked ? 'passed' : 'failed')
  updateRelayEvidenceStep(evidence, 'register', 'passed', relay.peerId)

  expect(unlocked, 'the controller traced deploy:confidential-unlocked').toBeTruthy()

  if (checkAttestRoute) {
    const { measurement, policy } = unlocked as unknown as { measurement: string; policy: string | number }
    expect(measurement, 'the unlock trace carries the measurement').toMatch(/^[0-9a-f]{96}$/)
    const host = relay.addresses.map((address) => /^\/dns[46]?\/([^/]+)\/tcp\/443\//.exec(address)?.[1]).find(Boolean)
    expect(host, 'the relay advertises a wss address on 443').toBeTruthy()
    const instance = await (await fetch(`https://api2.aleph.im/api/v0/messages/${relay.instanceHash}`)).json()
    const crnHash = instance?.message?.content?.requirements?.node?.node_hash
    expect(crnHash, 'the INSTANCE names its node').toMatch(/^[0-9a-f]{64}$/)
    let reattested = ''
    let lastError = ''
    for (let attempt = 1; attempt <= 6 && !reattested; attempt += 1) {
      try {
        reattested = await page.evaluate(
          (args) => (window as unknown as { __e2eReattest: (a: typeof args) => Promise<string> }).__e2eReattest(args),
          { relayUrl: `wss://${host}/attest`, crnHash, instanceItemHash: relay.instanceHash, measurement, policy },
        )
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        console.log(`[e2e] /attest attempt ${attempt}: ${lastError}`)
        await page.waitForTimeout(15_000)
      }
    }
    updateRelayEvidenceStep(evidence, 'route', reattested ? 'passed' : 'failed', reattested ? `wss://${host}/attest` : lastError)
    expect(reattested, `attested through wss://${host}/attest`).toBe(measurement)
  }

  expect(relay.instanceHash).toMatch(/^[0-9a-f]{64}$/)
  expect(relay.peerId).toBeTruthy()
  expect(relay.addresses.length).toBeGreaterThan(0)
})
