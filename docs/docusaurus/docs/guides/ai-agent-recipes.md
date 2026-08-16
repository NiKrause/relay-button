---
title: AI agent recipes
description: Paste-ready prompts that wire a Relay Button feature into your repo with an AI coding agent.
---

# AI agent recipes

Each recipe below is a prompt you can paste into Claude Code, Cursor, or any
other AI coding agent that can read and edit your repository. The prompts are
written against the real package entrypoints, prop names, and action inputs
documented in this site, so the agent does not have to guess at an API and
invent one that does not exist.

Every recipe has the same shape:

- **Goal** — what you end up with.
- **Prerequisites** — what must already be true before you start.
- **Prompt** — the copy block. Use the copy button in its top-right corner.
- **Verify** — how you know the agent actually got it right.

:::caution Review before you commit

An agent that edits your repository is a fast collaborator, not an authority.
Read the diff before committing, especially anything touching workflows,
secrets, or deployment configuration. These prompts all instruct the agent to
keep secrets in repository secrets rather than in files, but you are the one who
enforces that — check it yourself rather than trusting that the instruction was
followed.

:::

:::tip Add your own facts

Each prompt has placeholders in `ANGLE_BRACKET_CAPS`. Replace them before
pasting. Where a prompt asks the agent to read a docs page, leaving that
instruction in is worthwhile — it grounds the agent in the current API instead
of its training data.

:::

---

## 1. Embed the Svelte widget

**Goal.** A floating Relay Button in your Svelte or SvelteKit app that lets a
visitor deploy a relay from their own wallet.

**Prerequisites.** A Svelte 4+ app, and a reachable RootFS manifest URL.

```text
Add the Relay Button widget to this Svelte app.

1. Install `@le-space/ui`. It declares `svelte >=4` as a peer dependency; do not
   install the React peers.
2. Import the Svelte entrypoint — `import SponsorRelayFab from '@le-space/ui/svelte'`
   — and render it once at the app's root layout so the floating launcher is
   available on every page.
3. Set manifestUrl to <YOUR_MANIFEST_URL> and instanceName to <YOUR_APP>-relay.
   For anything beyond those two, read the Props table at
   https://nikrause.github.io/relay-button/docs/reference/ui — that table is
   the complete supported set, with types and defaults. Use only props listed
   there; do not invent prop names.
4. Make sure the bundler can handle the component's own CSS import. The package
   also exposes '@le-space/ui/styles.css' if you need the theme separately.

Hard constraints:
- This widget deploys through the visitor's own EIP-1193 browser wallet. Never
  add a private key, mnemonic, or signing secret to client code, an env file
  that gets bundled, or a VITE_/PUBLIC_ prefixed variable.
- Do not reimplement the deployment flow. The component owns wallet connection,
  manifest resolution, pricing, CRN selection, and bootstrap publication.

Then show me the diff and tell me what a user will see when they click it.
```

**Verify.** Run the app, click the launcher. The panel should open showing a
wallet status row (`MetaMask disconnected` until you connect), a RootFS health
indicator, and a `Deploy Relay` button. If the manifest cannot be fetched or is
invalid, the panel says so and the deploy button stays blocked — that is
correct behaviour, not a bug in the integration.

See the [UI package reference](../reference/ui.md).

---

## 2. Embed the React widget

**Goal.** The same floating Relay Button, in a React or Next.js app.

**Prerequisites.** React 18+, and a reachable RootFS manifest URL.

