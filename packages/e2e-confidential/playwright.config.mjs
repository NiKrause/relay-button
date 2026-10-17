import { defineConfig } from '@playwright/test'

const port = Number(process.env.E2E_PORT ?? 4431)

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  // One real VM per run: no retries, no parallel workers.
  workers: 1,
  retries: 0,
  timeout: 45 * 60_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node ./server.mjs',
    url: `http://127.0.0.1:${port}/config.json`,
    reuseExistingServer: false,
    stdout: 'pipe',
    timeout: 120_000,
  },
})
