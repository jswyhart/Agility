// Large documents stay responsive: measured on a generated 1,000-page PDF.
import { test, expect } from '@playwright/test';
import { launch, settle } from './helpers.mjs';
import { PDFLib } from './helpers.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('a 1,000-page PDF opens quickly and keeps memory bounded while scrolling', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agility-big-')), 'big.pdf');
  const { PDFDocument, StandardFonts } = PDFLib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 1000; n++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Big document page ${n}`, { x: 60, y: 720, size: 22, font });
    for (let k = 0; k < 30; k++) p.drawText(`Line ${k} of page ${n}: the quick brown fox jumps over the lazy dog.`, { x: 60, y: 680 - k * 20, size: 11, font });
  }
  fs.writeFileSync(file, await doc.save());

  const t0 = Date.now();
  const ctx = await launch({ files: [file] });
  const { page } = ctx;
  await settle(page);
  const openMs = Date.now() - t0;
  console.log(`open + first render: ${openMs} ms`);

  // Jump through the document; only pages near the view keep rendered canvases.
  for (const n of [100, 400, 700, 999, 0]) {
    await page.evaluate((n) => window.agility.state.views[n].el.scrollIntoView(), n);
    await settle(page);
  }
  const stats = await page.evaluate(() => {
    const views = window.agility.state.views;
    const canvases = views.filter((v) => v.renderedScale > 0).length;
    const thumbs = window.agility.state.thumbs.filter((t) => t.rendered).length;
    return { canvases, thumbs, heapMB: Math.round(performance.memory.usedJSHeapSize / 1e6) };
  });
  console.log(JSON.stringify(stats));
  expect(openMs).toBeLessThan(15000);
  expect(stats.canvases).toBeLessThan(20);
  expect(stats.thumbs).toBeLessThan(100);
  await ctx.close();
});
