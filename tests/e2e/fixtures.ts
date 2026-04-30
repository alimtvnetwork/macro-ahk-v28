import { test as base, chromium, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/*
 * Chrome Extension E2E — Shared Fixtures
 *
 * Provides both standalone helpers and a custom `test` fixture
 * that auto-launches the extension context for each test.
 *
 * Usage in test files:
 *   import { test, expect } from './fixtures';
 *   test('my test', async ({ context, extensionId, popup, options }) => { ... });
 *
 * Ref: spec/05-chrome-extension/testing/01-e2e-test-specification.md
 */

// ─── Build-Output Resolution ─────────────────────────────────────────
//
// Vite builds the extension into `chrome-extension/` (see vite.config.extension.ts:31
// `DIST_DIR = resolve(__dirname, "chrome-extension")`). Older fixtures pointed at
// `dist/`, which Chromium silently treats as an empty directory and returns
// ERR_FILE_NOT_FOUND for every popup/options navigation.
//
// We probe both candidates and pick the one that actually contains a manifest, so
// the fixture survives any future rename without breaking E2E.

const REPO_ROOT = path.resolve(__dirname, '../..');
const EXTENSION_CANDIDATES = [
  path.join(REPO_ROOT, 'chrome-extension'),
  path.join(REPO_ROOT, 'dist'),
];

function resolveExtensionPath(): string {
  for (const candidate of EXTENSION_CANDIDATES) {
    if (fs.existsSync(path.join(candidate, 'manifest.json'))) {
      return candidate;
    }
  }
  // Fall back to the canonical build dir; Chromium will produce a clear error
  // and the diagnostic message below points at the real cause.
  return EXTENSION_CANDIDATES[0];
}

const EXTENSION_PATH = resolveExtensionPath();
const EXTENSION_FIXTURE_TIMEOUT_MS = 120_000;
const SERVICE_WORKER_TIMEOUT_MS = 30_000;

function ensureExtensionFixtureBudget(testInfo: TestInfo): void {
  if (testInfo.timeout < EXTENSION_FIXTURE_TIMEOUT_MS) {
    testInfo.setTimeout(EXTENSION_FIXTURE_TIMEOUT_MS);
  }
}

// ─── Manifest-Driven Page Paths ──────────────────────────────────────
//
// popup / options HTML paths are declared in the built manifest. Reading them
// from disk eliminates hard-coded paths drifting between vite config + fixture.

interface BuiltManifest {
  action?: { default_popup?: string };
  options_page?: string;
  options_ui?: { page?: string };
}

function readBuiltManifest(): BuiltManifest {
  const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BuiltManifest;
  } catch {
    return {};
  }
}

const BUILT_MANIFEST = readBuiltManifest();
const POPUP_PATH = BUILT_MANIFEST.action?.default_popup ?? 'src/popup/popup.html';
const OPTIONS_PATH =
  BUILT_MANIFEST.options_page ??
  BUILT_MANIFEST.options_ui?.page ??
  'src/options/options.html';

// ─── Standalone Helpers ──────────────────────────────────────────────

/** Launch a persistent context with the extension loaded. */
export async function launchExtension(
  browserType: typeof chromium = chromium
): Promise<BrowserContext> {
  if (!fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
    throw new Error(
      `[fixtures] Built extension not found at ${EXTENSION_PATH}.\n` +
      `Expected manifest.json at "${path.join(EXTENSION_PATH, 'manifest.json')}".\n` +
      `Reason: tests/e2e/global-setup.ts must run "build:extension" before any spec.\n` +
      `Fix: ensure the build step succeeded, or run \`pnpm run build:extension\` manually.`
    );
  }
  return browserType.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
    ],
  });
}

/** Resolve the extension's internal ID from the service worker. */
export async function getExtensionId(context: BrowserContext): Promise<string> {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: SERVICE_WORKER_TIMEOUT_MS });
  const url = sw.url();
  const match = url.match(/chrome-extension:\/\/([^/]+)/);
  if (!match) throw new Error('Could not resolve extension ID from service worker URL');
  return match[1];
}

/** Open the extension popup page. */
export async function openPopup(context: BrowserContext, extensionId: string): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/${POPUP_PATH}`);
  await popup.waitForLoadState('domcontentloaded');
  return popup;
}

/** Open the extension options page. */
export async function openOptions(context: BrowserContext, extensionId: string): Promise<Page> {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/${OPTIONS_PATH}`);
  await options.waitForLoadState('domcontentloaded');
  return options;
}

