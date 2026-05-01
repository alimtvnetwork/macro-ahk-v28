import type { BrowserContext, Page } from '@playwright/test';
import { test, expect, openOptions } from './fixtures';

// CRUD flows touch the Options dashboard mount (~1.7s observed), the
// background project-DB init, and several round-trips through the SW
// message bus. The default 60s test timeout was getting eaten by the
// combination — bump per-test budget so flaky-but-correct flows pass.
test.setTimeout(120_000);

/**
 * E2E-02 — Project CRUD Lifecycle
 *
 * Create, read, update, and delete a project through the Options page.
 *
 * Implementation notes
 * --------------------
 * - The Options page renders <OnboardingFlow /> when
 *   `marco_onboarding_complete` is not set in `chrome.storage.local`. Every
 *   CRUD test must seed that flag *before* the Options page loads, otherwise
 *   the dashboard never mounts and queries like `getByRole('button',
 *   { name: /new project/i })` time out.
 * - The "New Project" trigger comes from `ProjectsListView` (button label
 *   "New Project"). The form lives in `ProjectCreateForm` (placeholder
 *   "Project name", save button "Create") — see those components if
 *   selectors drift.
 *
 * Priority: P0 | Auto: ✅ | Est: 3 min
 */

async function seedOnboardingComplete(context: BrowserContext, extensionId: string) {
  // Seed the onboarding flag via the service worker rather than by opening a
  // full Options page. Opening Options without the flag mounts <OnboardingFlow />,
  // which kicks off heavy background work (project-DB init, manifest seed) that
  // then competes with the actual test's Options mount and pushes the whole
  // flow past the 60s test budget. Writing through the SW skips the UI mount
  // entirely and is effectively instant.
  //
  // MV3 service workers go idle after ~30s and `context.serviceWorkers()` may
  // return a worker handle whose `chrome.*` globals have already been torn
  // down — evaluate() then throws "Cannot read properties of undefined
  // (reading 'local')". Wake the SW with a no-op fetch first, and fall back
  // to seeding via a chrome-extension:// page (which has the same
  // chrome.storage.local origin) if SW evaluate still fails.
  let [sw] = context.serviceWorkers();
  if (!sw) {
    try {
      sw = await context.waitForEvent('serviceworker', { timeout: 5_000 });
    } catch {
      sw = undefined as unknown as typeof sw;
    }
  }

  if (sw) {
    try {
      await sw.evaluate(async () => {
        await chrome.storage.local.set({ marco_onboarding_complete: true });
      });
      return;
    } catch {
      // SW was idle / torn down — fall through to page-based seeding.
    }
  }

  // Fallback: open a lightweight extension page and write from there. The
  // manifest.json page is guaranteed to exist and does not mount any React.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/manifest.json`);
  await page.evaluate(async () => {
    await chrome.storage.local.set({ marco_onboarding_complete: true });
  });
  await page.close();
}

async function waitForProjectsView(options: Page) {
  // Mount budget on the Options page is ~1.7s in dev (see console logs);
  // give the Projects header a generous window so the subsequent
  // "New Project" click does not race the dashboard mount.
  await expect(options.getByRole('heading', { name: /^projects$/i })).toBeVisible({ timeout: 30_000 });
}

async function openCrudOptions(context: BrowserContext, extensionId: string): Promise<Page> {
  await seedOnboardingComplete(context, extensionId);
  const options = await openOptions(context, extensionId);

  // The recorder controller is fixed in the top-right of Options and can cover
  // the Projects toolbar in Chromium. Playwright then retries the click until
  // the test budget expires with "subtree intercepts pointer events". CRUD is
  // not testing the recorder, so neutralize only that overlay for this spec.
  await options.addStyleTag({
    content: '[data-testid^="floating-controller-"] { pointer-events: none !important; }',
  });
  await waitForProjectsView(options);
  return options;
}

test.describe('E2E-02 — Project CRUD Lifecycle', () => {
  test('create a new project', async ({ context, extensionId }) => {
    const options = await openCrudOptions(context, extensionId);

    // ProjectsListView exposes a "New Project" button. Match exactly so we
    // do not collide with "New Script" / "New Config" buttons elsewhere.
    await options.getByRole('button', { name: /^new project$/i }).click();

    // ProjectCreateForm uses placeholders, not <label htmlFor>. Use
    // getByPlaceholder so the selector tracks the actual DOM.
    await options.getByPlaceholder(/project name/i).fill('Test Automation');

    // The save CTA is labeled "Create" (see ProjectCreateForm.tsx:212).
    await options.getByRole('button', { name: /^create$/i }).click();

    await expect(options.getByText('Test Automation').first()).toBeVisible({ timeout: 15_000 });

  });

  test('update project name', async ({ context, extensionId }) => {
    const options = await openCrudOptions(context, extensionId);

    // Setup
    await options.getByRole('button', { name: /^new project$/i }).click();
    await options.getByPlaceholder(/project name/i).fill('Test Automation');
    await options.getByRole('button', { name: /^create$/i }).click();

    // Navigate to project detail. The project card uses the same text as
    // the H2 inside the detail view, so use .first() to disambiguate.
    await options.getByText('Test Automation').first().click();

    // ProjectDetailView renders the name as a click-to-edit <h2>. We must
    // click it to mount the underlying <Input placeholder="Project name">
    // — otherwise getByPlaceholder will time out.
    const heading = options.getByRole('heading', { name: 'Test Automation' });
    await expect(heading).toBeVisible({ timeout: 10000 });
    await heading.click();

    const nameInput = options.getByPlaceholder(/project name/i);
    await expect(nameInput).toBeVisible({ timeout: 5000 });
    await nameInput.clear();
    await nameInput.fill('Test Automation v2');

    // Press Enter to commit edit, then click the "Save project" icon button
    // (rendered only when isDirty=true). aria-label was added so it's
    // discoverable by getByRole. IconButtonWithTooltip is now a plain
    // forwardRef'd <button>, so getByRole picks it up directly.
    await nameInput.press('Enter');
    const saveBtn = options.getByRole('button', { name: /save project/i });
    await expect(saveBtn).toBeVisible({ timeout: 5000 });
    await saveBtn.click();

    await expect(options.getByText('Test Automation v2').first()).toBeVisible({ timeout: 10000 });

  });

  test('delete project cleans up storage', async ({ context, extensionId }) => {
    const options = await openCrudOptions(context, extensionId);

    await options.getByRole('button', { name: /^new project$/i }).click();
    await options.getByPlaceholder(/project name/i).fill('Delete Me');
    await options.getByRole('button', { name: /^create$/i }).click();

    await options.getByText('Delete Me').first().click();

    // ProjectHeader's delete trigger is an icon-only button. The aria-label
    // ("Delete project") was added on IconButtonWithTooltip so role queries
    // can find it without relying on visible text. The button is now a
    // plain forwardRef'd <button>, so AlertDialogTrigger asChild can attach
    // its handler directly (the previous <span><button/></span> wrapper
    // broke asChild and the dialog never opened — this test timed out).
    const deleteTrigger = options.getByRole('button', { name: /delete project/i });
    await expect(deleteTrigger).toBeVisible({ timeout: 10000 });
    await deleteTrigger.click();

    // Confirmation dialog uses an AlertDialogAction labeled "Delete".
    const confirmBtn = options.getByRole('button', { name: /^delete$/i });
    await expect(confirmBtn).toBeVisible({ timeout: 5000 });
    await confirmBtn.click();

    await expect(options.getByText('Delete Me')).not.toBeVisible({ timeout: 10000 });

  });
});
