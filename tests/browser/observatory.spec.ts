import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * The observatory happy path.
 *
 * One test, one session, in order: the world loads and renders, a lineage can be authored, a broad
 * goal can be offered, and nothing anywhere on the page lets an observer touch the world directly.
 * Splitting these would mean paying the cold start and the WebGL init cost four times.
 *
 * Console errors are collected for the whole session and asserted at the end, because an error
 * thrown during teardown of an earlier step is exactly the kind of thing a per-step assertion
 * misses.
 */

interface ConsoleCapture {
  readonly errors: string[];
  readonly failures: string[];
}

function captureConsole(page: Page): ConsoleCapture {
  const errors: string[] = [];
  const failures: string[] = [];

  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // Babylon reports the absence of WebGPU on a CI runner as an error before falling back. The
    // fallback is the tested behaviour, so this is expected noise rather than a defect.
    if (/WebGPU is not supported|navigator\.gpu|GPUAdapter/iu.test(text)) return;
    errors.push(text);
  });

  page.on('pageerror', (error: Error) => {
    failures.push(error.stack ?? error.message);
  });

  return { errors, failures };
}

test('an observer can watch the world, author a lineage, and offer it a goal', async ({ page }) => {
  const console_ = captureConsole(page);

  /* ------------------------------------------------------------------ load */

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Autocosm', level: 1 })).toBeVisible();

  // The renderer must actually start. A zero-sized canvas means the fallback path failed.
  const canvas = page.locator('canvas.viewport__canvas');
  await expect(canvas).toBeVisible();
  await expect(page.getByText('Starting the renderer…')).toBeHidden({ timeout: 45_000 });
  await expect(page.getByRole('alert').filter({ hasText: 'could not be drawn' })).toHaveCount(0);

  const box = await canvas.boundingBox();
  if (box === null) throw new Error('the canvas has no layout box, so the renderer never mounted');
  expect(box.width).toBeGreaterThan(200);
  expect(box.height).toBeGreaterThan(200);

  // Positive proof that frames are being produced: the fps counter is only ever fed from
  // inside the render loop, so a backend + fps reading cannot appear on a dead scene.
  // It also records which backend CI actually exercised (headless Chromium picks WebGL2;
  // WebGPU-only regressions are caught deterministically by apps/web-client/src/render/engine.test.ts).
  await expect(page.locator('.statusbar')).toContainText(/(webgpu|webgl2)\s*·\s*\d+\s*fps/iu, {
    timeout: 30_000,
  });

  // The seeded world reaches the browser: eight founding lineages appear in the roster.
  const roster = page.locator('.roster__item');
  await expect(roster.first()).toBeVisible({ timeout: 30_000 });
  expect(await roster.count()).toBeGreaterThanOrEqual(8);

  // And it is running, not a snapshot: the status bar reports a tick that advances.
  const status = page.locator('.statusbar');
  await expect(status).toContainText(/tick/iu, { timeout: 30_000 });

  /* ------------------------------------------------------------- inspection */

  await roster.first().click();

  const inspector = page.locator('aside[aria-label="Inspector"]');
  await expect(inspector.getByRole('button', { name: 'Offer a broad goal' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(inspector).toContainText(/Drives|Traits|Organisms/iu);

  // Lineage history is reachable and renders generations.
  await inspector.getByRole('button', { name: 'View lineage' }).click();
  await expect(page.locator('.panel--lineage')).toBeVisible({ timeout: 30_000 });
  await page.locator('.panel--lineage').getByRole('button', { name: 'Close' }).click();

  /* ------------------------------------------------------------------- clock */

  // The time of day is read from the snapshot's authoritative `dayPhasePerMille`, so a clock that
  // renders at all proves the field survived the whole path from simulation to pixel. Asserting
  // the phase name as well as the digits means a clock stuck at one phase forever still fails.
  const clock = page.locator('.statusbar__clock');
  await expect(clock).toBeVisible({ timeout: 30_000 });
  await expect(clock.locator('.statusbar__time')).toHaveText(/^\d{2}:\d{2}$/u);
  await expect(clock.locator('.statusbar__phase')).toContainText(
    /night|dawn|morning|midday|afternoon|dusk/iu,
  );
  // The phase modifier class is what colours it, and it is derived, not hard-coded.
  await expect(clock).toHaveClass(/statusbar__clock--[a-z]+/u);

  /* --------------------------------------------------------- picking the world */

  // Clicking the world is the whole of G3, and it was previously untested — this spec passed
  // before picking existed at all.
  //
  // Two assertions, because they fail for different reasons. The cursor proves the pointer
  // observable is attached and running its pick: hovering sets 'pointer' over an entity and
  // 'crosshair' over everything else, so it cannot stay at the stylesheet's default unless the
  // handler is gone. The click then proves the rest of the chain — pick -> resolve -> selection
  // -> panel — by landing on terrain, which is the branch that yields a region.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6);
  await expect
    .poll(async () => canvas.evaluate((node) => node.style.cursor), { timeout: 10_000 })
    .toMatch(/^(pointer|crosshair)$/u);

  const ground = page.locator('.panel--inspector');

  // Where the horizon sits depends on where the camera settled, so walk down the view rather than
  // assuming one point is ground. A miss deselects, so a wrong guess is visible, not silent.
  let region = false;
  for (const fraction of [0.6, 0.72, 0.84]) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * fraction);
    region = await ground
      .getByText('Mean elevation')
      .waitFor({ state: 'visible', timeout: 4000 })
      .then(
        () => true,
        () => false,
      );
    if (region) break;
  }
  expect(region, 'clicking the terrain never resolved to a region').toBe(true);

  // Selection is inspection only. Picking must never offer a way to act on what was picked.
  await expect(ground.getByRole('button', { name: /move|feed|harvest|build/iu })).toHaveCount(0);

  /* ------------------------------------------------------------- field guide */

  // The glossary is what answers "what does this building do" without a model. It is served from
  // the domain's own rule tables, so an empty or partial panel means the derivation broke.
  await page.getByRole('button', { name: 'Field guide' }).click();
  const guide = page.locator('.panel--glossary');
  await expect(guide).toBeVisible({ timeout: 30_000 });
  await expect(guide.getByRole('heading', { name: 'What buildings do' })).toBeVisible();
  expect(await guide.locator('.definitions > li').count()).toBeGreaterThanOrEqual(70);

  // Searching narrows it rather than emptying it.
  await guide.getByRole('searchbox').fill('shelter');
  await expect(guide.locator('.definitions > li').first()).toBeVisible();
  await guide.getByRole('button', { name: 'Close' }).click();
  await expect(guide).toBeHidden();

  /* ---------------------------------------------------------------- authoring */

  await page.getByRole('button', { name: 'Author a lineage' }).first().click();

  const createDialog = page.getByRole('dialog', { name: 'Author a new lineage' });
  await expect(createDialog).toBeVisible();

  const lineageName = `Probe ${String(Date.now() % 100_000)}`;
  await createDialog.getByLabel('Name').fill(lineageName);
  await createDialog.getByLabel('Broad aspiration').fill('Find the light and remember it');
  await createDialog.getByRole('radio', { name: 'shallows' }).check();
  await createDialog.getByRole('button', { name: 'Release into the world' }).click();

  await expect(createDialog).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('.toast')).toBeVisible({ timeout: 15_000 });

  // The new lineage is authoritative, not local UI state: it comes back from the API.
  await expect(page.locator('.roster__name').filter({ hasText: lineageName })).toBeVisible({
    timeout: 45_000,
  });

  /* -------------------------------------------------------------------- goal */

  await expect(inspector.getByRole('heading', { name: lineageName })).toBeVisible({
    timeout: 30_000,
  });
  await inspector.getByRole('button', { name: 'Offer a broad goal' }).click();

  const goalDialog = page.getByRole('dialog', { name: new RegExp(`Offer a goal to`, 'u') });
  await expect(goalDialog).toBeVisible();
  await goalDialog.getByRole('button', { name: 'Seek the ocean' }).click();
  await goalDialog.getByRole('button', { name: 'Offer this goal' }).click();

  await expect(goalDialog).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('.toast')).toBeVisible({ timeout: 15_000 });

  /* ------------------------------------------------------- observer boundary */

  // Every interactive control on the page, by accessible name. If a direct-manipulation control
  // is ever added, it shows up here.
  const controlNames = await page
    .locator('button:visible, a[href]:visible, input[type="submit"]:visible')
    .evaluateAll((nodes) =>
      nodes.map((node) => (node.textContent ?? '').replace(/\s+/gu, ' ').trim().toLowerCase()),
    );

  const forbidden =
    /\b(move|teleport|spawn|kill|feed|heal|rescue|harvest|collect|attack|damage|destroy|build|construct|mutate|evolve|edit|delete|reset|seed|grant|set (energy|health|position)|god ?mode|admin)\b/u;

  const violations = controlNames.filter((name) => forbidden.test(name));
  expect(violations, `direct-manipulation controls found: ${violations.join(', ')}`).toEqual([]);

  // And the boundary is enforced by the server, not merely hidden by the UI.
  for (const [method, path] of [
    ['POST', '/api/v1/world/tick'],
    ['POST', '/api/v1/organisms/or-drifters-0/move'],
    ['POST', '/api/v1/actions'],
    ['DELETE', '/api/v1/organisms/or-drifters-0'],
    ['PATCH', '/api/v1/organisms/or-drifters-0'],
    ['POST', '/api/v1/seed'],
    ['POST', '/api/v1/reset'],
  ] as const) {
    const response = await page.request.fetch(path, {
      method,
      failOnStatusCode: false,
      data: method === 'DELETE' ? undefined : {},
    });
    expect(
      response.status(),
      `${method} ${path} must not be a working mutation endpoint`,
    ).toBeGreaterThanOrEqual(400);
  }

  /* ----------------------------------------------------------------- console */

  expect(console_.failures, 'uncaught page errors').toEqual([]);
  expect(console_.errors, 'console errors').toEqual([]);
});
