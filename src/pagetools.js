// Page and document tools: extract, split, page numbers, header & footer,
// watermark, crop, file-size reduction, password protection, and exports.
// app.js passes in what these need (see install()).

import { encryptPdf } from './crypto.js';

const { PDFDocument, PDFName, PDFRawStream, PDFNumber, StandardFonts, rgb, degrees, decodePDFRawStream } = window.PDFLib;

let ctx;

/** Wire up the tools; returns the menu actions they handle. */
export function install(context) {
  ctx = context;
  return {
    'extract-pages': extractPages,
    split: splitDocument,
    'page-numbers': pageNumbers,
    'header-footer': headerFooter,
    watermark,
    compress,
    'save-password': savePassword,
    'export-images': exportImages,
    'export-text': exportText,
    'from-images': fromImages,
    'tool-crop': () => {
      ctx.setTool('crop');
      ctx.toast('Drag the area to keep', { ms: 2500 });
    },
  };
}

// ---- Small form helpers -------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// A modal form: fields are rendered from `html`; read(box) turns them into a value.
function form(title, html, okLabel, read, { note } = {}) {
  return ctx.modal((box, close) => {
    box.innerHTML = `<h2>${esc(title)}</h2>${note ? `<p>${esc(note)}</p>` : ''}<div class="form">${html}</div><div class="actions"></div>`;
    const submit = () => {
      const value = read(box);
      if (value) close(value);
    };
    box.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && submit()));
    box.querySelector('.actions').append(ctx.button('Cancel', 'secondary', () => close(null)), ctx.button(okLabel, 'primary', submit));
    setTimeout(() => box.querySelector('input, select')?.focus());
  });
}

/** "1-3, 5, 8-" → zero-based page indices (in order, no duplicates). */
export function parseRanges(text, count) {
  const out = [];
  for (const part of String(text).split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*(?:-\s*(\d*))?$/);
    if (!m) return null;
    const a = m[1] ? Number(m[1]) : 1;
    const b = part.includes('-') ? (m[2] ? Number(m[2]) : count) : a;
    if (a < 1 || b > count || a > b) return null;
    for (let n = a; n <= b; n++) if (!out.includes(n - 1)) out.push(n - 1);
  }
  return out.length ? out : null;
}

const baseName = () => (ctx.state.fileName || 'Document').replace(/\.pdf$/i, '');
const rangeLabel = (pages) => (pages.length === 1 ? `page ${pages[0] + 1}` : `pages ${pages[0] + 1}-${pages[pages.length - 1] + 1}`);

async function pagesAsPdf(source, indices) {
  const out = await PDFDocument.create();
  const pages = await out.copyPages(source, indices);
  pages.forEach((p) => out.addPage(p));
  return out.save();
}

// ---- Extract & split --------------------------------------------------------------------

async function extractPages() {
  const count = ctx.state.pages.length;
  const pages = await form('Extract pages', `<label class="field-row">Pages <input type="text" class="r" value="${ctx.state.current + 1}" placeholder="e.g. 1-3, 5" /></label>`,
    'Extract', (box) => parseRanges(box.querySelector('.r').value, count) || (ctx.toast(`Enter pages between 1 and ${count}, like 1-3, 5`, { error: true }), null),
    { note: `Saves the chosen pages, with their markup, as a new PDF. This document has ${count} pages.` });
  if (!pages) return;
  await ctx.enqueue(async () => {
    const full = await PDFDocument.load(await ctx.buildOutput(), { updateMetadata: false });
    const res = await ctx.api.saveAs(await pagesAsPdf(full, pages), `${baseName()} - ${rangeLabel(pages)}.pdf`);
    if (res) ctx.toast(`Saved ${res.name}`);
  });
}

