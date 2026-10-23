// Password-protected PDFs: unlock to edit, keep the protection on save, respect
// "no editing" permissions unless the owner password is given.
import { test, expect } from '@playwright/test';
import { launch, fixture, showPage, tool, isEditing, savedBytes, pageText, openPdf } from './helpers.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Work on a copy: saving writes back to the opened file.
const copyOf = (name) => {
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agility-prot-')), name);
  fs.copyFileSync(fixture(name), target);
  return target;
};

async function answerPassword(page, pw) {
  await page.waitForSelector('.modal input[type="password"]');
  await page.fill('.modal input[type="password"]', pw);
  await page.locator('.modal button', { hasText: 'Open' }).click();
}

for (const [file, label] of [['protected-aes256.pdf', 'AES-256'], ['protected-rc4.pdf', 'RC4 40-bit']]) {
  test(`${label}: edit a protected PDF and save it with the same password`, async () => {
    const copy = copyOf(file);
    const ctx = await launch({ files: [copy], wait: false });
    const { page } = ctx;
    await answerPassword(page, 'nope');
    await expect(page.locator('.modal p')).toHaveText(/Incorrect/);
    await answerPassword(page, 'pw');
    await page.waitForFunction(() => window.agility.state.pdf);
    await showPage(page);
    expect(await page.evaluate(() => window.agility.state.readOnly)).toBe(false);
    await tool(page, 'text');
    await page.mouse.click(700, 700);
    await expect.poll(() => isEditing(page)).toBe(true);
    await page.keyboard.type('Added while protected');
    await page.keyboard.press('Escape');
    await page.click('[data-action="save"]');
    await expect(page.locator('#toast')).toContainText('Saved');
    const saved = new Uint8Array(fs.readFileSync(copy));
    await expect(openPdf(saved)).rejects.toThrow(/password/i);
    const doc = await openPdf(saved, 'pw');
    const annots = await (await doc.getPage(1)).getAnnotations();
    expect(annots.find((a) => a.subtype === 'FreeText')?.contentsObj.str).toBe('Added while protected');
    expect((await pageText(saved, 1, 'pw'))[0].str).toBe('Sample Document — Page 1');
    await ctx.close();
  });
}

test('a PDF that forbids editing opens read-only until the owner password is entered', async () => {
  const ctx = await launch({ files: [copyOf('protected-noedit.pdf')] });
  const { page } = ctx;
  expect(await page.evaluate(() => window.agility.state.readOnly)).toBe('restricted');
  await expect(page.locator('button[data-tool="text"]')).toBeDisabled();
  await page.evaluate(() => { window.agility.actions.unlock(); });
  await answerPassword(page, 'own');
  await expect.poll(() => page.evaluate(() => window.agility.state.readOnly)).toBe(false);
  await expect(page.locator('button[data-tool="text"]')).toBeEnabled();
  await ctx.close();
});
