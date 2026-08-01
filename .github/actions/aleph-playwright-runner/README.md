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

The cleanup action tolerates an empty `instance_item_hash`, so the guard above
is belt-and-braces: a deploy that never created an INSTANCE has already forgotten
its own failed deployment, and the cleanup step now skips instead of failing the
run a second time.

## Placement

Deployment defaults to `manual` placement, which walks the ranked CRN list and
names each node it tries. Aleph's own scheduler is a single anonymous attempt —
one placement candidate, no failover — so a node that never exposes execution
networking loses the whole run, and the log cannot say which node it was. Pass
`placement_strategy: scheduler` to opt back into it.

| Input | Default | Purpose |
| --- | --- | --- |
| `placement_strategy` | `manual` | `manual` iterates ranked CRNs; `scheduler` lets Aleph pick one |
| `max_crn_attempts` | `5` | Ranked CRNs to try; ignored under `scheduler` |
| `runtime_attempts` | `40` | Polls waiting for the CRN to expose runtime networking |
| `runtime_delay_ms` | `5000` | Delay between those polls |

Generate and mask the secret and SSH identity in the consumer workflow. Do not
store either in the RootFS or artifacts.
