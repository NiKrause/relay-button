import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'

const repoRoot = process.cwd()

const targets = ['shared-types', 'aleph-bootstrap', 'core', 'rootfs', 'browser', 'playwright', 'ui', 'node']

function parseArgs(argv) {
  const options = {
    dryRun: false,
    tag: 'latest',
    provenance: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--tag') {
      options.tag = argv[index + 1] ?? 'latest'
      index += 1
      continue
    }
    if (arg === '--provenance') {
      options.provenance = true
    }
  }

  return options
}

async function ensureFile(path) {
  await access(path, constants.F_OK)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function runCommand(command, args, cwd, env = process.env) {
  const commandEnv = {
    ...env,
    npm_config_cache: join(repoRoot, '.npm-cache')
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: commandEnv,
      stdio: 'inherit'
    })

    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code ?? 'unknown'}`))
      }
    })

    child.on('error', reject)
  })
}

async function assertNpmPublishAuth() {
  try {
    await runCommand('npm', ['whoami'], repoRoot)
  } catch (error) {
    throw new Error(
      [
        'npm authentication check failed before publish.',
        'The active npm token or login is not valid for https://registry.npmjs.org/.',
        'Refresh ~/.npmrc or export a valid NPM_TOKEN for the @le-space scope, then retry.'
      ].join(' ')
    )
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (!options.dryRun) {
    await assertNpmPublishAuth()
  }

  for (const target of targets) {
    const distDir = join(repoRoot, 'packages', target, 'dist')
    const manifestPath = join(distDir, 'package.json')
    await ensureFile(manifestPath)
    const manifest = await readJson(manifestPath)

    console.log(`Preparing ${manifest.name}@${manifest.version} from ${distDir}`)

    if (options.dryRun) {
      await runCommand('npm', ['pack'], distDir)
      continue
    }

    const publishArgs = ['publish', '--access', 'public', '--tag', options.tag]
    if (options.provenance) {
      publishArgs.splice(3, 0, '--provenance')
    }

    try {
      await runCommand('npm', publishArgs, distDir)
    } catch (error) {
      if (error instanceof Error && error.message.includes('npm publish')) {
        throw new Error(
          [
            `${manifest.name}@${manifest.version} failed to publish.`,
            'If npm reported E404 for a scoped package, that usually means the active npm account/token cannot publish to the @le-space scope.',
            'Validate npm auth with `npm whoami` and confirm the account has publish rights for @le-space.'
          ].join(' ')
        )
      }

      throw error
    }
  }
}

await main()
