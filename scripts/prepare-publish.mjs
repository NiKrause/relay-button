import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const repoRoot = process.cwd()
const packagesDir = join(repoRoot, 'packages')
const repositoryUrl = 'https://github.com/NiKrause/relay-button'
const publishScope = process.env.NPM_SCOPE?.trim().replace(/^@/, '') || null
const dependencyVersionOverrides = (() => {
  const raw = process.env.PUBLISH_DEP_VERSION_OVERRIDES?.trim()
  if (!raw) return {}

  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    throw new Error(
      `Invalid PUBLISH_DEP_VERSION_OVERRIDES JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
})()

const publishTargets = [
  {
    dir: 'shared-types'
  },
  {
    dir: 'aleph-bootstrap'
  },
  {
    dir: 'core'
  },
  {
    dir: 'rootfs'
  },
  {
    dir: 'browser'
  },
  {
    dir: 'playwright'
  },
  {
    dir: 'ui'
  },
  {
    dir: 'node'
  },
  {
    dir: 'attest-wasm'
  }
]

// attest-wasm ships its sources as they are (js/ and the wasm-bindgen web
// build in pkg/), not a tsup bundle, so it keeps its own exports map.
const ATTEST_WASM = '@le-space/attest-wasm'

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function normalizeDependencies(dependencies, versionsByName) {
  if (!dependencies) return undefined

  const normalized = Object.fromEntries(
    Object.entries(dependencies).map(([name, version]) => {
      const overriddenVersion = dependencyVersionOverrides[toPublishedPackageName(name)] ?? dependencyVersionOverrides[name]
      if (typeof overriddenVersion === 'string' && overriddenVersion.trim()) {
        return [toPublishedPackageName(name), overriddenVersion.trim()]
      }
      if (typeof version === 'string' && version.startsWith('workspace:')) {
        return [toPublishedPackageName(name), versionsByName.get(name) ?? version]
      }
      return [name, version]
    })
  )

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizeBin(bin) {
  if (!bin) return undefined
  const normalized = Object.fromEntries(
    Object.entries(bin).map(([name, path]) => [name, path.replace(/^\.\/dist\//, './')])
  )
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function toPublishedPackageName(name) {
  if (!publishScope) return name
  if (!name.startsWith('@')) return name
  return name.replace(/^@[^/]+\//, `@${publishScope}/`)
}

async function main() {
  const packageJsons = new Map()

  for (const target of publishTargets) {
    const packageRoot = join(packagesDir, target.dir)
    const packageJsonPath = join(packageRoot, 'package.json')
    const packageJson = await readJson(packageJsonPath)
    packageJsons.set(packageJson.name, { packageRoot, packageJson })
  }

  const versionsByName = new Map(
    Array.from(packageJsons.entries()).map(([name, { packageJson }]) => [name, packageJson.version])
  )

  for (const { packageRoot, packageJson } of packageJsons.values()) {
    const distDir = join(packageRoot, 'dist')
    await mkdir(distDir, { recursive: true })

    const publishManifest = {
      name: toPublishedPackageName(packageJson.name),
      version: packageJson.version,
      description: packageJson.description,
      license: packageJson.license,
      type: packageJson.type,
      files:
        packageJson.name === '@le-space/ui'
          ? ['shared', 'react', 'svelte', 'styles.css', 'README.md']
          : packageJson.name === ATTEST_WASM
            ? ['js', 'pkg', 'README.md', 'LICENSE-aleph-rs', 'LICENSE-sev']
            : undefined,
      main:
        packageJson.name === '@le-space/ui'
          ? './shared/index.js'
          : packageJson.name === ATTEST_WASM
            ? packageJson.main
            : './index.js',
      types:
        packageJson.name === '@le-space/ui'
          ? './shared/index.d.ts'
          : packageJson.name === ATTEST_WASM
            ? packageJson.types
            : './index.d.ts',
      exports:
        packageJson.name === ATTEST_WASM
          ? packageJson.exports
          : packageJson.name === '@le-space/ui'
          ? {
              '.': {
                types: './shared/index.d.ts',
                import: './shared/index.js',
                default: './shared/index.js'
              },
              './shared': {
                types: './shared/index.d.ts',
                import: './shared/index.js',
                default: './shared/index.js'
              },
              './react': {
                types: './react/index.d.ts',
                import: './react/index.js',
                default: './react/index.js'
              },
              './svelte': './svelte/index.js',
              './styles.css': './styles.css'
            }
          : {
              '.': {
                types: './index.d.ts',
                import: './index.js'
              }
            },
      bin: normalizeBin(packageJson.bin),
      publishConfig: {
        access: 'public'
      },
      repository: {
        type: 'git',
        url: repositoryUrl
      },
      homepage: repositoryUrl,
      bugs: {
        url: `${repositoryUrl}/issues`
      },
      dependencies: normalizeDependencies(packageJson.dependencies, versionsByName),
      peerDependencies: normalizeDependencies(packageJson.peerDependencies, versionsByName)
    }

    await writeFile(join(distDir, 'package.json'), `${JSON.stringify(publishManifest, null, 2)}\n`)

    const readmePath = join(packageRoot, 'README.md')
    await cp(readmePath, join(distDir, 'README.md'))

    if (packageJson.name === ATTEST_WASM) {
      const wasm = join(packageRoot, 'pkg', 'relay_button_attest_bg.wasm')
      if (!(await pathExists(wasm))) {
        throw new Error(`${ATTEST_WASM}: ${wasm} is missing; build it first (pnpm --filter ${ATTEST_WASM} build:publish with Rust and wasm-bindgen)`)
      }
      await cp(join(packageRoot, 'js'), join(distDir, 'js'), { recursive: true })
      // wasm-bindgen writes pkg/.gitignore ("*"), which npm would honour and
      // pack nothing of; copy the files without it.
      await cp(join(packageRoot, 'pkg'), join(distDir, 'pkg'), {
        recursive: true,
        filter: (source) => !source.endsWith('.gitignore')
      })
      for (const license of ['LICENSE-aleph-rs', 'LICENSE-sev']) {
        await cp(join(packageRoot, license), join(distDir, license))
      }
    }

    if (packageJson.name === '@le-space/rootfs') {
      await cp(join(packageRoot, 'reference'), join(distDir, 'reference'), { recursive: true })
    }

    if (packageJson.name === '@le-space/ui') {
      await cp(join(packageRoot, 'src', 'svelte'), join(distDir, 'svelte'), { recursive: true })
      await cp(join(packageRoot, 'src', 'svelte', 'styles', 'theme.css'), join(distDir, 'styles.css'))
    }

    if (packageJson.name === '@le-space/node') {
      await cp(join(packagesDir, 'rootfs', 'reference'), join(distDir, 'reference'), { recursive: true })
      const nodeReferenceDir = join(packageRoot, 'reference')
      if (await pathExists(nodeReferenceDir)) {
        await cp(nodeReferenceDir, join(distDir, 'reference'), { recursive: true })
      }
    }
  }
}

await main()
