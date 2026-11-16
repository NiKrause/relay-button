import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const workflow = (name: string) => readFile(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf8')

// The relay image only gets ATTEST_RELAY_BUILDER_ROOTHASHES baked in when the
// value travels repository variable -> reusable workflow input -> runner env.
test('the rootfs publish workflows carry vars.ATTEST_RELAY_BUILDER_ROOTHASHES to the rootfs runner', async () => {
  const caller = await workflow('aleph-rootfs-helia-publish.yml')
  assert.match(caller, /attest_relay_builder_roothashes: \$\{\{ vars\.ATTEST_RELAY_BUILDER_ROOTHASHES \|\| '' \}\}/)

  const reusable = await workflow('aleph-rootfs-build-publish-deploy.yml')
  assert.match(reusable, /\n {6}attest_relay_builder_roothashes:\n(?: {8}.*\n)*? {8}type: string/)
  assert.match(reusable, /ALEPH_ROOTFS_ATTEST_RELAY_BUILDER_ROOTHASHES: \$\{\{ inputs\.attest_relay_builder_roothashes \}\}/)
})

// Without an owner key a relay deployed from CI posts registrations with no
// ownerAddress, and apps that trust relays by owner never find it.
test('the reusable workflow hands an optional bootstrap owner key to the VM deploy action', async () => {
  const reusable = await workflow('aleph-rootfs-build-publish-deploy.yml')
  assert.match(reusable, /\n {6}ALEPH_VM_BOOTSTRAP_OWNER_PRIVATE_KEY:\n(?: {8}.*\n)*? {8}required: false/)
  assert.match(reusable, /bootstrap_owner_private_key: \$\{\{ secrets\.ALEPH_VM_BOOTSTRAP_OWNER_PRIVATE_KEY \}\}/)

  const action = await readFile(new URL('../../../.github/actions/aleph-vm-deploy/action.yml', import.meta.url), 'utf8')
  assert.match(action, /\n {2}bootstrap_owner_private_key:\n/)
  assert.match(action, /ALEPH_VM_BOOTSTRAP_OWNER_PRIVATE_KEY: \$\{\{ inputs\.bootstrap_owner_private_key \}\}/)
})