```text
Add the Relay Button widget to this React app.

1. Install `@le-space/ui`. It declares `react >=18` and `react-dom >=18` as peer
   dependencies.
2. Import the React entrypoint:
   `import SponsorRelayFab from '@le-space/ui/react'`
   The module also exports the named `SponsorRelayFab` and the
   `useSponsorRelayController` hook if I later want to build custom UI on the
   same controller.
3. Render it once near the root of the app tree. It positions itself as a fixed
   floating launcher, so it does not need a layout slot.
4. Set manifestUrl to <YOUR_MANIFEST_URL> and instanceName to <YOUR_APP>-relay.
   The component takes `SponsorRelayProps`. For anything beyond those two,
   read the Props table at
   https://nikrause.github.io/relay-button/docs/reference/ui — that table is
   the complete supported set. Use only props listed there; do not invent
   prop names.
5. If this is a Next.js app using the App Router, the component is
   client-only — put it in a component with the 'use client' directive and make
   sure it is not server-rendered.

Hard constraints:
- Deployment is signed by the visitor's own EIP-1193 browser wallet. Never place
  a private key or any signing secret in client code or a NEXT_PUBLIC_ variable.
- The component injects its own theme CSS; it can be overridden through the
  public `--le-space-sponsor-relay-*` custom properties. Do not fork the
  component to restyle it.

Then show me the diff.
```

**Verify.** Same as the Svelte recipe: the launcher opens, the wallet row and
RootFS health light render, and deployment is blocked until the manifest
resolves. In dark mode the panel uses its default dark theme; setting
`data-theme="light"` on an ancestor switches it.

See the [UI package reference](../reference/ui.md).

---

## 3. Deploy a relay from CI

**Goal.** A GitHub Actions workflow that deploys an Aleph VM using the shared
`aleph-vm-deploy` action, and surfaces the relay's peer ID and bootstrap
addresses as job outputs.

**Prerequisites.** A published RootFS item hash or manifest, an Aleph key with
credits, and an SSH public key. Both belong in repository secrets.

```text
Add a GitHub Actions workflow to this repo that deploys an Aleph relay VM using
the shared Relay Button action.

Read https://nikrause.github.io/relay-button/docs/reference/github-action first
so you use the real input names.

Requirements:
1. New workflow file `.github/workflows/deploy-relay.yml`, triggered by
   workflow_dispatch (and nothing else for now).
2. Use `NiKrause/relay-button/.github/actions/aleph-vm-deploy@main` with:
   - mode: deploy
   - profile: <uc-go-peer | orbitdb-relay>
   - aleph_private_key: ${{ secrets.ALEPH_PRIVATE_KEY }}
   - ssh_public_key: ${{ secrets.VM_SSH_PUBLIC_KEY }}
   - name: <YOUR_RELAY_NAME>
   - rootfs_item_hash: <YOUR_ROOTFS_ITEM_HASH>
   - preferred_country_code: DE
   - max_crn_attempts: '5'
   - enable_caddy_proxy: true
   - auto_configure: true
   - verify_reachability: true
   - publish_port_forwards: true
   - api_hosts: a comma-separated list, api2.aleph.im first then api.aleph.im
3. Expose these action outputs as job outputs and echo them into the job
   summary: instance_item_hash, instance_status, crn_name, web_proxy_url,
   ssh_command, relay_peer_id, browser_bootstrap_multiaddrs_json,
   verification_ok.

Hard constraints:
- Never inline the Aleph private key or the SSH public key. They must come from
  ${{ secrets.* }} only. Do not write them into a file, an env block committed
  to the repo, or a workflow default.
- api3.aleph.im is unsupported and rejected by the runner — never reference it.
- If you set required_ports_json, it must be a JSON array of objects with
  port/tcp/udp/purpose keys. Raw port numbers are rejected.
- Do not add a schedule trigger. A deployed VM consumes credits until it is
  deleted, and I do not want an unattended loop creating them.

Then list exactly which repository secrets I need to create.
```

**Verify.** Run the workflow manually. The job summary should contain an
`## Aleph VM deployment` block with a non-empty instance item hash and a
deployment status. `verification_ok` should be `true`, and
`browser_bootstrap_multiaddrs_json` should be a non-empty array. Remember to
delete the instance afterwards if it was only a test.

See the [GitHub Action reference](../reference/github-action.md).

---

## 4. Build and publish a RootFS image

**Goal.** A workflow that calls the shared reusable workflow to build your
RootFS image, publish it to IPFS and Aleph, and hand the manifest back to your
own steps.

