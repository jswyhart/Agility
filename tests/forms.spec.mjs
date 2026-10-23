// Form authoring: detect fields on a flat form, edit properties, tab order.
import { test, expect } from '@playwright/test';
import { launch, fixture, showPage, action, submitModal, savedBytes, PDFLib } from './helpers.mjs';

test('detects fill-in areas on a flat form and names them from their labels', async () => {
  const ctx = await launch({ files: [fixture('flat-form.pdf')] });
  const { page } = ctx;
  await showPage(page);
  await action(page, 'detect-fields');
  await submitModal(page, null, 'Detect');
  await expect(page.locator('.modal p')).toContainText('Found 4 text fields and 2 checkboxes');
  await page.locator('.modal button', { hasText: 'Add fields' }).click();
  await expect(page.locator('#toast')).toContainText('Added 6 fields');

  const doc = await PDFLib.PDFDocument.load(await savedBytes(page));
  const fields = doc.getForm().getFields().map((f) => `${f.constructor.name}:${f.getName()}`).sort();
  expect(fields).toEqual([
    'PDFCheckBox:I agree to the terms', 'PDFCheckBox:Send me updates',
    'PDFTextField:Comments', 'PDFTextField:Email', 'PDFTextField:Full name', 'PDFTextField:Signature',
  ]);
  expect(doc.getForm().getTextField('Comments').isMultiline()).toBe(true);
  await ctx.close();
});

test('field properties and tab order are saved', async () => {
  const ctx = await launch({ files: [fixture('sample.pdf')] });
  const { page } = ctx;
  await showPage(page);
  await action(page, 'form-edit');
  await page.locator('.field-box[data-field="name"]').click();
  await submitModal(page, () => {
    const m = document.querySelector('.modal');
    m.querySelector('.f-name').value = 'fullName';
    m.querySelector('.f-tip').value = 'Your full name';
    m.querySelector('.f-req').checked = true;
    m.querySelector('.f-max').value = '40';
  }, 'Save');
  await expect(page.locator('#toast')).toContainText('Field updated');
  await action(page, 'tab-order');
  await submitModal(page, () => (document.querySelector('.modal input[value="columns"]').checked = true), 'Apply');
  await expect(page.locator('#toast')).toContainText('Tab order');

  const doc = await PDFLib.PDFDocument.load(await savedBytes(page));
  const field = doc.getForm().getTextField('fullName');
  expect(field.isRequired()).toBe(true);
  expect(field.getMaxLength()).toBe(40);
  expect(field.acroField.dict.get(PDFLib.PDFName.of('TU')).decodeText()).toBe('Your full name');
  expect(doc.getPage(0).node.get(PDFLib.PDFName.of('Tabs')).toString()).toBe('/C');
  await ctx.close();
});