async function splitDocument() {
  const count = ctx.state.pages.length;
  const choice = await form('Split document', `
    <label class="opt"><input type="radio" name="mode" value="each" checked /> Every page as its own file</label>
    <label class="opt"><input type="radio" name="mode" value="every" /> Every <input type="number" class="n" value="2" min="1" max="${count}" style="width:60px" /> pages</label>
    <label class="opt"><input type="radio" name="mode" value="ranges" /> By ranges <input type="text" class="r" placeholder="1-3, 4-6" style="width:140px" /></label>`,
  'Split', (box) => {
    const mode = box.querySelector('input[name="mode"]:checked').value;
    if (mode === 'each') return Array.from({ length: count }, (_, i) => [i]);
    if (mode === 'every') {
      const n = Math.max(1, Number(box.querySelector('.n').value) || 1);
      return Array.from({ length: Math.ceil(count / n) }, (_, k) => Array.from({ length: Math.min(n, count - k * n) }, (_, j) => k * n + j));
    }
    const groups = box.querySelector('.r').value.split(',').map((g) => parseRanges(g, count));
    if (groups.some((g) => !g)) return ctx.toast('Enter ranges like 1-3, 4-6', { error: true }), null;
    return groups;
  }, { note: 'Choose a folder next; the parts are saved there.' });
  if (!choice) return;
  await ctx.enqueue(async () => {
    const full = await PDFDocument.load(await ctx.buildOutput(), { updateMetadata: false });
    const files = [];
    for (const g of choice) files.push({ name: `${baseName()} - ${rangeLabel(g)}.pdf`, data: await pagesAsPdf(full, g) });
    const res = await ctx.api.saveMany(files, 'Choose a folder for the split files');
    if (res) ctx.toast(`Saved ${res.count} files`);
  });
}

// ---- Text stamped on pages (numbers, header/footer, watermark) ----------------------------

// Draw text at a position given in on-screen page units, upright on screen.
function drawScreenText(page, vp, font, text, { x, y, size, color, opacity = 1, angle = 0 }) {
  const [ux, uy] = vp.convertToPdfPoint(x, y);
  page.drawText(text, { x: ux, y: uy, size, font, color, opacity, rotate: degrees(vp.rotation + angle) });
}

const POSITIONS = ['bottom-center', 'bottom-right', 'bottom-left', 'top-center', 'top-right', 'top-left'];

function placeAt(pos, vp, width, size, margin = 30) {
  const [v, h] = pos.split('-');
  const x = h === 'left' ? margin : h === 'right' ? vp.width - margin - width : (vp.width - width) / 2;
  const y = v === 'top' ? margin + size * 0.8 : vp.height - margin;
  return { x, y };
}

const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

async function pageNumbers() {
  const count = ctx.state.pages.length;
  const opts = await form('Page numbers', `
    <label class="field-row">Position <select class="pos">${POSITIONS.map((p) => `<option value="${p}">${p.replace('-', ' ')}</option>`).join('')}</select></label>
    <label class="field-row">Format <select class="fmt">
      <option value="{n}">1</option><option value="Page {n}">Page 1</option>
      <option value="Page {n} of {total}">Page 1 of ${count}</option><option value="{n} / {total}">1 / ${count}</option></select></label>
    <label class="field-row">Start at <input type="number" class="start" value="1" min="0" style="width:70px" /></label>
    <label class="field-row">Pages <input type="text" class="r" value="1-${count}" /></label>
    <label class="field-row">Size <input type="number" class="size" value="10" min="5" max="48" style="width:70px" /></label>`,
  'Add numbers', (box) => {
    const pages = parseRanges(box.querySelector('.r').value, count);
    if (!pages) return ctx.toast('Check the page range', { error: true }), null;
    return { pages, pos: box.querySelector('.pos').value, fmt: box.querySelector('.fmt').value, start: Number(box.querySelector('.start').value) || 0, size: Number(box.querySelector('.size').value) || 10 };
  });
  if (!opts) return;
  await ctx.mutateDocument(async (doc) => {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    opts.pages.forEach((i, k) => {
      const vp = ctx.state.pages[i].getViewport({ scale: 1 });
      const text = fill(opts.fmt, { n: opts.start + k, total: opts.start + opts.pages.length - 1 });
      const at = placeAt(opts.pos, vp, font.widthOfTextAtSize(text, opts.size), opts.size);
      drawScreenText(doc.getPage(i), vp, font, text, { ...at, size: opts.size, color: rgb(0.2, 0.2, 0.2) });
    });
  });
  ctx.toast(`Numbered ${opts.pages.length} pages`);
}