**Prerequisites.** A RootFS contract JSON in your repo, and an Aleph key with
credits if you intend to publish.

```text
Add a GitHub Actions workflow that builds and publishes our RootFS image using
the shared Relay Button reusable workflow.

Read https://nikrause.github.io/relay-button/docs/reference/reusable-workflow
first so you use the real inputs and outputs.

Requirements:
1. New workflow `.github/workflows/rootfs.yml`, triggered by workflow_dispatch
   with a boolean `publish` input defaulting to false.
2. A job that calls
   `NiKrause/relay-button/.github/workflows/aleph-rootfs-build-publish-deploy.yml@main`
   with:
   - profile: <YOUR_PROFILE>
   - publish: ${{ inputs.publish }}
   - rootfs_contract_path: <PATH_TO_CONTRACT_JSON_IN_THIS_REPO>
   - rootfs_driver: auto
   and `secrets: ALEPH_PRIVATE_KEY: ${{ secrets.ALEPH_PRIVATE_KEY }}`.
3. A dependent job that consumes the reusable workflow's outputs and writes them
   to the job summary: rootfs_version, rootfs_cid, rootfs_item_hash,
   rootfs_manifest_cid, rootfs_manifest_gateway_url,
   rootfs_manifest_artifact_url.

Important behaviour you must respect:
- Do NOT pass deploy_vm: true. That stage is intentionally not wired in the
  shared workflow and it fails fast on purpose. VM deployment is a separate step
  using the aleph-vm-deploy action.
- publish: true requires the ALEPH_PRIVATE_KEY secret; publish: false keeps the
  manifest as a GitHub artifact only and produces no CID or item hash. Make the
  dependent job tolerate the publish: false case instead of failing on empty
  outputs.

Hard constraints:
- The Aleph private key must come from ${{ secrets.ALEPH_PRIVATE_KEY }}. Never
  inline it or echo it into logs or the job summary.

Then explain what changes in the outputs between publish: false and publish: true.
```

**Verify.** Run it once with `publish: false` — you should get a manifest
uploaded as a GitHub artifact, with artifact URLs printed in the summary, and no
CID or item hash. Then run with `publish: true` — the summary should additionally
carry the RootFS CID, the Aleph STORE item hash, the manifest IPFS CID, and the
Aleph gateway URL for the manifest.

See the [reusable workflow reference](../reference/reusable-workflow.md).

---

## 5. Publish a static site and link a custom domain

**Goal.** Your built site pinned on IPFS through Aleph, with a custom domain
pointing at it — and no way for the domain to be linked to a STORE that is not
ready yet.

**Prerequisites.** A static build output directory, an Aleph key with credits,
and a domain you control.

```text
Add a GitHub Actions workflow that publishes this site to IPFS via Aleph and
links our custom domain to it.

Read
https://nikrause.github.io/relay-button/docs/reference/static-sites-custom-domains
first. The readiness boundary described there is the whole point of this task —
do not collapse the two jobs into one.

Requirements:
1. New workflow `.github/workflows/publish-site.yml`.
2. Job `publish`: build the site, then use
   `NiKrause/relay-button/.github/actions/aleph-site-publish@main` with:
   - directory: <YOUR_BUILD_DIR>
   - project_dir: ${{ github.workspace }}
   - aleph_private_key: ${{ secrets.ALEPH_PRIVATE_KEY }}
   - site_ref: <STABLE_SITE_IDENTIFIER>
   - retention_keep_count: '2'
   Expose item_hash, ipfs_cid_v0 and store_processed as job outputs.
3. Job `link-domain`, with `needs: publish` and
   `if: needs.publish.outputs.store_processed == 'true'`. It runs the
   `site-domain-link` mode of `@le-space/node` with these environment variables:
   ALEPH_VM_MODE=site-domain-link, ALEPH_SITE_ITEM_HASH,
   ALEPH_SITE_IPFS_CID_V0, ALEPH_SITE_DOMAIN=<YOUR_DOMAIN>,
   ALEPH_SITE_DOMAIN_CATCH_ALL_PATH=/index.html, and ALEPH_PRIVATE_KEY.

Facts you must not get wrong:
- The custom domain target is the Aleph STORE item_hash, NOT the IPFS CID.
- A successful IPFS upload is not a successful domain deployment. Linking a
  pending STORE leaves the workflow green while the domain keeps serving the
  previous root.
- Do not set ALEPH_SITE_ALLOW_PENDING_STORE=true anywhere in this workflow. The
  fail-closed default is deliberate here because we link a domain afterwards.
- Leave the default upload driver (authenticated-car) alone. gateway-relay is
  legacy diagnostics only.

Hard constraints:
- ALEPH_PRIVATE_KEY comes from repository secrets only, in both jobs.

Then tell me what DNS records I need to create for <YOUR_DOMAIN>.
```

