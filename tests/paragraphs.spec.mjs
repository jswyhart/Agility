// Editing a paragraph as one block: its text reflows to the original width.
import { test, expect } from '@playwright/test';
import { launch, fixture, showPage, tool, isEditing, savedBytes, pageText, annotations } from './helpers.mjs';

test('a paragraph edits as one block and reflows to its width when saved', async () => {
  const ctx = await launch({ files: [fixture('paragraphs.pdf')] });
  const { page } = ctx;
  await showPage(page, 0, '1.5');
  const before = await pageText(await savedBytes(page));
  const firstPara = before.filter((t) => t.str.trim() && !/Paragraph test|second paragraph|untouched/i.test(t.str));
  const left = Math.min(...firstPara.map((t) => t.x));

  await tool(page, 'edittext');
  await page.waitForFunction(() => window.agility.state.views[0].editLayer?.querySelector('.textline.para'));
  const box = await page.locator('.textline.para').first().boundingBox();
  await page.mouse.click(box.x + 40, box.y + 8);
  await expect.poll(() => isEditing(page), { timeout: 15000 }).toBe(true);
  expect(await page.evaluate(() => document.activeElement.innerText)).toMatch(/^Agility edits whole paragraphs at once\. .* that way\.$/);

  await page.keyboard.press('Meta+A');
  await page.keyboard.type('Rewritten: this paragraph is now quite a bit longer than before, so it has to wrap onto more lines while staying inside the same column as the original text did, which is the whole point of editing a paragraph as one block of running text.');
  await page.keyboard.press('Escape');
  // Lines the preview shows, to compare with the saved file.
  const shown = await page.evaluate(() => {
    const c = document.querySelector('.annot.text .content');
    return Math.round(c.getBoundingClientRect().height / parseFloat(getComputedStyle(c).lineHeight));
  });
  const a = (await annotations(page)).find((x) => x.type === 'text');
  expect(a.wrap).toBeGreaterThan(200);

  const after = await pageText(await savedBytes(page));
  const rewritten = after.filter((t) => t.x === Math.round(left * 10) / 10 && !/Paragraph test|second paragraph|untouched/i.test(t.str));
  expect(rewritten.length).toBeGreaterThanOrEqual(4); // reflowed across the column
  const gaps = rewritten.slice(1).map((t, k) => Math.round((rewritten[k].y - t.y) * 10) / 10);
  expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(0.25); // even line spacing, as in the original
  expect(rewritten.length).toBe(shown); // and wrapped exactly as previewed
  expect(rewritten.map((t) => t.str).join(' ')).toContain('this paragraph is now quite a bit longer');
  // The next paragraph wasn't touched.
  const second = (t) => /A second paragraph/.test(t.str);
  expect(after.find(second)).toMatchObject(before.find(second));
  await ctx.close();
});
