import { defineConfig, devices } from '@playwright/test';

/**
 * Browser smoke tests.
 *
 * The server under test is the real production shape: `world-web` serving the compiled client
 * from disk, with the in-memory adapter and local seeding. That means the test exercises the
 * same routes, the same static caching headers and the same client bundle that ship in the
 * container — only the storage adapter differs.
 */

const PORT = 8099;

// The whole spectator journey runs as one test, and CI has no GPU: swiftshader rasterises in
// software, so it is roughly twice as slow as a local run. It got slower again once the terrain
// normals were fixed, because a surface that takes directional light also resolves shadows, and
// the shadow pass had previously been drawing into a scene that could not show it. 50s locally,
// ~96s on a runner, so the budget is set well clear of both rather than at the boundary.
const TEST_TIMEOUT_MS = 180_000;

export default defineConfig({
  testDir: './tests/browser',
  outputDir: './test-results',
  timeout: TEST_TIMEOUT_MS,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] === undefined ? 0 : 1,
  reporter: process.env['CI'] === undefined ? [['list']] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // CI runners have no GPU. SwiftShader gives WebGL2 in software so the canvas really
        // renders instead of silently falling back to the error overlay.
        launchOptions: {
          args: [
            '--use-gl=swiftshader',
            '--enable-unsafe-swiftshader',
            '--disable-gpu-sandbox',
            '--ignore-gpu-blocklist',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'node scripts/serve-for-tests.mjs',
    url: `http://127.0.0.1:${String(PORT)}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'test',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      AUTOCOSM_STORAGE_DRIVER: 'memory',
      AUTOCOSM_ALLOW_LOCAL_SEEDING: 'true',
      AUTOCOSM_LOG_LEVEL: 'warn',
      AUTOCOSM_CREATOR_SIGNING_KEY: 'playwright-smoke-test-signing-key',
      // Tight loops so the world has visibly advanced by the time assertions run.
      AUTOCOSM_DEV_TICK_INTERVAL_MS: '900',
      AUTOCOSM_DEV_THINK_INTERVAL_MS: '1200',
    },
  },
});