**Verify.** The `publish` job emits `store_processed: true` and a direct Aleph
IPFS gateway `url` you can open. The `link-domain` job only runs when the STORE
is processed. Afterwards the custom domain should serve the same content, with
an `etag` matching the CIDv0 or an `X-Ipfs-Roots` header containing it.

See [static sites and custom domains](../reference/static-sites-custom-domains.md).

---

## 6. Adopt the Playwright test kit

**Goal.** An end-to-end test in your consumer repo that provisions a real relay,
runs your app's own scenario against it, and tears the relay down with verified
cleanup.

**Prerequisites.** A deployed app URL, a funded test key, an SSH public key, and
a Playwright setup (or willingness to add one).

```text
Add an end-to-end Relay Button test to this repo using the shared test kit.

Read https://nikrause.github.io/relay-button/docs/reference/playwright-testkit
first.

Requirements:
1. Install `@le-space/playwright@next` and `@playwright/test@1.61.1` as dev
   dependencies. The Playwright version matters: the package supports 1.61.x
   only, and a remote Playwright server must be the exact same version.
2. Create the test using these real exports:
   - `createRelayEvidence({ instanceName, ownerAddress, steps })` for the
     portable JSON result
   - `createRelayTest({ account, evidence })` for the auto-cleanup fixture
   - `installEip1193WalletMock(context, account)` to inject the wallet
   - the `relayLifecycle` fixture's `provision(page, { instanceName, sshPublicKey })`
   Derive `account` with `privateKeyToAccount` from `viem/accounts`.
3. Keep our app-specific assertions in this repo. `provisionRelay` returns
   `{ instanceHash, peerId, addresses, registration }` — use `peerId` and
   `addresses` to drive our existing scenario. Do NOT move our page selectors or
   scenario state into the shared package; the shared driver is deliberately
   framework-agnostic.
4. Before publishing any pubsub message, call `waitForPubsubSubscriber(page, { topic, peerId })`
   in EVERY browser context. A transport connection from libp2p.getConnections()
   is not proof that the gossipsub mesh has formed, and pubsub does not replay a
   message published before a subscriber joined.
5. Add an `if: always()` artifact upload step for the evidence JSON, the
   Playwright report, traces, and video.

Hard constraints:
- The test private key and SSH public key must come from environment variables
  fed by repository secrets (RELAY_E2E_PRIVATE_KEY, RELAY_E2E_SSH_PUBLIC_KEY).
  Never commit a key, and never write one into a fixture file.
- Do not disable or shortcut cleanup. Each test provisions a real VM that costs
  credits until it is deallocated; the fixture's awaited teardown is what stops
  that. Never delete an instance by display name — cleanup takes the exact
  instance hash.
- Only api2.aleph.im and api.aleph.im are supported replicas. api3.aleph.im is
  rejected.

Then show me the test file and the workflow that runs it.
```

