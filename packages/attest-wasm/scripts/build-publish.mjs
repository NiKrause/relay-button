// The WASM for the npm package: cargo + wasm-bindgen (web target) into pkg/.
// Without a Rust toolchain it says so and stops, unless REQUIRE_WASM=1 (the
// release workflow), where a package without its WASM must not ship.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const required = process.env.REQUIRE_WASM === '1'
const has = (command) => spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0

if (!has('cargo') || !has('wasm-bindgen')) {
  const message = 'attest-wasm: cargo or wasm-bindgen is missing, the WASM is not built'
  if (required) {
    console.error(`${message} (REQUIRE_WASM=1)`)
    process.exit(1)
  }
  console.warn(`${message}; pkg/ ${existsSync(path.join(root, 'pkg/relay_button_attest_bg.wasm')) ? 'keeps its previous build' : 'stays empty'}`)
  process.exit(0)
}

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run('cargo', ['build', '--target', 'wasm32-unknown-unknown', '--release', '--locked'])
run('wasm-bindgen', ['--target', 'web', '--out-dir', 'pkg', 'target/wasm32-unknown-unknown/release/relay_button_attest.wasm'])
