import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Playwright configuration for Chrome Extension E2E tests.
 *
 * Extensions require a headed Chromium instance with --load-extension,
 * so only a single "chromium" project is defined (no Firefox/WebKit).
 *
 * Ref: spec/05-chrome-extension/testing/01-e2e-test-specification.md
 */

const EXTENSION_DIR = path.resolve(__dirname, 'dist'); // adjust to actual build output

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',

  /* Fail fast in CI; allow retries locally */
  retries: process.env.CI ? 0 : 1,

  /* Each extension E2E flow can include SW cold-start + Options boot. */
  timeout: 120_000,
  expect: { timeout: 10_000 },

  /* Parallelism: disabled — extension tests share a single browser context */
  workers: 1,
  fullyParallel: false,

  /* Reporters */
  reporter: process.env.CI
    ? [
        ['html', { open: 'never', outputFolder: 'test-results/html' }],
        ['junit', { outputFile: 'test-results/junit.xml' }],
        ['github'],
        // Captures chrome-extension/ dir + resolved manifest fields whenever
        // a test fails with ERR_FILE_NOT_FOUND while navigating chrome-extension://…
        ['./tests/e2e/reporters/extension-artifacts-reporter.ts'],
      ]
    : [
        ['list'],
        ['html', { open: 'on-failure', outputFolder: 'test-results/html' }],
        ['./tests/e2e/reporters/extension-artifacts-reporter.ts'],
      ],

  /* Output directories */
  outputDir: 'test-results/artifacts',

  /* Global setup: build the extension before tests run */
  globalSetup: './tests/e2e/global-setup.ts',

  projects: [
    {
      name: 'chrome-extension',
      use: {
        /* Extensions only work in headed Chromium */
        headless: false,
        channel: 'chromium',

        /* Load the unpacked extension */
        launchOptions: {
          args: [
            `--disable-extensions-except=${EXTENSION_DIR}`,
            `--load-extension=${EXTENSION_DIR}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-default-apps',
          ],
        },

        /* Artifacts on failure */
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
        video: 'retain-on-failure',

        /* Viewport matching typical popup/options dimensions */
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
});
