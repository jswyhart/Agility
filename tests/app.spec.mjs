// App shell: tabs, recent files, crash recovery, OCR, Fill & Sign.
import { test, expect } from '@playwright/test';
import { launch, fixture, docTab, tabStrip, showPage, pageBox, annotations, submitModal, savedBytes, pageText } from './helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';

test('each file opens in its own tab with separate state', async () => {
  const ctx = await launch({ files: [fixture('sample.pdf'), fixture('scanned.pdf')] });
  const second = await docTab(ctx.app, 1);
  const names = await Promise.all([ctx.page, second].map((p) => p.evaluate(() => `${window.agility.state.fileName}:${window.agility.state.pages.length}`)));
  expect(names.sort()).toEqual(['sample.pdf:3', 'scanned.pdf:1']);
  await expect.poll(() => tabStrip(ctx.app).locator('.tab').count()).toBe(2);
  const recent = JSON.parse(fs.readFileSync(path.join(ctx.profile, 'recent.json'), 'utf8'));
  expect(recent.map((p) => path.basename(p)).sort()).toEqual(['sample.pdf', 'scanned.pdf']);
  await ctx.close();
});

test('unsaved changes are restored after a crash', async () => {
  const first = await launch({ files: [fixture('sample.pdf')] });
  await first.page.evaluate(() => {
    const s = window.agility.state;
    (s.annotations[s.pageIds[0]] ||= []).push({ id: 'r', type: 'rect', color: '#e5484d', width: 2, x: 100, y: 100, w: 50, h: 30 });
    s.dirty = true;
    s.version = (s.version || 0) + 1;
  });
  await expect.poll(() => fs.existsSync(path.join(first.profile, 'Recovery')) && fs.readdirSync(path.join(first.profile, 'Recovery')).length, { timeout: 15000 }).toBe(2);
  first.app.process().kill('SIGKILL');
  const second = await launch({ profile: first.profile, env: { AGILITY_RESTORE: 'restore' } });
  const tab = await docTab(second.app, 0);
  expect((await annotations(tab)).map((a) => a.type)).toEqual(['rect']);
  expect(await tab.evaluate(() => window.agility.state.dirty)).toBe(true);
  await second.close();
});

test('OCR makes a scanned page searchable and saves an invisible text layer', async () => {
  const ctx = await launch({ files: [fixture('scanned.pdf')] });
  const { page } = ctx;
  await showPage(page);
  await page.click('[data-action="ocr"]');
  await submitModal(page, null, 'Recognize');
  await expect(page.locator('#toast')).toContainText('Recognized', { timeout: 60000 });
  await page.fill('#find', 'lazy dog');
  await expect(page.locator('#find-status')).toHaveText(/of 12/);
  const words = (await pageText(await savedBytes(page))).map((t) => t.str);
  expect(words).toEqual(expect.arrayContaining(['quick', 'brown', 'fox']));
  await ctx.close();
});

test('Fill & Sign places checkmarks and dates, adds fields, and remembers signatures', async () => {
  const ctx = await launch({ files: [fixture('sample.pdf')] });
  const { page } = ctx;
  await showPage(page);
  const pg = await pageBox(page);
  const fill = async (item) => {
    await page.click('#fill-btn');
    await page.click(`[data-fill="${item}"]`);
  };
  await fill('check');
  await page.mouse.click(pg.x + 470, pg.y + 300);
  await page.mouse.click(pg.x + 510, pg.y + 300);
  await page.keyboard.press('Escape');
  await fill('date');
  await page.mouse.click(pg.x + 400, pg.y + 470);
  const types = (await annotations(page)).map((a) => a.type + (a.kind ? `:${a.kind}` : ''));
  expect(types).toEqual(['mark:check', 'mark:check', 'text']);

  await fill('field-text');
  await page.mouse.move(pg.x + 350, pg.y + 520);
  await page.mouse.down();
  await page.mouse.move(pg.x + 520, pg.y + 545, { steps: 5 });
  await page.mouse.up();
  await submitModal(page, () => (document.querySelector('.modal .f-name').value = 'Company'), 'Add field');
  await expect(page.locator('.forms [data-field="Company"]')).toBeVisible();

  await fill('signature');
  await page.click('.tab[data-tab="type"]');
  await page.keyboard.type('Test Signer');
  await page.locator('.modal button', { hasText: 'Use signature' }).click();
  await page.mouse.click(pg.x + 450, pg.y + 680);
  await fill('signature');
  await expect(page.locator('.sig-saved .sig-item')).toHaveCount(1);
  await ctx.close();
});
