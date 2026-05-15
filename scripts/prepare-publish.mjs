import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

const repoRoot = process.cwd()
const packagesDir = join(repoRoot, 'packages')

const publishTargets = [
  {
    dir: 'shared-types'
  },
  {
    dir: 'core'
  },
  {
    dir: 'node'
  }
]

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function normalizeDependencies(dependencies, versionsByName) {
  if (!dependencies) return undefined

  const normalized = Object.fromEntries(
    Object.entries(dependencies).map(([name, version]) => {
      if (typeof version === 'string' && version.startsWith('workspace:')) {
        return [name, versionsByName.get(name) ?? version]
      }
      return [name, version]
    })
  )

  return Object.keys(normalized).length > 0 ? normalized : undefined
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
      name: packageJson.name,
      version: packageJson.version,
      description: packageJson.description,
      license: packageJson.license,
      type: packageJson.type,
      main: './index.js',
      types: './index.d.ts',
      exports: {
        '.': {
          types: './index.d.ts',
          import: './index.js'
        }
      },
      publishConfig: {
        access: 'public'
      },
      dependencies: normalizeDependencies(packageJson.dependencies, versionsByName)
    }

    await writeFile(join(distDir, 'package.json'), `${JSON.stringify(publishManifest, null, 2)}\n`)

    const readmePath = join(packageRoot, 'README.md')
    await cp(readmePath, join(distDir, 'README.md'))
  }
}

await main()
