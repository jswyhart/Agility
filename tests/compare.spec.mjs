// Comparing two versions of a document.
import { test, expect } from '@playwright/test';
import { launch, showPage, PDFLib } from './helpers.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function makeVersion(file, lines) {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  lines.forEach((page) => {
    const p = doc.addPage([612, 792]);
    page.forEach((t, k) => p.drawText(t, { x: 60, y: 720 - k * 24, size: 14, font }));
  });
  fs.writeFileSync(file, await doc.save());
}

test('compare lists changed, added and removed text and marks it in the document', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agility-cmp-'));
  const v1 = path.join(dir, 'v1.pdf');
  const v2 = path.join(dir, 'v2.pdf');
  await makeVersion(v1, [['Contract terms', 'The fee is 100 dollars.', 'Payment within 30 days.', 'This clause will be removed.'], ['Second page stays the same.']]);
  await makeVersion(v2, [['Contract terms', 'The fee is 250 dollars.', 'Payment within 30 days.', 'A brand new clause.'], ['Second page stays the same.', 'Signed by both parties.']]);
  const ctx = await launch({ files: [v2], openFiles: [v1] });
  const { page } = ctx;
  await showPage(page);
  await page.evaluate(() => { window.agility.actions.compare(); });
  await expect(page.locator('.compare-summary')).toContainText('3 differences from “v1.pdf”: 2 changed, 1 added, 0 removed');
  const cards = page.locator('#compare-list .comment');
  await expect(cards.nth(0).locator('del')).toHaveText(['100']);
  await expect(cards.nth(0).locator('ins')).toHaveText(['250']);
  // A line replaced in place reads as a change of that line.
  const joined = (sel) => cards.nth(1).locator(sel).allTextContents().then((t) => t.join(' '));
  expect(await joined('del')).toMatch(/This.*will be removed/);
  expect(await joined('ins')).toMatch(/A brand new/);
  await expect(cards.nth(2)).toContainText('Signed by both parties');
  await expect(cards.nth(2).locator('.when')).toHaveText('Page 2');
  expect(await page.locator('.page .cmp').count()).toBeGreaterThanOrEqual(3);
  await cards.nth(2).click();
  await expect.poll(() => page.evaluate(() => window.agility.state.current)).toBe(1);
  await ctx.close();
});