**Verify.** The test provisions a relay, your scenario passes, and teardown
completes without leaving an instance behind. Check the evidence JSON: all three
steps (`provision`, `scenario`, `cleanup`) should be recorded. Cleanup succeeds
only after both Aleph replicas report the instance forgotten *and* the scheduler
reports it deallocated — a disappearing DOM row is not proof.

See the [Playwright test kit reference](../reference/playwright-testkit.md) and
the [migration guide](./playwright-testkit-migration.md).

---

## 7. Discover relays via Aleph bootstrap

**Goal.** Replace hardcoded bootstrap multiaddrs in your libp2p app with live
discovery of relays that were actually deployed.

**Prerequisites.** A libp2p app (browser or Node) that currently configures
bootstrap peers statically.

```text
Replace the hardcoded libp2p bootstrap multiaddrs in this app with Aleph-backed
relay discovery.

Read https://nikrause.github.io/relay-button/docs/reference/aleph-bootstrap
first.

Requirements:
1. Install `@le-space/aleph-bootstrap`.
2. Replace our static `@libp2p/bootstrap` list. There are two supported entry
   points — use the one that fits:
   - `createLibp2pAlephBootstrap()` returns a libp2p peer discovery service
     ready to drop into the services/peerDiscovery config.
   - `discoverAlephBootstrapMultiaddrs()` returns just the raw multiaddr list if
     we need to handle wiring ourselves.
3. Understand the default namespace before changing it. It is channel
   'simple-todo', ref 'simple-todo-bootstrap', post type 'relay-bootstrap-v2'.
   The post type is fixed. If we want isolation from that shared namespace,
   override channel and ref with app-specific values — and tell me what to set.
4. Keep a small static fallback list for the case where discovery returns
   nothing, so the app still starts when Aleph is unreachable. Do not make
   startup hard-fail on discovery.

Behaviour you must not misdescribe in comments or docs:
- Discovery skips records older than 7 days. That is our own application-level
  freshness rule, not a guarantee from Aleph about pruning.
- Records are deduplicated to the newest fresh record per relay identity
  (by registrationId, falling back to sender address).
- Only public multiaddrs are ever published; loopback and private-range
  addresses are filtered out at registration time.
- Wallet-signed v2 records are accepted by default. Passing
  `requireDualKeyAttestation: true` rejects them and accepts only dual-key
  attested registrations.

Security note to act on:
- The shared bootstrap namespace should be treated as publicly writable — any
  valid key can publish into it. Add consumer-side filtering appropriate for
  this app, and tell me whether requireDualKeyAttestation: true is the right
  choice for us given that our relays are deployed by <HOW_YOU_DEPLOY>.
- Discovery is read-only and needs no key. Do not add a private key to this app
  for discovery purposes.

Then show me the diff and explain the fallback path.
```

**Verify.** Log the result of `discoverAlephBootstrapMultiaddrs()` at startup. A
relay you deployed yourself should appear in it, and the list should contain no
loopback or private-range addresses. Discovery being correct does not prove the
relay is reachable — liveness is proven at dial time, not from Aleph.

See the [Aleph bootstrap reference](../reference/aleph-bootstrap.md) and
[bootstrap operations](../reference/aleph-bootstrap-operations.md).

---

## Guardrails worth repeating

These constraints appear across several recipes because getting them wrong is
both easy and expensive:

- **No private key in client code, ever.** The browser widget signs with the
  visitor's own wallet. Any key in a bundle is a key you have published.
- **Secrets come from repository secrets.** Not from committed files, not from
  workflow defaults, not echoed into a job summary.
- **`api3.aleph.im` is unsupported** and is rejected before any request is made.
  Use `api2.aleph.im` first, `api.aleph.im` as fallback.
- **Port declarations are objects,** with `port`, `tcp`, `udp`, and `purpose`
  keys. Raw port numbers are rejected.
- **Deployments cost credits until they are deleted.** Be deliberate about
  triggers that create VMs, and always let test teardown run.
- **A green workflow is not a working deployment.** The domain target is the
  STORE item hash; discovery is not dialability; a DOM row disappearing is not a
  deallocated VM.
