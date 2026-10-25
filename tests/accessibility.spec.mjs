// Document properties, the accessibility check and its fixes, and PDF/A output.
import { test, expect } from '@playwright/test';
import { launch, fixture, showPage, action, submitModal, savedBytes, tool, isEditing, PDFLib } from './helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';

const status = (page, label) => page.locator('.a11y-row', { hasText: label }).getAttribute('class');

test('accessibility check finds problems and its fixes resolve them', async () => {
  const ctx = await launch({ files: [fixture('sample.pdf')] });
  const { page } = ctx;
  await showPage(page);
  await action(page, 'accessibility');
  await page.waitForSelector('.a11y-row');
  expect(await status(page, 'Document title')).toContain('fail');
  expect(await status(page, 'Form field descriptions')).toContain('fail');
  expect(await status(page, 'Text on every page')).toContain('pass');
  // Fix the field descriptions; the check runs again.
  await page.locator('.a11y-row', { hasText: 'Form field descriptions' }).locator('button', { hasText: 'Fix' }).click();
  await expect.poll(() => status(page, 'Form field descriptions'), { timeout: 15000 }).toContain('pass');
  // Fix the title through Document Properties.
  await page.locator('.a11y-row', { hasText: 'Document title' }).locator('button', { hasText: 'Fix' }).click();
  await submitModal(page, () => {
    document.querySelector('.modal .p-title').value = 'Membership terms';
    document.querySelector('.modal .p-lang').value = 'en-US';
    document.querySelector('.modal .p-display').checked = true;
  }, 'Save');
  await expect.poll(() => status(page, 'Document title'), { timeout: 15000 }).toContain('pass');
  expect(await status(page, 'Document language')).toContain('pass');
  await page.locator('.modal button', { hasText: 'Close' }).click();

  const doc = await PDFLib.PDFDocument.load(await savedBytes(page), { updateMetadata: false });
  expect(doc.getTitle()).toBe('Membership terms');
  expect(doc.catalog.get(PDFLib.PDFName.of('Lang')).decodeText()).toBe('en-US');
  expect(doc.getForm().getTextField('name').acroField.dict.get(PDFLib.PDFName.of('TU')).decodeText()).toBe('Name');
  await ctx.close();
});

test('Save as PDF/A writes archival metadata, a color profile and embedded fonts', async () => {
  const ctx = await launch({ files: [fixture('paragraphs.pdf')] });
  const { page, out } = ctx;
  await showPage(page);
  await tool(page, 'text');
  await page.mouse.click(700, 700);
  await expect.poll(() => isEditing(page)).toBe(true);
  await page.keyboard.type('Archived note');
  await page.keyboard.press('Escape');
  await action(page, 'save-pdfa');
  const file = path.join(out, 'paragraphs (PDF-A).pdf');
  await expect.poll(() => fs.existsSync(file)).toBe(true);
  await expect(page.locator('#toast')).toContainText('PDF/A-2b');

  const bytes = fs.readFileSync(file);
  const doc = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
  const { PDFName } = PDFLib;
  const xmp = doc.catalog.lookup(PDFName.of('Metadata')).getContents();
  expect(Buffer.from(xmp).toString()).toContain('<pdfaid:part>2</pdfaid:part>');
  const intent = doc.catalog.lookup(PDFName.of('OutputIntents')).lookup(0);
  expect(intent.get(PDFName.of('S')).toString()).toBe('/GTS_PDFA1');
  // Every font, including the one for the new text box, is embedded.
  const fonts = [...doc.context.enumerateIndirectObjects()].map(([, o]) => o)
    .filter((o) => o instanceof PDFLib.PDFDict && o.get(PDFName.of('Type'))?.toString() === '/Font' && !['/Type0', '/Type3'].includes(o.get(PDFName.of('Subtype'))?.toString()));
  for (const f of fonts) expect(f.lookup(PDFName.of('FontDescriptor')).has(PDFName.of('FontFile2')) || f.lookup(PDFName.of('FontDescriptor')).has(PDFName.of('FontFile3'))).toBe(true);
  await ctx.close();
});
