# GitHub runner RootFS

Ubuntu 24.04 (as GitHub's own runners) with the GitHub `actions-runner` (pinned, sha256-checked, updates
off), Node.js 24, Docker, git, jq and rootfs build tools. It contains no
credential.

After boot, `scripts/aleph-github-runner.mjs` (`pnpm relay-button gh-runner up`)
writes over SSH, in this order:

- `/etc/github-runner/ttl`: maximum lifetime in minutes (default 360);
- `/etc/github-runner/forget.env` (optional): `ALEPH_FORGET_KEY`, `ALEPH_OWNER`,
  `ALEPH_INSTANCE`, a delegate key authorized for INSTANCE and FORGET (Aleph
  lets a delegate forget only what it could have created);
- `/etc/github-runner/jitconfig`: a one-job just-in-time runner config.

`github-runner.service` waits for the jitconfig, deletes it once read, and runs
one job as the `runner` user (passwordless sudo, docker group). When the runner
exits, `github-runner-finish` forgets the VM's own INSTANCE (if a forget key was
given) and powers off. The TTL timer runs the same path as a last resort.

Self-hosted runners execute workflow code with root rights on this VM: use them
for private repositories, or public ones whose workflows never run for forks.
See the docs page `architecture/aleph-github-runner`.
