// Editing existing PDF text and text boxes: focus, caret placement and
// multi-click selection, plus where edited text lands in the saved file.
import { test, expect } from '@playwright/test';
import { launch, fixture, showPage, tool, isEditing, selectionText, savedBytes, pageText, annotations } from './helpers.mjs';

let ctx;
test.beforeEach(async () => {
  ctx = await launch({ files: [fixture('sample.pdf')] });
  await showPage(ctx.page);
});
test.afterEach(() => ctx.close());

// Center-left of the nth editable line (the Edit Text tool draws them asynchronously).
async function lineBox(page, n) {
  await page.waitForFunction((n) => window.agility.state.views[0].editLayer?.children.length > n, n);
  return page.evaluate((n) => {
    const r = window.agility.state.views[0].editLayer.children[n].getBoundingClientRect();
    return { x: r.x + 60, y: r.y + r.height / 2 };
  }, n);
}

test('clicking a PDF line opens it for editing with the caret at the click', async () => {
  const { page } = ctx;
  await tool(page, 'edittext');
  const p = await lineBox(page, 1);
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => isEditing(page)).toBe(true);
  const caret = await page.evaluate(() => getSelection().focusOffset);
  expect(caret).toBeGreaterThan(0);
  expect(caret).toBeLessThan(20);
});

test('double-click selects a word and triple-click selects the whole line', async () => {
  const { page } = ctx;
  await tool(page, 'edittext');
  let p = await lineBox(page, 1);
  await page.mouse.click(p.x, p.y, { clickCount: 2 });
  await expect.poll(() => selectionText(page)).toMatch(/^\w+$/);
  await page.keyboard.press('Escape');
  p = await lineBox(page, 2);
  await page.mouse.click(p.x, p.y, { clickCount: 3 });
  await expect.poll(() => selectionText(page)).toBe('The quick brown fox jumps over the lazy dog. Folio PDF test content.');
  // One editable box per line, never a duplicate.
  expect((await annotations(page)).filter((a) => a.type === 'text')).toHaveLength(2);
});

test('edited text replaces the original in the saved file at the same position', async () => {
  const { page } = ctx;
  await tool(page, 'edittext');
  const p = await lineBox(page, 0);
  await page.mouse.click(p.x, p.y, { clickCount: 3 });
  await expect.poll(() => isEditing(page)).toBe(true);
  await page.keyboard.type('Edited Title');
  await page.keyboard.press('Escape');
  const text = await pageText(await savedBytes(page));
  expect(text.find((t) => t.str.includes('Sample Document'))).toBeUndefined();
  const edited = text.find((t) => t.str === 'Edited Title');
  expect(edited).toMatchObject({ x: 60, y: 720 });
});

test('clicking an existing text box keeps focus after the mouse is released', async () => {
  const { page } = ctx;
  await tool(page, 'text');
  await page.mouse.click(700, 700);
  await expect.poll(() => isEditing(page)).toBe(true);
  await page.keyboard.type('Hello');
  await page.keyboard.press('Escape');
  const box = await page.locator('.annot.text').boundingBox();
  await page.mouse.click(box.x + 10, box.y + box.height / 2);
  await expect.poll(() => isEditing(page)).toBe(true);
  await page.waitForTimeout(300); // and it stays focused
  expect(await isEditing(page)).toBe(true);
  await page.keyboard.type('X');
  await page.keyboard.press('Escape');
  expect((await annotations(page)).find((a) => a.type === 'text').text).toMatch(/X/);
});

test('Highlight toggles on a selected text box and keeps it selected', async () => {
  const { page } = ctx;
  await tool(page, 'text');
  await page.mouse.click(700, 700);
  await expect.poll(() => isEditing(page)).toBe(true);
  await page.keyboard.type('Note');
  await page.keyboard.press('Escape');
  await tool(page, 'select');
  const box = await page.locator('.annot.text').boundingBox();
  await page.mouse.click(box.x + 10, box.y + box.height / 2);
  await page.keyboard.press('h');
  let a = (await annotations(page)).find((x) => x.type === 'text');
  expect(a.highlight).toBeTruthy();
  expect(await page.evaluate(() => window.agility.state.selected?.id)).toBe(a.id);
  await page.keyboard.press('h');
  a = (await annotations(page)).find((x) => x.type === 'text');
  expect(a.highlight).toBeUndefined();
});
