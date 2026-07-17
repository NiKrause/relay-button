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
  }
]

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
          : undefined,
      main: packageJson.name === '@le-space/ui' ? './shared/index.js' : './index.js',
      types: packageJson.name === '@le-space/ui' ? './shared/index.d.ts' : './index.d.ts',
      exports:
        packageJson.name === '@le-space/ui'
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
