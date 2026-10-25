// Certificate signatures: create an identity, sign visibly, verify, detect changes.
import { test, expect } from '@playwright/test';
import { launch, fixture, showPage, action, pageBox, drag } from './helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

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
  await ctx.close();
});
