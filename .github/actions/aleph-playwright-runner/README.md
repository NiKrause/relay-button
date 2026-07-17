# Aleph Playwright runner action

Deploys the published `playwright-runner` RootFS, injects a one-run bearer
secret and TLS certificate over SSH, starts the preinstalled systemd services,
and verifies the authenticated Playwright `1.61.1` endpoint.

The secret is an input and is never emitted as an output. Consumers must run
the separate cleanup action under `always()` using the exact deployment output:

```yaml
- id: runner
  uses: NiKrause/relay-button/.github/actions/aleph-playwright-runner@main
  with:
    aleph_private_key: ${{ secrets.ALEPH_PLAYWRIGHT_PRIVATE_KEY }}
    rootfs_item_hash: ${{ vars.ALEPH_PLAYWRIGHT_ROOTFS_ITEM_HASH }}
    name: playwright-${{ github.repository_owner }}-${{ github.event.repository.name }}-${{ github.run_id }}-${{ github.run_attempt }}
    ssh_public_key: ${{ env.ALEPH_VM_SSH_PUBLIC_KEY }}
    ssh_private_key_path: ${{ env.ALEPH_PLAYWRIGHT_SSH_KEY }}
    secret: ${{ env.ALEPH_PLAYWRIGHT_SECRET }}

- if: always() && steps.runner.outputs.instance_item_hash != ''
  uses: NiKrause/relay-button/.github/actions/aleph-playwright-runner-cleanup@main
  with:
    aleph_private_key: ${{ secrets.ALEPH_PLAYWRIGHT_PRIVATE_KEY }}
    instance_item_hash: ${{ steps.runner.outputs.instance_item_hash }}
```

Generate and mask the secret and SSH identity in the consumer workflow. Do not
store either in the RootFS or artifacts.
