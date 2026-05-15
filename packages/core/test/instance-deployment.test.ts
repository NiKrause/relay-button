import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createInstanceContent,
  createReleaseMetadata,
  createUnsignedInstanceMessage,
  deployInstance,
  isValidSshPublicKey,
  normalizeSshPublicKey
} from '../src/instance-deployment.ts'

test('normalizeSshPublicKey collapses multiline and repeated whitespace', () => {
  const normalized = normalizeSshPublicKey('ssh-ed25519   AAAA\n  user@example')
  assert.equal(normalized, 'ssh-ed25519 AAAA user@example')
})

test('isValidSshPublicKey recognizes valid ssh public keys', () => {
  assert.equal(
    isValidSshPublicKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG9A7L1fCP0f3dYxFJ0P0XrJ1hV6X4kRrS0vQd2c8mS0 user@example'),
    true
  )
  assert.equal(isValidSshPublicKey('not-a-key'), false)
})

test('createReleaseMetadata returns the shared metadata shape', () => {
  assert.deepEqual(createReleaseMetadata('uc-go-peer', 'v1', 'custom-deployer'), {
    name: 'uc-go-peer',
    rootfs_version: 'v1',
    deployer: 'custom-deployer'
  })
})

test('createInstanceContent builds a valid Aleph instance payload', () => {
  const content = createInstanceContent({
    address: '0xabc',
    name: 'uc-go-peer',
    sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG9A7L1fCP0f3dYxFJ0P0XrJ1hV6X4kRrS0vQd2c8mS0 user@example',
    rootfsItemHash: '380b99e0577fb7771f1b3c0a369f4abff9094e9205b0b466783453299ef9f4f2',
    rootfsSizeMiB: 20480,
    vcpus: 1,
    memoryMiB: 1024,
    crnHash: 'crnHash',
    rootfsVersion: 'v1',
    deployer: 'custom-deployer',
    now: 123
  })

  assert.equal(content.address, '0xabc')
  assert.equal(content.metadata?.name, 'uc-go-peer')
  assert.equal(content.metadata?.rootfs_version, 'v1')
  assert.equal(content.resources.vcpus, 1)
  assert.equal(content.rootfs.parent.ref, '380b99e0577fb7771f1b3c0a369f4abff9094e9205b0b466783453299ef9f4f2')
  assert.equal(content.requirements?.node?.node_hash, 'crnHash')
})

test('createInstanceContent rejects invalid ssh keys', () => {
  assert.throws(
    () =>
      createInstanceContent({
        address: '0xabc',
        name: 'uc-go-peer',
        sshPublicKey: 'bad-key',
        rootfsItemHash: '380b99e0577fb7771f1b3c0a369f4abff9094e9205b0b466783453299ef9f4f2',
        rootfsSizeMiB: 20480,
        vcpus: 1,
        memoryMiB: 1024
      }),
    /SSH public key/
  )
})

test('createUnsignedInstanceMessage builds an unsigned instance message using injected hashing', async () => {
  const message = await createUnsignedInstanceMessage({
    sender: '0xabc',
    content: {
      address: '0xabc',
      time: 123,
      allow_amend: false,
      environment: {
        internet: true,
        aleph_api: true,
        hypervisor: 'qemu'
      },
      resources: {
        vcpus: 1,
        memory: 1024,
        seconds: 30
      },
      payment: {
        type: 'credit'
      },
      volumes: [],
      rootfs: {
        parent: {
          ref: '380b99e0577fb7771f1b3c0a369f4abff9094e9205b0b466783453299ef9f4f2',
          use_latest: true
        },
        persistence: 'host',
        size_mib: 20480
      }
    },
    hasher: async () => 'instanceHash',
    now: 123
  })

  assert.equal(message.type, 'INSTANCE')
  assert.equal(message.item_hash, 'instanceHash')
})

test('deployInstance composes hashing, signing, and broadcast into a deployment result', async () => {
  const result = await deployInstance({
    sender: '0xabc',
    content: createInstanceContent({
      address: '0xabc',
      name: 'uc-go-peer',
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG9A7L1fCP0f3dYxFJ0P0XrJ1hV6X4kRrS0vQd2c8mS0 user@example',
      rootfsItemHash: '380b99e0577fb7771f1b3c0a369f4abff9094e9205b0b466783453299ef9f4f2',
      rootfsSizeMiB: 20480,
      vcpus: 1,
      memoryMiB: 1024
    }),
    hasher: async () => 'instanceHash',
    signer: async () => 'signed1234',
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { message_status: 'processed' }
      }
    })
  })

  assert.equal(result.itemHash, 'instanceHash')
  assert.equal(result.status, 'processed')
  assert.equal(result.message?.signature, '0xsigned1234')
})
