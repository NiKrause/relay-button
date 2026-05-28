# UI Package

`@le-space/ui` is the shared component package for browser-facing relay
deployment and status flows.

It sits above `@le-space/browser` in the stack:

- `@le-space/browser` provides browser-safe Aleph and wallet helpers
- `@le-space/ui` provides reusable React and Svelte UI built on top of those
  helpers

## Current Scope

The package currently covers:

- shared deployment status presentation
- reusable small UI primitives for deployment flows
- Sponsor Relay browser deployment integration
- framework-specific entrypoints for React and Svelte consumers

The goal is to keep reusable deployment UX here while leaving product-specific
branding and page composition in consumer apps.

## Package Shape

The package currently exposes multiple entrypoints:

- shared logic and framework-agnostic helpers
- React components
- Svelte components
- shared styles

Consumers should import the framework entrypoint they actually use instead of
rebuilding relay deployment UI from scratch in every project.

## When To Use `@le-space/ui`

Use `@le-space/ui` when a consumer app needs:

- a shared relay deployment button or flow
- consistent deployment status display
- reusable Sponsor Relay UX across projects
- the shared deployment orchestration already implemented in this monorepo

Keep implementation local to the consumer app when you need:

- project-specific onboarding or narrative UX
- app-specific visual design that is not intended to be reused
- tightly product-coupled flows that are not general relay deployment patterns

## Relationship To `@le-space/browser`

The intended layering is:

1. `@le-space/shared-types`
2. `@le-space/core`
3. `@le-space/browser`
4. `@le-space/ui`

That means:

- browser-safe Aleph API and wallet interactions belong in `@le-space/browser`
- reusable rendered deployment UX belongs in `@le-space/ui`

`@le-space/ui` should avoid re-owning low-level browser transport logic if that
logic can live in the browser package instead.

## Current Consumers

Known current consumer directions include:

- Sponsor Relay browser flows
- PWA-style Aleph deployment integrations
- relay deployment UI shared across `aleph-libp2p-relay`-related projects

## What Is Still Evolving

The package is published and usable, but it is still evolving in a few ways:

- the public component surface is not yet documented exhaustively
- some reusable deployment flows are still being factored between browser and
  UI layers
- framework-specific examples can still be improved

## Suggested Future Additions

A useful next step for this page would be a compact API section with:

- React import examples
- Svelte import examples
- a list of the main exported deployment components
- notes on required styles or browser helpers
