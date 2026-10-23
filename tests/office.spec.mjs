// Word export, and creating a PDF back from that .docx (built-in converter).
import { test, expect } from '@playwright/test';
import { launch, fixture, showPage, action, docTab, pageText, savedBytes } from './helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';

test('exports to Word and converts the .docx back into a PDF tab', async () => {
  const ctx = await launch({ files: [fixture('paragraphs.pdf')], env: { AGILITY_NO_LIBREOFFICE: '1' } });
  const { page, out, app } = ctx;
  await showPage(page);
  await action(page, 'export-word');
  const docx = path.join(out, 'paragraphs.docx');
  await expect.poll(() => fs.existsSync(docx)).toBe(true);
  expect(fs.readFileSync(docx).subarray(0, 2).toString()).toBe('PK');
  await page.evaluate((f) => window.api.openOffice([f]), docx);
  const tab = await docTab(app, 1);
  const text = (await pageText(await savedBytes(tab))).map((t) => t.str).join(' ');
  expect(text).toContain('Paragraph test');
  expect(text).toContain('Agility edits whole paragraphs at once.');
  await ctx.close();
});
