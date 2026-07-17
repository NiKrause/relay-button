---
title: Migrate Relay Button E2E consumers
---

# Migrate Relay Button E2E consumers

The migration is intentionally staged so a live consumer proves the package
before duplicated helpers are removed elsewhere.

## React pilot: Universal Connectivity

Keep `ChatBrowserAgent` and the two-browser chat assertions in the consumer.
Replace the local wallet mock, manifest polling, INSTANCE lookup, bootstrap
lookup, address selection, evidence writer, and delete fallback with
`@le-space/playwright`.

Run the live workflow until all of these are present in `result.json`:

1. complete INSTANCE hash;
2. bootstrap peer ID and authenticated browser addresses;
3. browser A and browser B relay connections;
4. messages A → B and B → A;
5. forgotten state on api2 and api;
6. scheduler deallocation.

## Svelte migration: Simple Todo

After the React pilot is stable, retain `TodoBrowserAgent`, shared mnemonic
setup, database assertions, and OrbitDB replication locally. Reuse the same
Relay Button driver and lifecycle fixture. DOM disappearance must no longer be
treated as proof of cleanup.

## Workflow pattern

```yaml
- name: Run Relay Button E2E
  run: npm run test:e2e:relay-button

- name: Upload Relay Button evidence
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: relay-button-e2e-${{ github.run_id }}
    path: |
      test-results/
      playwright-report/

- name: Append structured summary
  if: always()
  run: node scripts/summarize-relay-button-e2e.mjs
```

Use a unique INSTANCE name containing the repository, GitHub run ID, and run
attempt when workflows in multiple repositories may overlap. Cleanup must use
the resolved INSTANCE hash, not that name.
