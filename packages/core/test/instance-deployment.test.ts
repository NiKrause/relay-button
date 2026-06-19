import test from 'node:test'
import assert from 'node:assert/strict'

import {
  appendDeploymentTokenToSshPublicKey,
  buildPaymentQuote,
  createDeploymentIntent,
  createInstanceContent,
  createReleaseMetadata,
  createUnsignedInstanceMessage,
  deployInstance,
  isValidSshPublicKey,
  normalizeSshPublicKey,
  quoteRequiredBudgetUnits,
  selectedTier,
  tierSpec
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

test('appendDeploymentTokenToSshPublicKey preserves owner address casing', () => {
  const result = appendDeploymentTokenToSshPublicKey(
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG9A7L1fCP0f3dYxFJ0P0XrJ1hV6X4kRrS0vQd2c8mS0 user@example',
    '0x822A6cc04c19eC6FA1167896658A87a449F4dd15',
    'token-123'
  )

  assert.equal(
    result,
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG9A7L1fCP0f3dYxFJ0P0XrJ1hV6X4kRrS0vQd2c8mS0 aleph-bootstrap-config:0x822A6cc04c19eC6FA1167896658A87a449F4dd15:token-123'
  )
})

test('createReleaseMetadata returns the shared metadata shape', () => {
  assert.deepEqual(createReleaseMetadata('uc-go-peer', 'v1', 'custom-deployer'), {
    name: 'uc-go-peer',
    rootfs_version: 'v1',
    deployer: 'custom-deployer'
  })
})

test('selectedTier finds the matching tier by id', () => {
  assert.deepEqual(
    selectedTier(
      {
        tiers: [
          { id: 'tier-1', compute_units: 1 },
          { id: 'tier-2', compute_units: 2 }
        ]
      },
      'tier-2'
    ),
    { id: 'tier-2', compute_units: 2 }
  )
  assert.equal(selectedTier({ tiers: [{ id: 'tier-1', compute_units: 1 }] }, 'missing'), null)
})

test('tierSpec expands pricing compute units into concrete resources', () => {
  assert.deepEqual(
    tierSpec(
      {
        compute_unit: {
          vcpus: 1,
          memory_mib: 2048,
          disk_mib: 20480
        }
      },
      { id: 'tier-3', compute_units: 4 }
    ),
    {
      vcpus: 4,
      memoryMiB: 8192,
      diskMiB: 81920
    }
  )
})

test('buildPaymentQuote computes required credits from tier compute units', () => {
  const quote = buildPaymentQuote(
    { id: 'tier-2', compute_units: 2 },
    {
      price: {
        compute_unit: {
          credit: '14250'
        }
      }
    },
    {
      credit_balance: 60000
    }
  )

  assert.deepEqual(quote, {
    required: 28500,
    available: 60000,
    computeUnits: 2,
    unitPrice: 14250,
    label: 'credits'
  })
})

test('quoteRequiredBudgetUnits rounds credit quotes to wei-like bigint units', () => {
  assert.equal(
    quoteRequiredBudgetUnits({
      required: 1.25,
      available: 10,
      computeUnits: 1,
      unitPrice: 1.25,
      label: 'credits'
    }),
    1250000000000000000n
  )
  assert.equal(quoteRequiredBudgetUnits(null), 0n)
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

test('createDeploymentIntent hashes a deterministic deployment intent from unsigned message and content', async () => {
  const content = createInstanceContent({
    address: '0xabc',
    name: 'uc-go-peer',
    sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG9A7L1fCP0f3dYxFJ0P0XrJ1hV6X4kRrS0vQd2c8mS0 user@example',
    rootfsItemHash: '380b99e0577fb7771f1b3c0a369f4abff9094e9205b0b466783453299ef9f4f2',
    rootfsSizeMiB: 20480,
    vcpus: 1,
    memoryMiB: 1024,
    crnHash: 'crnHash',
    now: 123
  })

  const unsignedMessage = await createUnsignedInstanceMessage({
    sender: '0xabc',
    content,
    hasher: async () => 'instanceHash',
    now: 123
  })

  const envelope = await createDeploymentIntent({
    sender: '0xabc',
    unsignedMessage,
    content,
    computeUnits: 1,
    expiresAt: 456,
    maxCost: '14250',
    hasher: async (payload) => `intent:${payload}`
  })

  assert.deepEqual(envelope.intent, {
    ownerAddress: '0xabc',
    messageTime: 123,
    itemHash: 'instanceHash',
    paymentType: 'credit',
    rootfsRef: '380b99e0577fb7771f1b3c0a369f4abff9094e9205b0b466783453299ef9f4f2',
    rootfsSizeMiB: 20480,
    computeUnits: 1,
    vcpus: 1,
    memoryMiB: 1024,
    crnHash: 'crnHash',
    channel: 'ALEPH-CLOUDSOLUTIONS',
    expiresAt: 456,
    maxCost: '14250'
  })
  assert.equal(envelope.intentHash, `intent:${JSON.stringify(envelope.intent)}`)
})

test('deployInstance composes hashing, signing, and broadcast into a deployment result', async () => {
  const progressStages: string[] = []
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
    }),
    onProgress: (event) => {
      progressStages.push(event.stage)
    }
  })

  assert.equal(result.itemHash, 'instanceHash')
  assert.equal(result.status, 'processed')
  assert.equal(result.message?.signature, '0xsigned1234')
  assert.deepEqual(progressStages, [
    'building-message',
    'signing-message',
    'broadcasting',
    'deployment-confirmed'
  ])
})
