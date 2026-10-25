// Batch processing several files.
import { test, expect } from '@playwright/test';
import { launch, fixture, action, submitModal, pageText, openPdf } from './helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';

test('batch OCR, page numbers and password over several files', async () => {
  const ctx = await launch({ openFiles: [fixture('scanned.pdf'), fixture('sample.pdf')] });
  const { page, out } = ctx;
  await action(page, 'batch');
  await submitModal(page, () => {
    const m = document.querySelector('.modal');
    m.querySelector('.b-ocr').checked = true;
    m.querySelector('.b-num').checked = true;
    m.querySelector('.b-pw').checked = true;
    m.querySelector('.b-pw-text').value = 'batchpw';
  }, 'Choose files…');
  await expect(page.locator('#toast')).toContainText('Saved 2 files', { timeout: 60000 });
  const scanned = new Uint8Array(fs.readFileSync(path.join(out, 'scanned.pdf')));
  await expect(openPdf(scanned)).rejects.toThrow(/password/i);
  const words = (await pageText(scanned, 1, 'batchpw')).map((t) => t.str);
  expect(words).toEqual(expect.arrayContaining(['quick', 'brown', '1'])); // OCR text and the page number
  const sample = new Uint8Array(fs.readFileSync(path.join(out, 'sample.pdf')));
  for (const n of [1, 2, 3]) expect((await pageText(sample, n, 'batchpw')).map((t) => t.str)).toContain(String(n));
  await ctx.close();
});
