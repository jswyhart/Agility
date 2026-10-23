// Settings: author name, theme, defaults, persistence.
import { test, expect } from '@playwright/test';
import { launch, fixture, showPage, pageBox, annotations, action, submitModal } from './helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';

test('settings change the author, theme and defaults, and are remembered', async () => {
  const ctx = await launch({ files: [fixture('sample.pdf')] });
  const { page, profile } = ctx;
  await showPage(page);
  // Playwright pins pages to a light color scheme, so ask Electron what it applies.
  const dark = () => ctx.app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
  const themeSource = () => ctx.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
  await action(page, 'preferences');
  await submitModal(page, () => {
    const m = document.querySelector('.modal');
    m.querySelector('.author').value = 'Dana Reviewer';
    m.querySelector('.theme').value = 'light';
    m.querySelector('[data-color="highlight"]').value = '#00ff88';
    m.querySelector('.size').value = '18';
  }, 'Save');
  await expect.poll(themeSource).toBe('light');
  expect(await dark()).toBe(false);
  expect(await page.inputValue('#prop-font')).toBe('18');

  const pg = await pageBox(page);
  await page.click('button[data-tool="note"]');
  await page.mouse.click(pg.x + 500, pg.y + 100);
  expect((await annotations(page)).find((a) => a.type === 'note').author).toBe('Dana Reviewer');
  expect(await page.evaluate(() => window.agility.state.colors.highlight)).toBe('#00ff88');

  await action(page, 'preferences');
  await submitModal(page, () => (document.querySelector('.modal .theme').value = 'dark'), 'Save');
  await expect.poll(themeSource).toBe('dark');
  expect(await dark()).toBe(true);
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'prefs.json'), 'utf8'));
  expect(saved).toMatchObject({ authorName: 'Dana Reviewer', theme: 'dark', fontSize: 18, colors: { highlight: '#00ff88' } });
  await ctx.close();
});
