// Page operations, undo/redo, and the page tools menu.
import { test, expect } from '@playwright/test';
import { launch, fixture, showPage, action, submitModal, savedBytes, pageText, openPdf, drag, pageBox, PDFLib } from './helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';

let ctx;
test.beforeEach(async () => {
  ctx = await launch({ files: [fixture('sample.pdf')] });
  await showPage(ctx.page);
});
test.afterEach(() => ctx.close());

const rotations = (page) => page.evaluate(() => window.agility.state.pages.map((p) => p.rotate));

test('rotate, insert and delete pages with undo and redo', async () => {
  const { page } = ctx;
  await page.click('[data-action="rotate-cw"]');
  await expect.poll(() => rotations(page)).toEqual([90, 0, 90]);
  await page.click('[data-action="insert-blank"]');
  await expect.poll(() => page.evaluate(() => window.agility.state.pages.length)).toBe(4);
  await page.click('[data-action="undo"]');
  await expect.poll(() => page.evaluate(() => window.agility.state.pages.length)).toBe(3);
  await page.click('[data-action="undo"]');
  await expect.poll(() => rotations(page)).toEqual([0, 0, 90]);
  await page.click('[data-action="redo"]');
  await expect.poll(() => rotations(page)).toEqual([90, 0, 90]);
});

test('extract and split write the right pages', async () => {
  const { page, out } = ctx;
  await action(page, 'extract-pages');
  await submitModal(page, () => (document.querySelector('.modal .r').value = '2-3'), 'Extract');
  const extracted = path.join(out, 'sample - pages 2-3.pdf');
  await expect.poll(() => fs.existsSync(extracted)).toBe(true);
  expect((await PDFLib.PDFDocument.load(fs.readFileSync(extracted))).getPageCount()).toBe(2);
  await action(page, 'split');
  await submitModal(page, null, 'Split');
  await expect.poll(() => fs.readdirSync(out).filter((f) => /- page \d\.pdf$/.test(f)).length).toBe(3);
});

test('page numbers, header/footer and watermark are added to every page', async () => {
  const { page } = ctx;
  await action(page, 'page-numbers');
  await submitModal(page, () => (document.querySelector('.modal .fmt').value = 'Page {n} of {total}'), 'Add numbers');
  await expect(page.locator('#toast')).toContainText('Numbered 3 pages');
  await action(page, 'header-footer');
  await submitModal(page, () => (document.querySelector('.modal .hl').value = 'Agility header'), 'Add');
  await expect(page.locator('#toast')).toContainText('header');
  await action(page, 'watermark');
  await submitModal(page, null, 'Add watermark');
  await expect(page.locator('#toast')).toContainText('watermark');
  const bytes = await savedBytes(page);
  for (const n of [1, 2, 3]) {
    const strs = (await pageText(bytes, n)).map((t) => t.str);
    expect(strs).toEqual(expect.arrayContaining([`Page ${n} of 3`, 'Agility header', 'CONFIDENTIAL']));
  }
});

test('crop hides the outside of the page and keeps markup in place', async () => {
  const { page } = ctx;
  await page.evaluate(() => {
    const s = window.agility.state;
    (s.annotations[s.pageIds[0]] ||= []).push({ id: 'r', type: 'rect', color: '#e5484d', width: 2, x: 100, y: 100, w: 50, h: 30 });
  });
  await action(page, 'tool-crop');
  const pg = await pageBox(page);
  await drag(page, { x: pg.x + 50, y: pg.y + 50 }, { x: pg.x + 450, y: pg.y + 350 });
  await submitModal(page, null, 'Crop');
  await expect.poll(() => page.evaluate(() => window.agility.state.pages[0].view)).toEqual([50, 442, 450, 742]);
  expect(await page.evaluate(() => window.agility.state.annotations[window.agility.state.pageIds[0]][0].x)).toBe(50);
});

test('save with password encrypts with AES and applies permissions', async () => {
  const { page, out } = ctx;
  await action(page, 'save-password');
  await submitModal(page, () => {
    document.querySelector('.modal .p1').value = 'secret';
    document.querySelector('.modal .p2').value = 'secret';
    document.querySelector('.modal .cp').checked = false;
  }, 'Save');
  const file = path.join(out, 'sample (protected).pdf');
  await expect.poll(() => fs.existsSync(file)).toBe(true);
  const bytes = new Uint8Array(fs.readFileSync(file));
  await expect(openPdf(bytes)).rejects.toThrow(/password/i);
  await expect(openPdf(bytes, 'wrong')).rejects.toThrow(/password/i);
  expect((await pageText(bytes, 1, 'secret'))[0].str).toBe('Sample Document — Page 1');
});

test('export images and text', async () => {
  const { page, out } = ctx;
  await action(page, 'export-images');
  await submitModal(page, () => (document.querySelector('.modal .r').value = '1'), 'Export');
  await expect.poll(() => fs.existsSync(path.join(out, 'sample - page 1.png')), { timeout: 20000 }).toBe(true);
  expect(fs.readFileSync(path.join(out, 'sample - page 1.png')).subarray(1, 4).toString()).toBe('PNG');
  await action(page, 'export-text');
  await expect.poll(() => fs.existsSync(path.join(out, 'sample.txt'))).toBe(true);
  expect(fs.readFileSync(path.join(out, 'sample.txt'), 'utf8')).toContain('--- Page 3 ---');
});
