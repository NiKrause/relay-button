# License Decision Notes

The repository now uses `MIT` as the default license.

This was chosen as the practical default for the first shared public release.

## Practical Options

### MIT

Use this if you want the widest reuse with minimal friction.

Good fit when:

- you want broad adoption
- you are comfortable with permissive reuse
- you want downstream repos to integrate easily

### Apache-2.0

Use this if you want a permissive license with explicit patent language.

Good fit when:

- you still want broad reuse
- you prefer clearer patent coverage than MIT

### Keep Private For Now

Use this if:

- the repo is not ready for public consumption
- the package scope and long-term governance are still unclear
- you want one dry-run release cycle before opening the repo publicly

## Selected Default

For `relay-button`, the selected default is:

- `MIT`

Why:

- simplest path for early reuse
- lowest friction for UC and future external consumers
- good fit for shared SDK, workflow, and action tooling

`Apache-2.0` is still a reasonable future alternative if explicit patent
language becomes important later.

## After Choosing

1. keep the `LICENSE` file in sync with the repo metadata
2. update the final public repository URL in package manifests
3. rerun `pnpm release:preview` after any metadata changes
