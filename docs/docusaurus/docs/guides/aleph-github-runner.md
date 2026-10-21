---
title: Run GitHub Actions jobs on Aleph
description: Set up ephemeral self-hosted GitHub Actions runners on Aleph VMs. Each VM takes one job and then removes itself.
image: /img/social-gh-runner.png
---

# Run GitHub Actions jobs on Aleph

This guide sets up self-hosted GitHub Actions runners on Aleph Cloud. You run
one command, a fresh VM starts, it takes **one job**, and then it **forgets
itself**: the VM is gone and nothing is billed any more. Jobs that ask for
`runs-on: [self-hosted, aleph]` run there and use no hosted Actions minutes.

How it works and what each credential can do is described in
[Ephemeral GitHub Actions runner on Aleph](../architecture/aleph-github-runner.md).

**Cost:** a runner with 2 vCPU, 4 GB of memory and 40 GB of disk costs about
28,500 credits an hour, roughly $0.03. Check the current price with
`aleph instance price --vcpus 2 --memory 4GB --disk-size 40GB`.

:::warning Private repositories, or trusted workflows only
A self-hosted runner executes workflow code with root rights on its VM. On a
public repository that includes code from outside pull requests. The launcher
refuses a public repository unless you pass `--allow-public`.
:::

## 1. Prerequisites

- **Node.js 22.18 or newer** (it runs the TypeScript sources directly) and
  [pnpm](https://pnpm.io).
- **The GitHub CLI**, logged in with admin rights on the repository that should
  get the runners: `gh auth login`. Alternatively, set `GITHUB_TOKEN`; it needs
  repository administration (write) to register runners.
- **The Aleph CLI** from [aleph-rs](https://github.com/aleph-im/aleph-rs):

  ```bash
  cargo install --git https://github.com/aleph-im/aleph-rs aleph-cli
  ```

- **ssh** and `ssh-keygen` on your path.
- **This repository**, with dependencies installed:

  ```bash
  git clone https://github.com/NiKrause/relay-button.git
  cd relay-button
  pnpm install
  ```

## 2. Create a runner wallet and a forget key

Create two accounts in your OS keychain. One is the **runner wallet**: it owns
and pays for the runner VMs and nothing else. The other is the **forget key**,
which each VM uses to delete itself after its job.

```bash
aleph account create gh-runner
aleph account create gh-runner-forget
aleph account list
```

Top up the runner wallet with credits, for example from another of your
accounts (1,000,000 credits are about $1):

```bash
aleph credit transfer --account <your-funded-account> --to gh-runner --amount 1000000
```

:::info How many credits
Aleph accepts a new VM only while the wallet could pay **one day** of runtime
for every VM it runs, the new one included. A default runner costs about
28,500 credits an hour, so each runner running at the same time needs about
684,000 credits in the wallet. With 1,000,000 credits you can run one runner
at a time; for `--count 2`, keep about 1,400,000. Only the time a VM actually
runs is charged.
:::

:::danger Keep the runner wallet separate
Aleph lets a delegate forget only messages it could have created itself, so
the forget key is authorized for `INSTANCE` as well as `FORGET`. Job code can
read the key. It could start VMs paid by the runner wallet or forget its other
instances. So keep the runner wallet's balance small and put nothing else on
it: no images, no relays, no websites.
:::

## 3. Export the keys for the launcher

The launcher reads the keys from the environment. Export them into your shell
without echoing them:

```bash
key() { aleph account export "$1" --yes --json | jq -r '[.. | strings | select(test("^(0x)?[0-9a-fA-F]{64}$"))][0]'; }
export ALEPH_VM_PRIVATE_KEY="$(key gh-runner)"
export GH_RUNNER_FORGET_KEY="$(key gh-runner-forget)"
```

## 4. Authorize the forget key once

```bash
pnpm relay-button gh-runner authorize-forget
```

The output names the runner wallet, the forget key and the processed `security`
aggregate. The command keeps any other authorizations the wallet already has.
`authorize-forget --revoke` takes the key's rights away again.

## 5. Choose the image

Use the published image:

```bash
export GH_RUNNER_ROOTFS_ITEM_HASH=364a840104cdf4f1f9035691a6a1656797ade8eaaa12a659d5d3b8c072a3fbe6
```

It is Debian 12 with GitHub `actions-runner` 2.338.0, Node.js 24, Docker, git,
jq, `qemu-utils`, `cryptsetup` and `debootstrap`, and it contains no credential.
To build your own, run the **GitHub Runner RootFS** workflow in your fork with
`publish` checked. It needs an `ALEPH_PRIVATE_KEY` secret for the account that
pays for the STORE, which should not be the runner wallet. Its summary prints
the new item hash. The image's sources
are in `packages/rootfs/reference/github-runner`.

## 6. Start a runner

```bash
pnpm relay-button gh-runner up --repo owner/name
```

In about three minutes the runner is online. The launcher prints the INSTANCE
hash and the runner name, and the runner shows up under the repository's
**Settings → Actions → Runners**.

Useful options:

| Option | Default | Meaning |
|---|---|---|
| `--count N` | `1` | start N runners, one job each (at most 10; each needs a day of credits in reserve) |
| `--labels a,b` | `aleph` | labels besides `self-hosted`, `Linux`, `X64` |
| `--ttl M` | `360` | minutes until the VM powers off without a job |
| `--vcpus`, `--memory`, `--disk` | `2`, `4096`, `40960` | VM size (MiB for memory and disk) |

## 7. Point a job at it

```yaml
jobs:
  build:
    runs-on: [self-hosted, aleph]
    steps:
      - uses: actions/checkout@v6
      - run: docker run --rm hello-world
```

When the job ends, the VM forgets itself and powers off. The runner disappears
from the repository settings. There is nothing to clean up.

## 8. Check and clean up

```bash
pnpm relay-button gh-runner list --repo owner/name      # runner VMs and their state on GitHub
pnpm relay-button gh-runner janitor --repo owner/name   # remove leftovers
pnpm relay-button gh-runner down --all                  # remove every runner VM of the wallet
```

`janitor` removes runner VMs whose job is done but that are still allocated,
and VMs past their TTL. It also deregisters their offline runners on GitHub.
That happens when a VM started without a forget key or its FORGET failed.
Running it every hour or so, for example from cron, keeps a forgotten runner
from billing for long.

## Troubleshooting

- **The job stays queued.** The job's `runs-on` labels must all be on the
  runner. Compare them with `gh api repos/owner/name/actions/runners`.
- **A runner never comes online.** `up` removes the VM again when this happens.
  To look inside a runner, start it with `--ssh-key <path>` and log in as
  `root`. The cleanup log is `/var/lib/github-runner/finish.log`.
- **`deploy` fails with error 6.** The wallet lacks the day of runtime Aleph
  wants in reserve for every running VM; the rejection names
  `required_credits`. Top up, or start fewer runners at once. Check with
  `aleph account balance gh-runner`.
