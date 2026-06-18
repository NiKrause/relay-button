# Browser Guest Setup Refactor Plan

## Human Validation First

This plan is intentionally written as a proposed refactor sequence, not as an
already-approved execution order.

Before implementing it, a human maintainer should review and validate:

- the package boundaries
- the intended long-term ownership of guest setup orchestration
- whether `@le-space/core`, `@le-space/browser`, and `@le-space/node` should
  all participate in the same lifecycle abstraction
- whether the remaining browser-specific behavior is acceptable for the target
  deployment models

In short: this plan should be validated by humans one more time before
execution.

## Goal

Move reusable browser-side deployment and guest-setup logic out of the local
PWA repository and into `relay-button`, while respecting the existing,
working `@le-space/*` package boundaries and avoiding new duplication.

The primary consolidation target is the post-deploy guest setup lifecycle,
which currently exists in:

- the mature Node/workflow path
- the lighter browser/PWA path

The goal is not to move all PWA code into shared tooling. The goal is to move
the reusable lifecycle rules into shared packages and leave UI/product behavior
local.

## Desired Package Boundaries

### `@le-space/core`

Should own neutral lifecycle logic and policy, including:

- guest setup state machine
- retry policy rules
- runtime interpretation
- target resolution rules
- profile-aware success criteria

### `@le-space/browser`

Should own browser-safe adapters and orchestration wrappers, including:

- browser-safe transport wrappers
- browser guest setup runner built on core lifecycle logic
- CORS-aware fetch behavior
- browser retry wrappers where the browser runtime needs them

### `@le-space/node`

Should own server-side execution and verification, including:

- CLI and GitHub Action runners
- stronger server-side verification/probing
- workflow-oriented logging and status reporting

### Consumer PWA

Should keep only app-local behavior, including:

- UI state and presentation
- wallet UX
- browser persistence
- app-specific error copy
- target-specific product policy that is not generally reusable

## Refactor Principles

1. Do not create a second fully separate browser deployment model if shared
   lifecycle rules can be reused.
2. Do not copy the Node/workflow lifecycle into the browser package as a
   browser-only fork.
3. Extract shared lifecycle rules downward into `@le-space/core`.
4. Let browser and node packages become transport/runtime-specific adapters
   around the same lifecycle model.
5. Leave product-specific UI and wallet concerns in the PWA.

## Step-By-Step Plan

### Step 1: Inventory Current Lifecycle Logic

Identify the current guest setup lifecycle in both paths.

Node/workflow path:

- deploy VM
- wait for Aleph processing
- publish port forwards
- notify allocation
- wait for runtime networking
- wait for guest `/health`
- call guest `/configure`
- poll guest `/metadata`
- run server-side verification

Browser/PWA path:

- deploy VM
- publish port forwards
- notify allocation
- wait for runtime details
- wait for guest `/health`
- call guest `/configure`
- poll guest `/metadata`

Output of this step:

- a line-by-line lifecycle comparison
- a list of shared rules versus transport-specific behavior

### Step 2: Define A Shared Core Guest Setup Contract

Create a neutral contract in `@le-space/core` for guest setup orchestration.

The core layer should not make raw HTTP requests directly. Instead, it should
depend on injected callbacks such as:

- `waitForHealth`
- `configureGuest`
- `fetchMetadata`
- `notifyAllocation`
- `resolveRuntimeTarget`

This allows the same lifecycle to be used by:

- browser consumers
- node consumers
- workflow runners

Output of this step:

- a small core interface for guest setup orchestration
- typed lifecycle result objects

### Step 3: Extract Shared Lifecycle State Machine Into `@le-space/core`

Move the reusable lifecycle sequence into `@le-space/core`.

The state machine should cover:

- runtime target resolution
- setup health wait
- guest configuration request
- metadata polling
- structured success/failure states

It should also support profile-aware behavior, beginning with:

- `uc-go-peer`
- `orbitdb-relay`

Output of this step:

- one core guest setup orchestrator
- no browser-specific or node-specific transport inside it

### Step 4: Move Browser-Specific Wrappers Into `@le-space/browser`

Move the browser-safe wrappers currently living in the PWA into
`@le-space/browser`.

Likely candidates:

- browser-safe `fetch` wrapping
- browser guest setup runner that calls the core orchestrator
- transient CRN allocation notify retry policy
- browser-specific timeout behavior for `/health` and `/metadata`

The browser package should expose a higher-level helper so the PWA no longer
coordinates the full guest setup lifecycle itself.

Output of this step:

- a browser guest setup helper that the PWA can call directly

### Step 5: Simplify The PWA To Use Shared Browser Orchestration

Refactor the PWA so it stops coordinating the reusable setup lifecycle in
`App.svelte` and `alephApi.ts`.

The PWA should instead:

- call shared browser orchestration helpers
- keep only UI state, rendering, and app-specific status messages

Output of this step:

- less lifecycle orchestration in the PWA
- clearer separation between UI and reusable deployment logic

### Step 6: Align `@le-space/node` With The Same Core Lifecycle

Refactor the Node/workflow path so it also uses the shared core guest setup
state machine.

The Node package should still keep its stronger server-side extras, such as:

- richer verification/probing
- workflow logging
- server-side retry/reporting

But those should sit on top of the same core guest setup lifecycle rather than
re-implementing it.

Output of this step:

- one shared lifecycle model
- node-only verification layered on top

### Step 7: Revisit External Target Selection Separately

Do not mix the private `host_ipv4` issue into the first lifecycle refactor.

Instead, treat target resolution as a follow-up step once the lifecycle is
shared.

That follow-up should distinguish between:

- raw runtime networking reported by the CRN
- chosen external connection target for browser, SSH, and setup requests

Output of this step:

- a separate, explicit target selection policy

## What Should Stay Local To The PWA

The following should remain local unless a second browser consumer proves they
are reusable:

- wallet UX
- loading and status presentation
- clipboard and small interaction helpers
- app-specific copy and warnings
- product-specific policy that is not generally reusable

## What Should Probably Move First

Recommended first extraction slice:

- CRN allocation notify retry policy
- wait for guest `/health`
- call guest `/configure`
- poll guest `/metadata`
- profile-aware success criteria

Recommended second extraction slice:

- runtime target resolution abstraction
- distinction between reported runtime details and chosen external target

Recommended third extraction slice:

- Node and browser both consume the same core guest setup orchestrator

## Success Criteria

The refactor should be considered successful when:

- the PWA no longer owns reusable guest setup lifecycle logic
- the browser package exposes a reusable browser-safe guest setup helper
- the Node/workflow path and browser path share one core lifecycle model
- target-specific behavior remains explicit and profile-aware
- no new duplication is introduced between `@le-space/core`,
  `@le-space/browser`, and `@le-space/node`

## Non-Goal

This plan does not aim to move all PWA code into shared tooling.

It only aims to move the reusable deployment and guest setup logic into shared
packages while keeping UI and product-specific concerns local.