async function headerFooter() {
  const count = ctx.state.pages.length;
  const cell = (cls, ph) => `<input type="text" class="${cls}" placeholder="${ph}" />`;
  const opts = await form('Header & footer', `
    <p class="hint-line">Use {page}, {pages}, {date} and {file} for automatic text.</p>
    <div class="grid3"><span>Left</span><span>Center</span><span>Right</span>
      ${cell('hl', 'Header left')}${cell('hc', 'Header center')}${cell('hr', 'Header right')}
      ${cell('fl', 'Footer left')}${cell('fc', 'Footer center')}${cell('fr', 'Page {page} of {pages}')}</div>
    <label class="field-row">Size <input type="number" class="size" value="9" min="5" max="36" style="width:70px" /></label>`,
  'Add', (box) => {
    const v = (c) => box.querySelector(`.${c}`).value;
    const parts = { 'top-left': v('hl'), 'top-center': v('hc'), 'top-right': v('hr'), 'bottom-left': v('fl'), 'bottom-center': v('fc'), 'bottom-right': v('fr') };
    if (!Object.values(parts).some(Boolean)) return ctx.toast('Type something for the header or footer', { error: true }), null;
    return { parts, size: Number(v('size')) || 9 };
  });
  if (!opts) return;
  const date = new Date().toLocaleDateString();
  await ctx.mutateDocument(async (doc) => {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < count; i++) {
      const vp = ctx.state.pages[i].getViewport({ scale: 1 });
      for (const [pos, template] of Object.entries(opts.parts)) {
        if (!template) continue;
        const text = ctx.encodable(font, fill(template, { page: i + 1, pages: count, date, file: ctx.state.fileName || '' }));
        const at = placeAt(pos, vp, font.widthOfTextAtSize(text, opts.size), opts.size, 24);
        drawScreenText(doc.getPage(i), vp, font, text, { ...at, size: opts.size, color: rgb(0.25, 0.25, 0.25) });
      }
    }
  });
  ctx.toast('Added header & footer');
}

async function watermark() {
  const count = ctx.state.pages.length;
  const opts = await form('Watermark', `
    <label class="field-row">Text <input type="text" class="t" value="CONFIDENTIAL" /></label>
    <label class="field-row">Size <input type="number" class="size" value="64" min="10" max="200" style="width:70px" /></label>
    <label class="field-row">Opacity <input type="range" class="op" min="5" max="60" value="18" /></label>
    <label class="field-row">Angle <select class="ang"><option value="45">Diagonal</option><option value="0">Horizontal</option></select></label>
    <label class="field-row">Color <input type="color" class="c" value="#e5484d" /></label>
    <label class="field-row">Pages <input type="text" class="r" value="1-${count}" /></label>`,
  'Add watermark', (box) => {
    const pages = parseRanges(box.querySelector('.r').value, count);
    const text = box.querySelector('.t').value.trim();
    if (!text || !pages) return ctx.toast('Enter the text and pages', { error: true }), null;
    return { text, pages, size: Number(box.querySelector('.size').value) || 64, opacity: Number(box.querySelector('.op').value) / 100, angle: Number(box.querySelector('.ang').value), color: box.querySelector('.c').value };
  });
  if (!opts) return;
  await ctx.mutateDocument(async (doc) => {
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const text = ctx.encodable(font, opts.text);
    const w = font.widthOfTextAtSize(text, opts.size);
    const t = (opts.angle * Math.PI) / 180;
    for (const i of opts.pages) {
      const vp = ctx.state.pages[i].getViewport({ scale: 1 });
      // Centre the text on the page along its (screen) direction.
      const cx = vp.width / 2 - (w / 2) * Math.cos(t) + opts.size * 0.35 * Math.sin(t);
      const cy = vp.height / 2 + (w / 2) * Math.sin(t) + opts.size * 0.35 * Math.cos(t);
      drawScreenText(doc.getPage(i), vp, font, text, { x: cx, y: cy, size: opts.size, color: ctx.pdfColor(opts.color), opacity: opts.opacity, angle: opts.angle });
    }
  });
  ctx.toast('Added watermark');
}

