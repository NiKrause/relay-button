# License Decision Notes

The repository currently uses `UNLICENSED` as a safe placeholder.

Before the first public npm release, choose and apply the real license.

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

## Recommendation

If the plan is to publish npm packages for outside use, the most practical
default choice is:

- `MIT` for simplicity

If you prefer a slightly more formal permissive option:

- `Apache-2.0`

## After Choosing

1. add the `LICENSE` file
2. update the root `package.json`
3. update the publish-first package manifests if needed
4. rerun `pnpm release:preview`
