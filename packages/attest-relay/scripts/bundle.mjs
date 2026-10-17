// One self-contained file for a guest image: node scripts/bundle.mjs <out.cjs>
// (the orbitdb-relay rootfs build copies it in; the guest has Node, not pnpm).
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'

const out = process.argv[2]
if (!out) throw new Error('usage: node scripts/bundle.mjs <out.cjs>')
const here = path.dirname(fileURLToPath(import.meta.url))

await esbuild.build({
  entryPoints: [path.join(here, '../src/server.ts')],
  outfile: path.resolve(out),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  // ws loads these optional native speedups in a try/catch.
  external: ['bufferutil', 'utf-8-validate'],
  legalComments: 'inline',
  logLevel: 'warning',
})
