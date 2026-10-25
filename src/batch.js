// Batch processing: run OCR, watermark, page numbers, size reduction and
// password protection over many PDFs, saving the results into a folder.
// Each file is processed on its own (no tab is opened for it).

import { stampNumbers, stampWatermark, shrinkImages, PRESETS } from './pagetools.js';
import { encryptPdf } from './crypto.js';
import { collectGarbage } from './textedit.js';

const {
  PDFDocument, StandardFonts, pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize,
  setTextMatrix, setTextRenderingMode, showText, TextRenderingMode,
} = window.PDFLib;

let ctx;
export function installBatch(context) {
  ctx = context;
  return { batch: runBatch };
}

// Invisible OCR text on pages that have (almost) no text of their own.
async function ocrPages(pdf, doc, onPage) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let words = 0;
  for (let i = 0; i < pdf.numPages; i++) {
    onPage(i);
    const page = await pdf.getPage(i + 1);
    const existing = (await page.getTextContent()).items.map((t) => t.str).join('').trim();
    if (existing.length > 20) continue;
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, 4200 / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.floor(vp.width), height: Math.floor(vp.height) });
    const c2d = canvas.getContext('2d');
    c2d.fillStyle = '#fff';
    c2d.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: c2d, viewport: vp }).promise;
    const png = new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, 'image/png'))).arrayBuffer());
    const lines = await ctx.api.ocr(png);
    const target = doc.getPage(i);
    target.setFont(font);
    const r = (base.rotation * Math.PI) / 180;
    for (const line of lines) {
      for (const w of line.words) {
        if (w.confidence < 20) continue;
        const text = ctx.encodable(font, w.text);
        const unit = font.widthOfTextAtSize(text, 1);
        if (!text.trim() || !unit) continue;
        const { x0, y0, x1, y1 } = w.bbox;
        const [ux, uy] = base.convertToPdfPoint(x0 / scale, (y0 + (y1 - y0) * 0.8) / scale);
        target.pushOperators(
          pushGraphicsState(), beginText(), setFontAndSize(target.fontKey, (x1 - x0) / scale / unit),
          setTextRenderingMode(TextRenderingMode.Invisible),
          setTextMatrix(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), ux, uy),
          showText(font.encodeText(text)), endText(), popGraphicsState()
        );
        words++;
      }
    }
  }
  return words;
}

function optionsModal() {
  return ctx.modal((m, close) => {
    m.innerHTML = `<h2>Batch process PDFs</h2>
      <p>Choose what to do to every file. You'll pick the files, then a folder for the results.</p>
      <div class="form batch-steps">
        <label class="opt"><input type="checkbox" class="b-ocr" /> Recognize text in scanned pages (OCR)</label>
        <label class="opt"><input type="checkbox" class="b-wm" /> Watermark <input type="text" class="b-wm-text" value="CONFIDENTIAL" /></label>
        <label class="opt"><input type="checkbox" class="b-num" /> Page numbers <select class="b-num-fmt"><option value="{n}">1</option><option value="Page {n} of {total}">Page 1 of N</option></select></label>
        <label class="opt"><input type="checkbox" class="b-small" /> Reduce file size <select class="b-small-q"><option value="high">High quality</option><option value="medium" selected>Balanced</option><option value="small">Smallest</option></select></label>
        <label class="opt"><input type="checkbox" class="b-pw" /> Password <input type="password" class="b-pw-text" autocomplete="new-password" /></label>
      </div><div class="actions"></div>`;
    const q = (c) => m.querySelector(c);
    // Typing into an option's field ticks it.
    for (const [box, field] of [['.b-wm', '.b-wm-text'], ['.b-num', '.b-num-fmt'], ['.b-small', '.b-small-q'], ['.b-pw', '.b-pw-text']]) {
      q(field).addEventListener('input', () => (q(box).checked = true));
    }
    m.querySelector('.actions').append(ctx.button('Cancel', 'secondary', () => close(null)), ctx.button('Choose files…', 'primary', () => {
      const steps = {
        ocr: q('.b-ocr').checked,
        watermark: q('.b-wm').checked && q('.b-wm-text').value.trim(),
        numbers: q('.b-num').checked && q('.b-num-fmt').value,
        compress: q('.b-small').checked && q('.b-small-q').value,
        password: q('.b-pw').checked && q('.b-pw-text').value,
      };
      if (!Object.values(steps).some(Boolean)) return ctx.toast('Choose at least one step', { error: true });
      if (q('.b-pw').checked && steps.password.length < 4) return ctx.toast('Use a password of at least 4 characters', { error: true });
      close(steps);
    }));
  });
}

async function runBatch() {
  const steps = await optionsModal();
  if (!steps) return;
  const files = await ctx.api.openPdfs();
  if (!files.length) return;
  let cancelled = false;
  let report;
  const progress = ctx.modal((m, close) => {
    m.innerHTML = '<h2>Processing…</h2><ol class="batch-list"></ol><div class="actions"></div>';
    const list = m.querySelector('ol');
    const rows = files.map((f) => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="name"></span> <span class="status muted">waiting</span>';
      li.querySelector('.name').textContent = f.name;
      list.append(li);
      return li.querySelector('.status');
    });
    report = { rows, close };
    m.querySelector('.actions').append(ctx.button('Cancel', 'secondary', () => (cancelled = true)));
  });
  progress.then(() => (cancelled = true));

  const outputs = [];
  const failures = [];
  for (const [n, file] of files.entries()) {
    if (cancelled) break;
    const status = report.rows[n];
    try {
      let bytes = file.data;
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      const pdf = await ctx.loadPdfJs(bytes);
      const viewports = await Promise.all(Array.from({ length: pdf.numPages }, async (_, i) => (await pdf.getPage(i + 1)).getViewport({ scale: 1 })));
      if (steps.ocr) await ocrPages(pdf, doc, (i) => (status.textContent = `recognizing page ${i + 1} of ${pdf.numPages}`));
      pdf.loadingTask.destroy();
      status.textContent = 'processing';
      if (steps.watermark) await stampWatermark(doc, viewports, { text: steps.watermark, size: 64, opacity: 0.18, angle: 45, color: '#e5484d' });
      if (steps.numbers) await stampNumbers(doc, viewports, { fmt: steps.numbers, pos: 'bottom-center', start: 1, size: 10 });
      if (steps.compress) await shrinkImages(doc, PRESETS[steps.compress]);
      collectGarbage(doc);
      bytes = await doc.save({ useObjectStreams: true });
      if (steps.password) bytes = await encryptPdf(bytes, steps.password);
      outputs.push({ name: file.name, data: bytes });
      status.textContent = `done (${Math.max(1, Math.round(bytes.length / 1024))} KB)`;
    } catch (err) {
      failures.push(file.name);
      status.textContent = `failed: ${/encrypt/i.test(err.message) ? 'password-protected' : err.message}`;
    }
  }
  report.close(true);
  if (!outputs.length) return ctx.toast(failures.length ? `Couldn't process ${failures.join(', ')}` : 'Cancelled', { error: !!failures.length, ms: 6000 });
  const res = await ctx.api.saveMany(outputs, 'Choose a folder for the processed files');
  if (res) ctx.toast(`Saved ${res.count} file${res.count > 1 ? 's' : ''}${failures.length ? `; ${failures.length} failed (${failures.join(', ')})` : ''}`, { ms: 6000 });
}
