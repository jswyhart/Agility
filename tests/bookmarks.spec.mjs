// Bookmarks panel and links.
import { test, expect } from '@playwright/test';
import { launch, fixture, showPage, settle, savedBytes, openPdf, pageBox, drag, submitModal } from './helpers.mjs';

const current = (page) => page.evaluate(() => window.agility.state.current);

test('bookmarks list the outline, navigate, and edits are saved', async () => {
  const ctx = await launch({ files: [fixture('outline.pdf')] });
  const { page } = ctx;
  await showPage(page);
  await page.click('.side-tab[data-side="bookmarks"]');
  await expect(page.locator('.bm-row .title')).toHaveText(['Chapter 1', 'Section 1.1', 'Chapter 2', 'Section 2.1', 'Chapter 3', 'Section 3.1']);
  await page.locator('.bm-row', { hasText: 'Chapter 3' }).click();
  await expect.poll(() => current(page)).toBe(2);

  // Add a bookmark for this page, name it, and nest it under Chapter 3.
  await page.click('[data-bm="add"]');
  await page.keyboard.type('Key findings');
  await page.keyboard.press('Enter');
  await page.click('[data-bm="indent"]');
  await page.locator('.bm-row', { hasText: 'Section 1.1' }).click();
  await page.click('[data-bm="delete"]');

  const doc = await openPdf(await savedBytes(page));
  const outline = await doc.getOutline();
  expect(outline.map((o) => [o.title, o.items.map((c) => c.title)])).toEqual([
    ['Chapter 1', []], ['Chapter 2', ['Section 2.1']], ['Chapter 3', ['Section 3.1', 'Key findings']],
  ]);
  const added = outline[2].items[1];
  expect(await doc.getPageIndex(added.dest[0])).toBe(2);
  await ctx.close();
});

test("the document's links work, and new links are saved as standard link annotations", async () => {
  const ctx = await launch({ files: [fixture('outline.pdf')] });
  const { page } = ctx;
  await showPage(page);
  // Internal link "chapter three" on page 1.
  await page.waitForSelector('.page .links a');
  await page.locator('.page .links a').first().click();
  await expect.poll(() => current(page)).toBe(2);

  await page.evaluate(() => window.agility.state.views[0].el.scrollIntoView());
  await settle(page);
  await page.click('button[data-tool="link"]');
  const pg = await pageBox(page);
  await drag(page, { x: pg.x + 60, y: pg.y + 300 }, { x: pg.x + 260, y: pg.y + 330 });
  await submitModal(page, () => {
    document.querySelector('.modal input[value="page"]').checked = true;
    document.querySelector('.modal .pg').value = '2';
  }, 'Add link');
  await page.evaluate(() => { window.agility.state.selected = null; });
  const doc = await openPdf(await savedBytes(page));
  const links = (await (await doc.getPage(1)).getAnnotations()).filter((a) => a.subtype === 'Link');
  expect(links).toHaveLength(2);
  const mine = links.find((l) => Array.isArray(l.dest));
  expect(await doc.getPageIndex(mine.dest[0])).toBe(1);
  await ctx.close();
});
