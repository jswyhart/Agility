// True redaction removes content from the file, not just from view.
import { test, expect } from '@playwright/test';
import { launch, action, fixture, showPage, tool, drag, textSpan, annotations, savedBytes, pageText, openPdf, pageBox, submitModal } from './helpers.mjs';

test('redacting selected text removes those glyphs and keeps the rest in place', async () => {
  const ctx = await launch({ files: [fixture('sample.pdf')] });
  const { page } = ctx;
  await showPage(page);
  const a = await textSpan(page, 2);
  const cw = a.width / a.text.length;
  await drag(page, { x: a.x + cw * 10.5, y: a.y + a.height / 2 }, { x: a.x + cw * 25.5, y: a.y + a.height / 2 }); // mid-character: a press exactly on a glyph boundary can miss
  await page.click('#sel-popup [data-sel="redact"]');
  expect((await annotations(page)).filter((x) => x.type === 'redact')).toHaveLength(1);
  await action(page, 'apply-redactions');
  await submitModal(page, null, 'Redact');
  await expect(page.locator('#toast')).toContainText('Redacted 1 area');
  expect((await annotations(page)).filter((x) => x.type === 'redact')).toHaveLength(0);

  const text = await pageText(await savedBytes(page));
  const line = text.filter((t) => t.y === 648);
  expect(line.map((t) => t.str).join('|')).not.toContain('brown fox jumps');
  expect(line[0]).toMatchObject({ x: 60 }); // text before the box hasn't moved
  expect(text.filter((t) => t.y === 626)[0].str).toContain('The quick brown fox jumps'); // other lines untouched
  await ctx.close();
});

test('redacting over an image burns the area into a rebuilt page', async () => {
  const ctx = await launch({ files: [fixture('scanned.pdf')] });
  const { page } = ctx;
  await showPage(page);
  await tool(page, 'redact');
  const pg = await pageBox(page);
  await drag(page, { x: pg.x + 140, y: pg.y + 150 }, { x: pg.x + 330, y: pg.y + 180 });
  await action(page, 'apply-redactions');
  await submitModal(page, null, 'Redact');
  await expect(page.locator('#toast')).toContainText('converted to an image');
  const doc = await openPdf(await savedBytes(page));
  const p1 = await doc.getPage(1);
  const ops = await p1.getOperatorList();
  expect(ops.fnArray.filter((f) => f === 85 /* paintImageXObject */).length).toBe(1);
  await ctx.close();
});
