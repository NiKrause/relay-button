import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  contractShellEnv,
  parseRootfsContract,
  referenceProfileContractPath,
  referenceProfileRoot,
  referenceProfileRootfsDir,
  validateRootfsContract
} from '../src/index.ts'

test('validateRootfsContract accepts the shared uc-go-peer reference contract', async () => {
  const raw = await readFile(referenceProfileContractPath('uc-go-peer'), 'utf8')
  const result = validateRootfsContract(JSON.parse(raw))
  assert.equal(result.valid, true)
  assert.equal(result.contract?.rootfs.binaryPath, '/usr/local/bin/universal-chat-go')
})

test('parseRootfsContract returns shell env values for the reference contract', async () => {
  const raw = await readFile(referenceProfileContractPath('uc-go-peer'), 'utf8')
  const contract = parseRootfsContract(raw)
  const env = contractShellEnv(contract, '/tmp/uc-go-peer.json')
  assert.equal(env.ROOTFS_CONTRACT_PROFILE, 'uc-go-peer')
  assert.equal(env.ROOTFS_CONTRACT_BINARY_PATH, '/usr/local/bin/universal-chat-go')
  assert.equal(env.ROOTFS_CONTRACT_INSTALL_DIR, '/opt/go-peer')
})

test('reference profile helpers resolve the copied uc-go-peer asset set', async () => {
  assert.match(referenceProfileRoot('uc-go-peer'), /reference\/uc-go-peer\/?$/)
  assert.match(referenceProfileContractPath('uc-go-peer'), /reference\/uc-go-peer\/contract\.json$/)
  assert.match(referenceProfileRootfsDir('uc-go-peer'), /reference\/uc-go-peer\/rootfs\/?$/)
})

test('validateRootfsContract rejects malformed contracts', () => {
  const result = validateRootfsContract({ schemaVersion: 1, id: 'broken', rootfs: {}, services: {}, ports: [], manifest: {} })
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((error) => error.includes('rootfs.profile')))
  assert.ok(result.errors.some((error) => error.includes('manifest.copyTarget')))
})