// ---- Crop ------------------------------------------------------------------------------------

/** Called by the crop tool with the box drawn on page i (screen page units). */
export async function cropTo(i, box) {
  const count = ctx.state.pages.length;
  const scope = await form('Crop', `
    <label class="opt"><input type="radio" name="scope" value="one" checked /> This page (${i + 1})</label>
    <label class="opt"><input type="radio" name="scope" value="all" /> All ${count} pages</label>`,
  'Crop', (b) => b.querySelector('input[name="scope"]:checked').value, { note: 'Content outside the box is hidden (not deleted). Uncrop by undoing.' });
  ctx.setTool('select');
  if (!scope) return;
  const targets = scope === 'all' ? ctx.state.pages.map((_, k) => k) : [i];
  await ctx.mutateDocument((doc) => {
    for (const k of targets) {
      const vp = ctx.state.pages[k].getViewport({ scale: 1 });
      const x0 = Math.max(0, box.x);
      const y0 = Math.max(0, box.y);
      const x1 = Math.min(vp.width, box.x + box.w);
      const y1 = Math.min(vp.height, box.y + box.h);
      if (x1 - x0 < 10 || y1 - y0 < 10) continue;
      const [ax, ay] = vp.convertToPdfPoint(x0, y0);
      const [bx, by] = vp.convertToPdfPoint(x1, y1);
      doc.getPage(k).setCropBox(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      // The page now starts at the box's corner; keep markup where it was on the page.
      for (const a of ctx.annotsOf(k)) ctx.translate(a, structuredClone(a), -x0, -y0);
    }
  });
}

// ---- Reduce file size ----------------------------------------------------------------------

const PRESETS = {
  high: { maxDim: 2400, quality: 0.85, label: 'High quality' },
  medium: { maxDim: 1600, quality: 0.75, label: 'Balanced' },
  small: { maxDim: 1100, quality: 0.6, label: 'Smallest file' },
};

const mb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

async function reencode(pixelsOrBlob, w, h, preset) {
  const bmp = pixelsOrBlob instanceof Blob ? await createImageBitmap(pixelsOrBlob) : await createImageBitmap(pixelsOrBlob);
  const s = Math.min(1, preset.maxDim / Math.max(w, h));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) });
  const c2d = canvas.getContext('2d');
  c2d.fillStyle = '#fff';
  c2d.fillRect(0, 0, canvas.width, canvas.height);
  c2d.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', preset.quality));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
}

// Re-encode large photos at a lower resolution. Only simple RGB/gray images are
// touched (no masks, decode arrays or exotic colour spaces), so nothing changes colour.
async function shrinkImages(doc, preset) {
  let count = 0;
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (d.get(PDFName.of('Subtype'))?.toString() !== '/Image' || d.has(PDFName.of('Decode'))) continue;
    if (d.get(PDFName.of('ImageMask'))?.toString() === 'true') continue;
    const cs = d.get(PDFName.of('ColorSpace'))?.toString();
    if (cs !== '/DeviceRGB' && cs !== '/DeviceGray') continue;
    const w = d.get(PDFName.of('Width'))?.asNumber?.();
    const h = d.get(PDFName.of('Height'))?.asNumber?.();
    const bpc = d.get(PDFName.of('BitsPerComponent'))?.asNumber?.();
    const filter = d.get(PDFName.of('Filter'))?.toString();
    if (!w || !h || obj.contents.length < 60e3) continue;
    let result;
    try {
      if (filter === '/DCTDecode') {
        result = await reencode(new Blob([obj.contents], { type: 'image/jpeg' }), w, h, preset);
      } else if (filter === '/FlateDecode' && bpc === 8 && !d.has(PDFName.of('DecodeParms'))) {
        const raw = decodePDFRawStream(obj).decode();
        const channels = cs === '/DeviceRGB' ? 3 : 1;
        if (raw.length < w * h * channels) continue;
        const rgba = new Uint8ClampedArray(w * h * 4);
        for (let p = 0; p < w * h; p++) {
          rgba[p * 4] = raw[p * channels];
          rgba[p * 4 + 1] = raw[p * channels + (channels === 3 ? 1 : 0)];
          rgba[p * 4 + 2] = raw[p * channels + (channels === 3 ? 2 : 0)];
          rgba[p * 4 + 3] = 255;
        }
        result = await reencode(new ImageData(rgba, w, h), w, h, preset);
      } else continue;
    } catch {
      continue; // undecodable here: leave it alone
    }
    if (result.bytes.length > obj.contents.length * 0.85) continue;
    d.set(PDFName.of('Width'), PDFNumber.of(result.width));
    d.set(PDFName.of('Height'), PDFNumber.of(result.height));
    d.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
    d.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
    d.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
    d.delete(PDFName.of('DecodeParms'));
    doc.context.assign(ref, PDFRawStream.of(d, result.bytes));
    count++;
  }
  return count;
}

