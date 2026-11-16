import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// libguestfs boots its appliance with the builder container's kernel. Debian's
// 6.1.0-55 made that appliance hang in the first --run-command (2026-11-16),
// so every rootfs builder pins 6.1.0-54 instead of the moving linux-image-amd64.
const profiles = ['orbitdb-relay', 'uc-go-peer', 'ucan-store', 'github-runner', 'playwright-runner']

for (const profile of profiles) {
  test(`the ${profile} rootfs builder boots libguestfs with the pinned kernel`, async () => {
    const dockerfile = await readFile(new URL(`../reference/${profile}/rootfs/Dockerfile.rootfs`, import.meta.url), 'utf8')
    assert.doesNotMatch(dockerfile, /^\s*linux-image-amd64\b/m)
    assert.match(dockerfile, /ARG KERNEL_ABI=6\.1\.0-54-amd64/)
    assert.match(dockerfile, /ARG KERNEL_SHA256=d788f148714b4cec6a9ff5e66282f56d9a7a0c2c12ac3e5093de12abaf47f56e/)
    assert.match(dockerfile, /sha256sum -c -/)
    assert.match(dockerfile, /ENV SUPERMIN_KERNEL=\/boot\/vmlinuz-6\.1\.0-54-amd64/)
    assert.match(dockerfile, /ENV SUPERMIN_MODULES=\/lib\/modules\/6\.1\.0-54-amd64/)
  })
}
