// Everyday editing behaviour: copy and paste, reshaping lines, drawing over form
// fields, and searching text that the PDF splits into separate runs.
import { test, expect } from '@playwright/test';
import { launch, fixture, showPage, tool, drag, annotations, pageBox, action, savedBytes, pageAnnotations } from './helpers.mjs';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test('copy and paste duplicate an annotation, offset and selected; cut removes it', async () => {
  const ctx = await launch({ files: [fixture('sample.pdf')] });
  const { page } = ctx;
  await showPage(page);
  const pg = await pageBox(page);
  await tool(page, 'rect');
  await drag(page, { x: pg.x + 80, y: pg.y + 600 }, { x: pg.x + 200, y: pg.y + 680 });
  await tool(page, 'select');
  const [rect] = await annotations(page);
  await page.locator(`.annot[data-id="${rect.id}"]`).click({ position: { x: 4, y: 40 } });

  await page.keyboard.press(`${MOD}+C`);
  await page.keyboard.press(`${MOD}+V`);
  await page.keyboard.press(`${MOD}+V`);
  const list = await annotations(page);
  expect(list.map((a) => a.type)).toEqual(['rect', 'rect', 'rect']);
  expect(new Set(list.map((a) => a.id)).size).toBe(3);
  expect([list[1].x - rect.x, list[2].x - rect.x]).toEqual([12, 24]); // each paste steps further
  expect(await page.evaluate(() => window.agility.state.selected?.id)).toBe(list[2].id);

  await page.keyboard.press(`${MOD}+X`);
  expect(await annotations(page)).toHaveLength(2);
  await action(page, 'undo');
  expect(await annotations(page)).toHaveLength(3);

  // Pastes are real annotations in the saved file.
  const saved = (await pageAnnotations(await savedBytes(page))).filter((a) => a.subtype === 'Square');
  expect(saved).toHaveLength(3);
  await ctx.close();
});

test('copying selected document text still copies the text, not an annotation', async () => {
  const ctx = await launch({ files: [fixture('sample.pdf')] });
  const { page } = ctx;
  await showPage(page);
  const pg = await pageBox(page);
  await tool(page, 'rect');
  await drag(page, { x: pg.x + 80, y: pg.y + 600 }, { x: pg.x + 200, y: pg.y + 680 });
  await tool(page, 'select');
  const [rect] = await annotations(page);
  await page.locator(`.annot[data-id="${rect.id}"]`).click({ position: { x: 4, y: 40 } });
  expect(await page.evaluate(() => window.agility.state.selected?.id)).toBe(rect.id);
  const copied = await page.evaluate(() => {
    const span = [...window.agility.state.views[0].text.querySelectorAll('span')].find((s) => s.textContent.trim());
    getSelection().selectAllChildren(span);
    const dt = new DataTransfer();
    document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
    return dt.types.includes('application/x-agility-annotation');
  });
  expect(copied).toBe(false);
  await ctx.close();
});

test('a line or arrow can be reshaped by dragging either end', async () => {
  const ctx = await launch({ files: [fixture('sample.pdf')] });
  const { page } = ctx;
  await showPage(page);
  const pg = await pageBox(page);
  await tool(page, 'arrow');
  await drag(page, { x: pg.x + 100, y: pg.y + 620 }, { x: pg.x + 250, y: pg.y + 620 });
  await tool(page, 'select');
  const [a] = await annotations(page);
  await page.mouse.click(pg.x + 175, pg.y + 620);
  const end1 = await page.locator(`.annot[data-id="${a.id}"] .handle.end`).first().boundingBox();
  await drag(page, { x: end1.x + end1.width / 2, y: end1.y + end1.height / 2 }, { x: end1.x + end1.width / 2 - 20, y: end1.y + end1.height / 2 - 40 });
  const [b] = await annotations(page);
  expect([Math.round(b.x1 - a.x1), Math.round(b.y1 - a.y1)]).toEqual([-20, -40]);
  expect([b.x2, b.y2]).toEqual([a.x2, a.y2]);
  await action(page, 'undo');
  expect((await annotations(page))[0].x1).toBe(a.x1);
  await ctx.close();
});

test('drawing tools draw over form fields; the Select tool still fills them', async () => {
  const ctx = await launch({ files: [fixture('sample.pdf')] });
  const { page } = ctx;
  await showPage(page);
  const field = await page.locator('.forms [data-field="name"]').boundingBox();
  await tool(page, 'ellipse');
  await drag(page, { x: field.x + 10, y: field.y + 5 }, { x: field.x + 120, y: field.y + 60 });
  expect((await annotations(page)).map((a) => a.type)).toEqual(['ellipse']);
  await tool(page, 'select');
  await page.locator('.forms [data-field="name"]').click();
  await page.keyboard.type('Ada');
  await expect(page.locator('.forms [data-field="name"]')).toHaveValue('Ada');
  await ctx.close();
});

test('search finds phrases split across separate text runs and highlights every piece', async () => {
  const ctx = await launch({ files: [fixture('chromium.pdf')] });
  const { page } = ctx;
  for (const [q, pieces] of [['Invoice #4471', 3], ['grew 12% year', 5], ['demand.', 2]]) {
    await page.fill('#find', q);
    await expect(page.locator('#find-status')).toHaveText('1 of 1');
    await expect(page.locator('.hit.current')).toHaveCount(pieces);
    await page.keyboard.press('Escape');
  }
  await ctx.close();
});