async function compress() {
  const before = ctx.state.bytes.length;
  const level = await form('Reduce file size', Object.entries(PRESETS).map(([k, p], n) =>
    `<label class="opt"><input type="radio" name="q" value="${k}" ${n === 1 ? 'checked' : ''} /> ${p.label} <span class="muted">(images up to ${p.maxDim}px)</span></label>`).join(''),
  'Reduce', (b) => b.querySelector('input[name="q"]:checked').value, { note: `Currently ${mb(before)}. Large images are re-saved at a lower resolution, and unused data is removed.` });
  if (!level) return;
  await ctx.enqueue(async () => {
    const snap = ctx.snapshot();
    const doc = await PDFDocument.load(ctx.state.bytes, { updateMetadata: false });
    const images = await shrinkImages(doc, PRESETS[level]);
    ctx.collectGarbage(doc);
    const bytes = await doc.save({ useObjectStreams: true });
    if (bytes.length >= before * 0.98) return ctx.toast(`Already compact (${mb(before)}); nothing to reduce.`, { ms: 4000 });
    ctx.pushUndo(snap);
    await ctx.reloadBytes(bytes);
    ctx.markDirty();
    ctx.toast(`Reduced from ${mb(before)} to ${mb(bytes.length)}${images ? ` (${images} image${images > 1 ? 's' : ''} resized)` : ''}. Save to keep it.`, { ms: 6000 });
  });
}

// ---- Password ----------------------------------------------------------------------------------

async function savePassword() {
  if (ctx.state.readOnly) return ctx.toast('This PDF is already protected.', { error: true });
  const opts = await form('Save with password', `
    <label class="field-row">Password <input type="password" class="p1" autocomplete="new-password" /></label>
    <label class="field-row">Confirm <input type="password" class="p2" autocomplete="new-password" /></label>
    <label class="opt"><input type="checkbox" class="pr" checked /> Allow printing</label>
    <label class="opt"><input type="checkbox" class="cp" checked /> Allow copying text</label>
    <label class="opt"><input type="checkbox" class="md" checked /> Allow editing and comments</label>`,
  'Save', (b) => {
    const p1 = b.querySelector('.p1').value;
    if (p1.length < 4) return ctx.toast('Use at least 4 characters', { error: true }), null;
    if (p1 !== b.querySelector('.p2').value) return ctx.toast("The passwords don't match", { error: true }), null;
    return { password: p1, print: b.querySelector('.pr').checked, copy: b.querySelector('.cp').checked, modify: b.querySelector('.md').checked };
  }, { note: 'Saves an encrypted copy (AES-128) that asks for this password to open. Keep it safe: it cannot be recovered.' });
  if (!opts) return;
  await ctx.enqueue(async () => {
    const out = await encryptPdf(await ctx.buildOutput(), opts.password, null, opts);
    const res = await ctx.api.saveAs(out, `${baseName()} (protected).pdf`);
    if (res) ctx.toast(`Saved ${res.name}`);
  });
}

// ---- Export / convert ----------------------------------------------------------------------------

