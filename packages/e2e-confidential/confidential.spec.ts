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

const evidence = createRelayEvidence({
  instanceName,
  ownerAddress: account.address,
  steps: {
    unlock: 'Guest attested against AMD and unlocked',
    register: 'Relay registered with the bootstrap token',
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
  let unlocked = false
  page.on('console', (message) => {
    if (message.text().includes('deploy:confidential-unlocked')) unlocked = true
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

  expect(unlocked, 'the controller traced deploy:confidential-unlocked').toBe(true)

  expect(relay.instanceHash).toMatch(/^[0-9a-f]{64}$/)
  expect(relay.peerId).toBeTruthy()
  expect(relay.addresses.length).toBeGreaterThan(0)
})
