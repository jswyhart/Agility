// Shared helpers for the end-to-end tests: launch Agility in an isolated profile,
// find document tabs, drive the page with real mouse/keyboard input, and inspect
// saved PDFs with pdf.js / pdf-lib.

import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fixture = (name) => path.join(ROOT, 'tests', 'fixtures', name);
export const PDFLib = require('pdf-lib');

let pdfjs;
async function getPdfjs() {
  pdfjs ||= await import(path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'));
  return pdfjs;
}

/**
 * Launch Agility with its own profile. Save dialogs write into `out`; open
 * dialogs return `openFiles`. Returns { app, page, out, profile, close }.
 */
export async function launch({ files = [], openFiles = [], env = {}, profile } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agility-test-'));
  const out = path.join(tmp, 'out');
  fs.mkdirSync(out);
  profile ||= path.join(tmp, 'profile');
  const app = await electron.launch({
    args: [ROOT, `--user-data-dir=${profile}`, ...files],
    env: {
      ...process.env,
      AGILITY_TEST_DIR: out,
      AGILITY_TEST_OPEN: openFiles.join(path.delimiter),
      AGILITY_RESTORE: 'discard',
      ...env,
    },
  });
  const page = await docTab(app, 0, { loaded: files.length > 0 });
  return {
    app, page, out, profile, tmp,
    close: () => app.close().catch(() => {}),
  };
}

/** The nth document tab (in creation order), optionally waiting for a loaded PDF. */
export async function docTab(app, n = 0, { loaded = true } = {}) {
  let tab;
  await expect.poll(async () => {
    const tabs = app.context().pages().filter((p) => p.url().includes('index.html'));
    tab = tabs[n];
    if (!tab) return false;
    return tab.evaluate((wantDoc) => !!window.agility && (!wantDoc || !!window.agility.state.pdf), loaded).catch(() => false);
  }, { timeout: 20000 }).toBe(true);
  if (loaded) await settle(tab);
  return tab;
}

export const tabStrip = (app) => app.context().pages().find((p) => p.url().includes('tabs.html'));

/** Wait until visible pages have rendered their canvas and text layer. */
export async function settle(page) {
  await page.waitForFunction(() => {
    const v = window.agility?.state.views[window.agility.state.current];
    return v && v.canvas.width > 0 && v.renderedScale === window.agility.state.scale && v.textScale === window.agility.state.scale && !v.task;
  }, null, { timeout: 15000 });
  await page.waitForTimeout(150);
}

/** 100% zoom, scrolled to the top of page i. */
export async function showPage(page, i = 0, zoom = '1') {
  await page.evaluate(([i, zoom]) => {
    const z = document.querySelector('#zoom');
    z.value = zoom;
    z.dispatchEvent(new Event('change'));
    window.agility.state.views[i].el.scrollIntoView();
  }, [i, zoom]);
  await settle(page);
}

export const pageBox = (page, i = 0) => page.evaluate((i) => {
  const r = window.agility.state.views[i].el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}, i);

/** Screen box of the nth non-empty text-layer span on a page. */
export const textSpan = (page, n, i = 0) => page.evaluate(([n, i]) => {
  const spans = [...window.agility.state.views[i].text.querySelectorAll('span')].filter((s) => s.textContent.trim());
  const r = spans[n].getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, text: spans[n].textContent };
}, [n, i]);

export async function drag(page, from, to, steps = 8) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

export const tool = (page, name) => page.click(`button[data-tool="${name}"]`);
export const annotations = (page) => page.evaluate(() => Object.values(window.agility.state.annotations).flat());
// Start a menu action without waiting for it: most open a dialog the test answers next.
export const action = (page, name) => page.evaluate((n) => {
  window.agility.actions[n]();
}, name);

/** Fill a modal form via a callback run in the page, then press its button. */
export async function submitModal(page, fill, buttonText) {
  await page.waitForSelector('.modal');
  if (fill) await page.evaluate(fill);
  await page.locator('.modal button', { hasText: buttonText }).click();
}

/** The document as Agility would save it, without touching the disk. */
export async function savedBytes(page) {
  const b64 = await page.evaluate(async () => {
    const out = await window.agility.buildOutput();
    let s = '';
    for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
    return btoa(s);
  });
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export async function openPdf(bytes, password) {
  const lib = await getPdfjs();
  return lib.getDocument({ data: bytes.slice(), password, verbosity: 0 }).promise;
}

/** Text items of a page: [{ str, x, y }] in PDF user space. */
export async function pageText(bytes, n = 1, password) {
  const doc = await openPdf(bytes, password);
  const tc = await (await doc.getPage(n)).getTextContent();
  return tc.items.filter((i) => i.str.trim()).map((i) => ({ str: i.str, x: Math.round(i.transform[4] * 10) / 10, y: Math.round(i.transform[5] * 10) / 10 }));
}

export async function pageAnnotations(bytes, n = 1) {
  const doc = await openPdf(bytes);
  return (await doc.getPage(n)).getAnnotations();
}

export const isEditing = (page) => page.evaluate(() => document.activeElement?.isContentEditable === true);
export const selectionText = (page) => page.evaluate(() => getSelection().toString());
