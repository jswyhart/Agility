// Fonts for written text: Unicode support and reuse of the document's font.
import { test, expect } from '@playwright/test';
import { launch, fixture, showPage, tool, savedBytes, annotations, pageAnnotations, isEditing, PDFLib } from './helpers.mjs';

test('text outside Latin-1 is kept, not replaced with question marks', async () => {
  const ctx = await launch({ files: [fixture('sample.pdf')] });
  const { page } = ctx;
  await showPage(page);
  await tool(page, 'text');
  await page.mouse.click(700, 700);
  await expect.poll(() => isEditing(page)).toBe(true);
  await page.keyboard.insertText('Привет, κόσμε ✓');
  await page.keyboard.press('Escape');
  await expect(page.locator('.annot.text .content')).toHaveCSS('font-family', /DejaVu/);
  const saved = (await pageAnnotations(await savedBytes(page))).find((a) => a.subtype === 'FreeText');
  expect(saved.contentsObj.str).toBe('Привет, κόσμε ✓');
  await ctx.close();
});

test('edited PDF text reuses the font the line was set in', async () => {
  const ctx = await launch({ files: [fixture('chromium.pdf')] });
  const { page } = ctx;
  await showPage(page, 0, '1.5');
  // Needs the line's font (Georgia) installed, as on macOS and Windows.
  const hasGeorgia = await page.evaluate(async () => !!(await window.api.findFont(['Georgia'])));
  test.skip(!hasGeorgia, 'Georgia is not installed here');
  await tool(page, 'edittext');
  await page.waitForFunction(() => window.agility.state.views[0].editLayer?.children.length > 1);
  const r = await page.evaluate(() => {
    const b = window.agility.state.views[0].editLayer.children[1].getBoundingClientRect();
    return { x: b.x + 30, y: b.y + b.height / 2 };
  });
  await page.mouse.click(r.x, r.y);
  await expect.poll(() => isEditing(page), { timeout: 20000 }).toBe(true);
  await page.keyboard.press('Escape');
  expect((await annotations(page)).find((a) => a.type === 'text').docFont).toBeTruthy();
  const doc = await PDFLib.PDFDocument.load(await savedBytes(page));
  const fonts = [...doc.context.enumerateIndirectObjects()]
    .map(([, o]) => o instanceof PDFLib.PDFDict && o.get(PDFLib.PDFName.of('Type'))?.toString() === '/Font' && o.get(PDFLib.PDFName.of('BaseFont'))?.toString())
    .filter(Boolean);
  expect(fonts.some((f) => /^\/Georgia-\d+$/.test(f))).toBe(true);
  await ctx.close();
});
