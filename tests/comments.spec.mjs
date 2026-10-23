// Comments: sticky notes, replies, notes on markup, and the comments panel.
import { test, expect } from '@playwright/test';
import { launch, fixture, showPage, tool, drag, textSpan, annotations, savedBytes, pageAnnotations, pageBox } from './helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';

test('comments and replies round-trip and are threaded for other readers', async () => {
  const ctx = await launch({ files: [fixture('sample.pdf')] });
  const { page, out } = ctx;
  await showPage(page);
  const pg = await pageBox(page);
  await tool(page, 'note');
  await page.mouse.click(pg.x + 520, pg.y + 90);
  await expect(page.locator('#comments')).toBeVisible();
  await expect(page.locator('#comment-list textarea').first()).toBeFocused();
  await page.keyboard.type('Check this heading');
  await page.locator('#comment-list .reply-input').first().fill('Looks right');
  await page.locator('#comment-list .reply-input').first().press('Enter');

  const a = await textSpan(page, 2);
  await drag(page, { x: a.x + 2, y: a.y + a.height / 2 }, { x: a.x + 150, y: a.y + a.height / 2 });
  await page.click('#sel-popup [data-sel="comment"]');
  await page.keyboard.type('Typo?');
  await page.locator('#comment-list').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('#comment-list .comment')).toHaveCount(2);

  const bytes = await savedBytes(page);
  const saved = (await pageAnnotations(bytes)).filter((x) => x.subtype !== 'Widget');
  expect(saved.map((x) => [x.subtype, x.contentsObj?.str, !!x.inReplyTo])).toEqual([
    ['Text', 'Check this heading', false], ['Text', 'Looks right', true], ['Highlight', 'Typo?', false],
  ]);

  const file = path.join(out, 'c.pdf');
  fs.writeFileSync(file, bytes);
  await page.evaluate((f) => { window.agility.state.dirty = false; return window.agility.openPath(f); }, file);
  await expect.poll(async () => (await annotations(page)).find((x) => x.type === 'note')?.replies?.map((r) => r.text)).toEqual(['Looks right']);
  await ctx.close();
});