/** Resolved paths exposed for spec files that navigate manually. */
export const EXTENSION_PATHS = {
  root: EXTENSION_PATH,
  popup: POPUP_PATH,
  options: OPTIONS_PATH,
} as const;

// ─── Shared URL Builders & Page Openers ──────────────────────────────
//
// MANDATORY: Spec files must NEVER hard-code "popup.html" or "options.html",
// nor manually template a `chrome-extension://${id}/...` string. The
// manifest is the single source of truth for both paths — `vite.config.extension.ts`
// can rename them, and any spec that bypasses these helpers will silently
// break the next time the build layout changes (this is exactly what caused
// the ERR_FILE_NOT_FOUND wave that produced this fixture refactor).
//
// Use:
//   - `popupUrl(extensionId)` / `optionsUrl(extensionId)` to build a URL
//   - `openPopupPage(context, id)` / `openOptionsPage(context, id)` to open + wait
//   - `extensionUrl(id, EXTENSION_PATHS.popup)` for any other ad-hoc path
//
// `scripts/check-no-hardcoded-extension-paths.mjs` enforces this contract
// in CI by lint-failing any spec that contains the literals `popup.html`,
// `options.html`, or `chrome-extension://${...}` outside of fixtures.ts.

/** Build any chrome-extension:// URL from a manifest-relative path. */
export function extensionUrl(extensionId: string, relativePath: string): string {
  const clean = relativePath.replace(/^\/+/, '');
  return `chrome-extension://${extensionId}/${clean}`;
}

/** Build the manifest-declared popup URL. */
export function popupUrl(extensionId: string): string {
  return extensionUrl(extensionId, EXTENSION_PATHS.popup);
}

/** Build the manifest-declared options URL. */
export function optionsUrl(extensionId: string): string {
  return extensionUrl(extensionId, EXTENSION_PATHS.options);
}

/**
 * Open a manifest-declared extension page on an existing context and wait for
 * `domcontentloaded`. Use this whenever a spec needs an *additional* page
 * beyond the auto-injected `popup` / `options` fixtures (e.g. cold-start tests
 * that need their own console listener attached before the navigation).
 */
export async function openExtensionPage(
  context: BrowserContext,
  extensionId: string,
  which: 'popup' | 'options',
): Promise<Page> {
  const page = await context.newPage();
  const url = which === 'popup' ? popupUrl(extensionId) : optionsUrl(extensionId);
  await page.goto(url);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

/** Convenience alias: open a fresh popup page on the existing context. */
export function openPopupPage(context: BrowserContext, extensionId: string): Promise<Page> {
  return openExtensionPage(context, extensionId, 'popup');
}

/** Convenience alias: open a fresh options page on the existing context. */
export function openOptionsPage(context: BrowserContext, extensionId: string): Promise<Page> {
  return openExtensionPage(context, extensionId, 'options');
}


// ─── Custom Test Fixture ─────────────────────────────────────────────

type ExtensionFixtures = {
  context: BrowserContext;
  extensionId: string;
  popup: Page;
  options: Page;
};

/**
 * Extended `test` object that provides auto-managed extension fixtures.
 *
 * - `context`     — persistent browser context with extension loaded
 * - `extensionId` — resolved chrome-extension:// ID
 * - `popup`       — page navigated to popup.html
 * - `options`     — page navigated to options.html (lazy, only created on use)
 */
export const test = base.extend<ExtensionFixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: [async ({}, use, testInfo) => {
    ensureExtensionFixtureBudget(testInfo);
    const ctx = await launchExtension();
    await use(ctx);
    await ctx.close();
  }, { timeout: EXTENSION_FIXTURE_TIMEOUT_MS }],

  extensionId: [async ({ context }, use, testInfo) => {
    ensureExtensionFixtureBudget(testInfo);
    const id = await getExtensionId(context);
    await use(id);
  }, { timeout: SERVICE_WORKER_TIMEOUT_MS }],

  popup: async ({ context, extensionId }, use) => {
    const page = await openPopup(context, extensionId);
    await use(page);
  },

  options: async ({ context, extensionId }, use) => {
    const page = await openOptions(context, extensionId);
    await use(page);
  },
});

export { expect } from '@playwright/test';
