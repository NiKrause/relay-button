import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { actionLog, appendGithubOutput, appendGithubSummary } from '../src/github-outputs.ts'

test('appendGithubOutput writes name=value pairs when GITHUB_OUTPUT is set', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-button-output-'))
  const file = join(dir, 'output.txt')
  await appendGithubOutput('foo', 'bar', { GITHUB_OUTPUT: file })
  const content = await readFile(file, 'utf8')
  assert.equal(content, 'foo=bar\n')
})

test('appendGithubOutput uses multiline syntax for newline-containing values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-button-output-'))
  const file = join(dir, 'output.txt')
  await appendGithubOutput('json', '{\n  "ok": true\n}', { GITHUB_OUTPUT: file })
  const content = await readFile(file, 'utf8')
  assert.match(content, /^json<<__ALEPH_OUTPUT_[^\n]+__\n\{\n  "ok": true\n\}\n__ALEPH_OUTPUT_[^\n]+__\n$/)
})

test('appendGithubSummary writes multiline summary content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-button-summary-'))
  const file = join(dir, 'summary.txt')
  await appendGithubSummary(['# Heading', '', 'hello'], { GITHUB_STEP_SUMMARY: file })
  const content = await readFile(file, 'utf8')
  assert.equal(content, '# Heading\n\nhello\n')
})

test('actionLog emits GitHub annotation format when enabled', () => {
  let output = ''
  const stderr = {
    write(chunk: string) {
      output += chunk
      return true
    }
  } as unknown as NodeJS.WriteStream

  actionLog('warning', 'line one\nline two', { githubActions: true, stderr })
  assert.match(output, /::warning::line one%0Aline two/)
  assert.match(output, /line one\nline two/)
})
