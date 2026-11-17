// Certificate signatures: create an identity, sign visibly, verify, detect changes.
import { test, expect } from '@playwright/test';
import { launch, fixture, showPage, action, pageBox, drag } from './helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTsa } from './tsa.mjs';

const { verifySignatures } = createRequire(import.meta.url)('../sign.js');

test('sign with a new certificate; the signed copy verifies and edits are detected', async () => {
  const ctx = await launch({ files: [fixture('sample.pdf')] });
  const { page, out } = ctx;
  await showPage(page);
  await action(page, 'sign-certificate');
  await page.locator('.modal button', { hasText: 'Create…' }).click();
  await page.fill('.cert-new .n-name', 'Pat Signer');
  await page.fill('.cert-new .n-pw', 'secret1');
  await page.locator('.cert-new button', { hasText: 'Create' }).click();
  await expect(page.locator('.modal .c-id option')).toHaveText([/Pat Signer · self-signed/]);
  await page.fill('.modal .c-reason', 'Approved');
  await page.locator('.modal .actions > button', { hasText: 'Sign…' }).click();
  const pg = await pageBox(page);
  await drag(page, { x: pg.x + 360, y: pg.y + 620 }, { x: pg.x + 580, y: pg.y + 690 });

  await expect(page.locator('#sig-banner')).toContainText('Signed by Pat Signer', { timeout: 20000 });
  await expect(page.locator('#sig-banner')).toHaveClass(/ok/);
  await expect(page.locator('#sig-banner')).toContainText('signed with your own certificate');
  const file = path.join(out, 'sample (signed).pdf');
  const [sig] = verifySignatures(fs.readFileSync(file));
  expect(sig).toMatchObject({ intact: true, coversWholeFile: true, signer: 'Pat Signer', reason: 'Approved', selfSigned: true, trusted: false });

  // Appending to the file after signing is reported, and so is tampering.
  const tampered = Buffer.from(fs.readFileSync(file));
  tampered[tampered.indexOf('Sample Document') + 2] = 0x58;
  expect(verifySignatures(tampered)[0].intact).toBe(false);
  // No timestamp was asked for, so none is claimed.
  expect(sig.timestamp).toBeNull();
  await ctx.close();
});

// Create an identity in the certificate dialog and leave the dialog ready to sign.
async function newIdentity(page) {
  await action(page, 'sign-certificate');
  await page.locator('.modal button', { hasText: 'Create…' }).click();
  await page.fill('.cert-new .n-name', 'Pat Signer');
  await page.fill('.cert-new .n-pw', 'secret1');
  await page.locator('.cert-new button', { hasText: 'Create' }).click();
  await expect(page.locator('.modal .c-id option')).toHaveText([/Pat Signer/]);
  await page.uncheck('.modal .c-visible');
}

test('a trusted timestamp is embedded, verified and reported', async () => {
  const tsa = await startTsa();
  const ctx = await launch({ files: [fixture('sample.pdf')] });
  const { page, out } = ctx;
  await newIdentity(page);
  await expect(page.locator('.modal .c-ts-row')).toBeHidden();
  await page.check('.modal .c-ts');
  await expect(page.locator('.modal .c-tsa')).toHaveValue('http://timestamp.digicert.com');
  await page.fill('.modal .c-tsa', tsa.url);
  await page.locator('.modal .actions > button', { hasText: 'Sign…' }).click();

  await expect(page.locator('#sig-banner')).toContainText(`The signing time is confirmed by ${tsa.name}`, { timeout: 20000 });
  expect(tsa.requests).toEqual([{ contentType: 'application/timestamp-query' }]);
  const file = path.join(out, 'sample (signed).pdf');
  const [sig] = verifySignatures(fs.readFileSync(file));
  expect(sig).toMatchObject({ intact: true, coversWholeFile: true, signedWhileValid: true, timestamp: { valid: true, authority: tsa.name, trusted: false } });
  expect(Math.abs(new Date(sig.timestamp.time) - Date.now())).toBeLessThan(120000);

  // The token travels inside the signature itself, as the standard unsigned attribute.
  const bytes = Buffer.from(fs.readFileSync(file));
  const hexStart = bytes.indexOf('/Contents <') + 11;
  const cms = Buffer.from(bytes.subarray(hexStart, bytes.indexOf('>', hexStart)).toString('latin1'), 'hex');
  expect(cms.includes(Buffer.from('060b2a864886f70d010910020e', 'hex'))).toBe(true); // id-aa-timeStampToken

  // The choice is remembered for the next signature.
  await action(page, 'sign-certificate');
  await expect(page.locator('.modal .c-ts')).toBeChecked();
  await expect(page.locator('.modal .c-tsa')).toHaveValue(tsa.url);
  await ctx.close();
  await tsa.close();
});

test('signing stops with a clear message when the timestamp server fails', async () => {
  const tsa = await startTsa({ wrongHash: true });
  const ctx = await launch({ files: [fixture('sample.pdf')] });
  const { page, out } = ctx;
  await newIdentity(page);
  await page.check('.modal .c-ts');
  await page.fill('.modal .c-tsa', tsa.url);
  await page.locator('.modal .actions > button', { hasText: 'Sign…' }).click();
  await expect(page.locator('#toast')).toContainText('is for different data', { timeout: 20000 });
  expect(fs.existsSync(path.join(out, 'sample (signed).pdf'))).toBe(false);

  await tsa.close(); // now nothing is listening there
  await action(page, 'sign-certificate');
  await page.fill('.modal .c-pw', 'secret1');
  await page.uncheck('.modal .c-visible');
  await page.locator('.modal .actions > button', { hasText: 'Sign…' }).click();
  await expect(page.locator('#toast')).toContainText("Couldn't get a timestamp", { timeout: 30000 });
  expect(fs.existsSync(path.join(out, 'sample (signed).pdf'))).toBe(false);
  await ctx.close();
});
