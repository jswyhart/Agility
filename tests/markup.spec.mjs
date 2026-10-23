// Selecting document text, marking it up, and saving markup as editable annotations.
import { test, expect } from '@playwright/test';
import { launch, fixture, showPage, tool, drag, textSpan, annotations, selectionText, savedBytes, pageAnnotations, pageBox, PDFLib } from './helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';

let ctx;
test.beforeEach(async () => {
  ctx = await launch({ files: [fixture('sample.pdf')] });
  await showPage(ctx.page);
});
test.afterEach(() => ctx.close());

const markups = async (page) => (await annotations(page)).filter((a) => a.type === 'markup').map((a) => a.kind);

test('drag-selecting text shows the popup; Highlight marks exactly those lines', async () => {
  const { page } = ctx;
  const a = await textSpan(page, 1);
  const b = await textSpan(page, 3);
  await drag(page, { x: a.x + 2, y: a.y + a.height / 2 }, { x: b.x + 150, y: b.y + b.height / 2 });
  expect(await selectionText(page)).toContain('The quick brown fox');
  await expect(page.locator('#sel-popup')).toBeVisible();
  await page.click('#sel-popup [data-markup="highlight"]');
  const [m] = (await annotations(page)).filter((x) => x.type === 'markup');
  expect(m.kind).toBe('highlight');
  expect(m.rects).toHaveLength(3);
});

test('highlighted text can still be selected, and H/U apply to a selection', async () => {
  const { page } = ctx;
  const a = await textSpan(page, 1);
  const line = (x1, x2) => drag(page, { x: a.x + x1, y: a.y + a.height / 2 }, { x: a.x + x2, y: a.y + a.height / 2 });
  await line(2, 200);
  await page.keyboard.press('h');
  await line(2, 120);
  expect((await selectionText(page)).length).toBeGreaterThan(5);
  await page.keyboard.press('u');
  expect(await markups(page)).toEqual(['highlight', 'underline']);
});

test('strike tool marks text by dragging; highlighter off text draws a box', async () => {
  const { page } = ctx;
  await tool(page, 'strike');
  const a = await textSpan(page, 5);
  await drag(page, { x: a.x + 2, y: a.y + a.height / 2 }, { x: a.x + 200, y: a.y + a.height / 2 });
  expect(await markups(page)).toEqual(['strike']);
  await tool(page, 'highlight');
  const pg = await pageBox(page);
  await drag(page, { x: pg.x + 450, y: pg.y + 640 }, { x: pg.x + 560, y: pg.y + 690 });
  expect((await annotations(page)).map((x) => x.type)).toContain('highlight');
});

test('markup is saved as standard annotations and is editable after reopening', async () => {
  const { page, out } = ctx;
  const a = await textSpan(page, 2);
  await drag(page, { x: a.x + 2, y: a.y + a.height / 2 }, { x: a.x + 180, y: a.y + a.height / 2 });
  await page.click('#sel-popup [data-markup="underline"]');
  await tool(page, 'rect');
  const pg = await pageBox(page);
  await drag(page, { x: pg.x + 300, y: pg.y + 600 }, { x: pg.x + 400, y: pg.y + 660 });
  const bytes = await savedBytes(page);
  const subtypes = (await pageAnnotations(bytes)).map((x) => x.subtype);
  expect(subtypes).toEqual(expect.arrayContaining(['Underline', 'Square']));

  const file = path.join(out, 'markup.pdf');
  fs.writeFileSync(file, bytes);
  await page.evaluate((f) => { window.agility.state.dirty = false; return window.agility.openPath(f); }, file);
  await expect.poll(async () => (await annotations(page)).map((x) => x.type + (x.kind ? `:${x.kind}` : '')).sort()).toEqual(['markup:underline', 'rect']);
  // Taken out of the page, so they're not drawn twice.
  const left = await page.evaluate(async () => (await window.agility.state.pages[0].getAnnotations()).map((x) => x.subtype));
  expect(left.filter((t) => t !== 'Widget')).toEqual([]);
});

test('Save Flattened Copy bakes markup into the page', async () => {
  const { page, out } = ctx;
  await tool(page, 'rect');
  const pg = await pageBox(page);
  await drag(page, { x: pg.x + 300, y: pg.y + 600 }, { x: pg.x + 400, y: pg.y + 660 });
  await page.evaluate(() => window.agility.actions['save-flattened']());
  await expect.poll(() => fs.existsSync(path.join(out, 'sample (flattened).pdf'))).toBe(true);
  const bytes = new Uint8Array(fs.readFileSync(path.join(out, 'sample (flattened).pdf')));
  expect((await pageAnnotations(bytes)).filter((x) => x.subtype !== 'Widget')).toEqual([]);
  const doc = await PDFLib.PDFDocument.load(bytes);
  expect(doc.getPageCount()).toBe(3);
});