async function exportImages() {
  const count = ctx.state.pages.length;
  const opts = await form('Export pages as images', `
    <label class="field-row">Format <select class="fmt"><option value="png">PNG</option><option value="jpeg">JPEG</option></select></label>
    <label class="field-row">Resolution <select class="dpi"><option value="96">96 dpi (screen)</option><option value="150" selected>150 dpi</option><option value="300">300 dpi (print)</option></select></label>
    <label class="field-row">Pages <input type="text" class="r" value="1-${count}" /></label>`,
  'Export', (b) => {
    const pages = parseRanges(b.querySelector('.r').value, count);
    if (!pages) return ctx.toast('Check the page range', { error: true }), null;
    return { pages, fmt: b.querySelector('.fmt').value, dpi: Number(b.querySelector('.dpi').value) };
  });
  if (!opts) return;
  await ctx.enqueue(async () => {
    ctx.toast('Rendering pages…');
    const pdf = await ctx.loadPdfJs(await ctx.buildOutput());
    const files = [];
    try {
      for (const i of opts.pages) {
        const page = await pdf.getPage(i + 1);
        const vp = page.getViewport({ scale: opts.dpi / 72 });
        const canvas = Object.assign(document.createElement('canvas'), { width: Math.ceil(vp.width), height: Math.ceil(vp.height) });
        const c2d = canvas.getContext('2d');
        c2d.fillStyle = '#fff';
        c2d.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: c2d, viewport: vp, intent: 'print' }).promise;
        const blob = await new Promise((r) => canvas.toBlob(r, `image/${opts.fmt}`, 0.92));
        files.push({ name: `${baseName()} - page ${i + 1}.${opts.fmt === 'jpeg' ? 'jpg' : 'png'}`, data: new Uint8Array(await blob.arrayBuffer()) });
      }
    } finally {
      pdf.loadingTask.destroy();
    }
    const res = await ctx.api.saveMany(files, 'Choose a folder for the images');
    if (res) ctx.toast(`Saved ${res.count} image${res.count > 1 ? 's' : ''}`);
  });
}

async function exportText() {
  await ctx.enqueue(async () => {
    const chunks = [];
    for (let i = 0; i < ctx.state.pages.length; i++) {
      const tc = await ctx.state.pages[i].getTextContent();
      let text = '';
      for (const it of tc.items) text += it.str + (it.hasEOL ? '\n' : '');
      // Recognized (OCR) words, line by line.
      const ocr = ctx.ocrLines(i).map((l) => l.text).join('\n');
      chunks.push(`--- Page ${i + 1} ---\n${[text.trim(), ocr].filter(Boolean).join('\n')}\n`);
    }
    const res = await ctx.api.saveFile(chunks.join('\n'), `${baseName()}.txt`, { name: 'Text', extensions: ['txt'] });
    if (res) ctx.toast(`Saved ${res.name}`);
  });
}

async function fromImages() {
  const images = await ctx.api.openImages();
  if (!images.length) return;
  const doc = await PDFDocument.create();
  for (const img of images) {
    // Normalise every format to PNG/JPEG through the browser's decoder.
    const blob = new Blob([img.data]);
    const bmp = await createImageBitmap(blob).catch(() => null);
    if (!bmp) {
      ctx.toast(`Skipped ${img.name}: unsupported image`, { error: true });
      continue;
    }
    const canvas = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    const isJpeg = /\.(jpe?g)$/i.test(img.name);
    const out = new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, isJpeg ? 'image/jpeg' : 'image/png', 0.92))).arrayBuffer());
    const embedded = isJpeg ? await doc.embedJpg(out) : await doc.embedPng(out);
    // Fit on a Letter-size page in the image's orientation, with a small margin.
    const portrait = bmp.height >= bmp.width;
    const [pw, ph] = portrait ? [612, 792] : [792, 612];
    const s = Math.min((pw - 36) / bmp.width, (ph - 36) / bmp.height, 1);
    const page = doc.addPage([pw, ph]);
    page.drawImage(embedded, { x: (pw - bmp.width * s) / 2, y: (ph - bmp.height * s) / 2, width: bmp.width * s, height: bmp.height * s });
  }
  if (!doc.getPageCount()) return;
  await ctx.api.openBytes(await doc.save(), `${images.length === 1 ? images[0].name.replace(/\.[^.]+$/, '') : 'Images'}.pdf`);
}
