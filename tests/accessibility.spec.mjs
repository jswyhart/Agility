// Document properties, the accessibility check and its fixes, and PDF/A output.
import { test, expect } from '@playwright/test';
import { launch, fixture, showPage, action, submitModal, savedBytes, tool, isEditing, PDFLib, openPdf, pageText } from './helpers.mjs';
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

// The structure tree pdf.js reads from a saved file: [{ role, content: n }] per page, flattened.
async function structure(bytes, n = 1) {
  const pdf = await openPdf(bytes);
  const tree = await (await pdf.getPage(n)).getStructTree();
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (node.role && node.role !== 'Root' && node.role !== 'Document') out.push({ role: node.role, alt: node.alt, content: (node.children || []).filter((c) => c.type === 'content').length });
    (node.children || []).forEach(walk);
  };
  walk(tree);
  return out;
}

test('an untagged document can be tagged: headings, paragraphs and reading order', async () => {
  const ctx = await launch({ files: [fixture('paragraphs.pdf')] });
  const { page } = ctx;
  await showPage(page);
  const before = await pageText(await savedBytes(page));
  await action(page, 'accessibility');
  await page.waitForSelector('.a11y-row');
  expect(await status(page, 'Tagged structure')).toContain('warn');
  await page.locator('.a11y-row', { hasText: 'Tagged structure' }).locator('button', { hasText: 'Fix' }).click();
  await expect.poll(() => status(page, 'Tagged structure'), { timeout: 15000 }).toContain('pass');
  await page.locator('.modal button', { hasText: 'Close' }).click();

  const bytes = await savedBytes(page);
  const doc = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
  const { PDFName } = PDFLib;
  expect(doc.catalog.lookup(PDFName.of('MarkInfo')).get(PDFName.of('Marked')).toString()).toBe('true');
  expect(doc.catalog.has(PDFName.of('StructTreeRoot'))).toBe(true);
  expect(doc.getPage(0).node.get(PDFName.of('StructParents')).asNumber()).toBe(0);

  // "Paragraph test" is the larger text; the two paragraphs under it stay separate.
  const tree = await structure(bytes);
  expect(tree.map((t) => t.role)).toEqual(['H1', 'P', 'P']);
  expect(tree.every((t) => t.content > 0)).toBe(true);
  // The text itself is untouched (pdf.js just reports it in tagged pieces).
  const flat = (items) => items.map((i) => i.str).join('').replace(/\s+/g, '');
  expect(flat(await pageText(bytes))).toBe(flat(before));
  // One undo takes the tags off again.
  await action(page, 'undo');
  await expect.poll(async () => (await PDFLib.PDFDocument.load(await savedBytes(page), { updateMetadata: false })).catalog.has(PDFName.of('StructTreeRoot'))).toBe(false);
  await ctx.close();
});

test('tagged images become figures that can be given alternate text', async () => {
  const ctx = await launch({ files: [fixture('scanned.pdf')] });
  const { page } = ctx;
  await showPage(page);
  await action(page, 'accessibility');
  await page.locator('.a11y-row', { hasText: 'Tagged structure' }).locator('button', { hasText: 'Fix' }).click();
  await expect.poll(() => status(page, 'Tagged structure'), { timeout: 15000 }).toContain('pass');
  expect(await status(page, 'Alternate text for figures')).toContain('warn');
  await page.locator('.a11y-row', { hasText: 'Alternate text for figures' }).locator('button', { hasText: 'Fix' }).click();
  await expect(page.locator('.modal .alt-text')).toHaveCount(1);
  await page.fill('.modal .alt-text', 'A scanned letter about a quick brown fox');
  await page.locator('.modal button', { hasText: 'Save' }).click();
  await expect.poll(() => status(page, 'Alternate text for figures'), { timeout: 15000 }).toContain('pass');
  await page.locator('.modal button', { hasText: 'Close' }).click();
  expect(await structure(await savedBytes(page))).toEqual([{ role: 'Figure', alt: 'A scanned letter about a quick brown fox', content: 1 }]);
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
