// Agility — renderer.
//
// pdf.js renders pages; pdf-lib owns the document structure. The current page
// structure lives in `state.bytes` (rotations, page order, inserted/merged pages
// are applied to it immediately). Markup the user adds lives as editable
// overlay objects in `state.annotations`, stored in unscaled display units of
// each page (points, origin top-left, page's current rotation). On save they're
// drawn into the page content with pdf-lib.

import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';
import { removeTextLine, redactText, collectGarbage } from './textedit.js';
import { isAnnotationType, writeAnnotations, takeAnnotations } from './pdfannots.js';
import { fontChoice, fontBytes, fontReady, captureFont, onFontLoaded } from './fonts.js';
import { install as installPageTools, cropTo } from './pagetools.js';
import { isEncrypted, decryptPdf } from './decrypt.js';
import { encryptPdf } from './crypto.js';
import { readOutline, writeOutline } from './outline.js';
import { detectFields, addFields, setTabOrder, fieldInfo, applyFieldInfo } from './forms.js';

const {
  PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle,
  PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList,
  pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setTextMatrix,
  setTextRenderingMode, showText, TextRenderingMode, PDFName, PDFDict, PDFArray,
} = window.PDFLib;

const asset = (p) => new URL(`../node_modules/pdfjs-dist/${p}`, import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = asset('build/pdf.worker.mjs');
const PDFJS_OPTIONS = {
  cMapUrl: asset('cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: asset('standard_fonts/'),
  wasmUrl: asset('wasm/'),
  iccUrl: asset('iccs/'),
  isEvalSupported: false,
};

const api = window.api;
const $ = (sel) => document.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const div = (cls) => Object.assign(document.createElement('div'), { className: cls });
const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

const viewerEl = $('#viewer');
const pagesEl = $('#pages');
const thumbsEl = $('#thumbs');
const findInput = $('#find');
const colorInput = $('#prop-color');
const widthInput = $('#prop-width');
const fontInput = $('#prop-font');
const familyInput = $('#prop-family');
const boldButton = $('#prop-bold');
const italicButton = $('#prop-italic');
const zoomSelect = $('#zoom');

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const DRAW_TOOLS = new Set(['pen', 'highlight', 'rect', 'ellipse', 'line', 'arrow', 'whiteout', 'redact', 'field', 'crop', 'link']);
// Tools that mark up the document's own text by selecting it.
const MARKUP_TOOLS = { highlight: 'highlight', underline: 'underline', strike: 'strike' };
// Markup that lies flat on the text: it never blocks text selection, and is
// picked by a plain click instead (see onPagePointerDown).
const PASSIVE_TYPES = new Set(['markup', 'highlight']);
const BOX_TYPES = new Set(['highlight', 'whiteout', 'rect', 'ellipse', 'image', 'redact', 'mark', 'link']);
// Checkmark, cross and dot stamps for filling in forms, drawn in a 16×16 box.
const MARK_PATHS = { check: 'M2.5 8.5 6.5 12.5 13.5 3.5', cross: 'M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5' };
const TEXT_PAD_X = 0.2; // em, must match .annot.text .content padding
const TEXT_PAD_Y = 0.1;

// Text boxes use one of the PDF standard fonts, previewed with the closest system font.
const FONT_CSS = {
  sans: 'Helvetica, Arial, sans-serif',
  serif: '"Times New Roman", Times, serif',
  mono: '"Courier New", Courier, monospace',
};
const STANDARD_FONT = {
  sans: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  serif: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  mono: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
};
const standardFontName = (a) => STANDARD_FONT[a.font || 'sans'][(a.bold ? 1 : 0) + (a.italic ? 2 : 0)];

const SIGNATURE_FONTS = [
  { family: 'Great Vibes', pkg: 'great-vibes' },
  { family: 'Dancing Script', pkg: 'dancing-script' },
  { family: 'Sacramento', pkg: 'sacramento' },
  { family: 'Caveat', pkg: 'caveat' },
];

// CSS for previewing a text box in the font it will be saved with. Fonts loaded
// from a file already are the right weight and style, so they aren't synthesized.
function textCss(a) {
  const choice = fontChoice(a);
  if (choice.family) return { fontFamily: `${choice.family}, ${FONT_CSS[a.font || 'sans']}`, fontWeight: 'normal', fontStyle: 'normal' };
  return { fontFamily: FONT_CSS[a.font || 'sans'], fontWeight: a.bold ? 'bold' : 'normal', fontStyle: a.italic ? 'italic' : 'normal' };
}

// Distance from the top of a text box's first line to its baseline, in em, measured
// from the browser's own layout so saved text lands exactly where it was shown.
const baselineCache = new Map();
function textBaseline(a) {
  const css = textCss(a);
  const lh = a.lh || 1.2;
  const key = `${css.fontFamily}|${css.fontWeight}|${css.fontStyle}|${lh}`;
  if (!baselineCache.has(key)) {
    const probe = div('');
    Object.assign(probe.style, {
      position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', fontSize: '100px', lineHeight: String(lh), ...css,
    });
    const mark = document.createElement('span');
    Object.assign(mark.style, { display: 'inline-block', width: '1px', height: '0', verticalAlign: 'baseline' });
    probe.append('Hg', mark);
    document.body.append(probe);
    baselineCache.set(key, (mark.getBoundingClientRect().top - probe.getBoundingClientRect().top) / 100);
    probe.remove();
  }
  return baselineCache.get(key);
}

// Lines of a text box as drawn. Wrapped boxes (a.wrap = width) break at spaces
// using the same font measurements as the on-screen preview, so the saved file
// wraps exactly as shown.
const measureCtx = document.createElement('canvas').getContext('2d');
function layoutLines(a) {
  const paragraphs = (a.text || '').split('\n');
  if (!a.wrap) return paragraphs;
  const css = textCss(a);
  measureCtx.font = `${css.fontStyle} ${css.fontWeight} ${a.size}px ${css.fontFamily}`;
  const max = a.wrap - a.size * TEXT_PAD_X * 2;
  const fits = (t) => measureCtx.measureText(t).width <= max + 0.01;
  const out = [];
  for (const para of paragraphs) {
    let line = '';
    for (const token of para.split(/(\s+)/)) {
      if (!token) continue;
      const candidate = line + token;
      if (fits(candidate.trimEnd()) || !line.trim()) {
        line = candidate;
        // A single word wider than the box breaks between characters.
        while (!fits(line.trimEnd()) && line.trim().length > 1) {
          let k = line.length - 1;
          while (k > 1 && !fits(line.slice(0, k))) k--;
          out.push(line.slice(0, k));
          line = line.slice(k);
        }
      } else {
        out.push(line.trimEnd());
        line = token.trimStart();
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

const state = {
  pdf: null,
  bytes: null,
  readOnly: false,
  filePath: null,
  fileName: null,
  pages: [], // pdf.js page proxies
  views: [], // per-page DOM
  thumbs: [],
  pageIds: [], // stable id per page so annotations survive reordering
  annotations: {}, // pageId -> annotation[]
  formValues: {}, // fieldName -> value
  scale: 1,
  zoomMode: 'fit-width',
  current: 0,
  tool: 'select',
  colors: { shape: '#e5484d', text: '#1a1a1a', highlight: '#ffd400', underline: '#1a9f4b', strike: '#e5484d' },
  textStyle: { font: 'sans', bold: false, italic: false },
  selected: null, // { page, id }
  pendingImage: null,
  lastSignature: null,
  undo: [],
  redo: [],
  dirty: false,
  find: null,
  thumbGen: 0,
};

// ---- Small UI helpers ------------------------------------------------------

let toastTimer;
function toast(msg, { error = false, ms = 2600 } = {}) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function modal(build) {
  return new Promise((resolve) => {
    const back = $('#modal');
    const box = div('modal');
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
    };
    const close = (value) => {
      back.hidden = true;
      back.replaceChildren();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    document.addEventListener('keydown', onKey, true);
    back.replaceChildren(box);
    back.hidden = false;
    build(box, close);
  });
}

function button(label, cls, onClick) {
  const b = Object.assign(document.createElement('button'), { textContent: label, className: cls });
  b.addEventListener('click', onClick);
  return b;
}

function confirmModal(title, message, okLabel = 'Continue') {
  return modal((box, close) => {
    box.innerHTML = '<h2></h2><p></p><div class="actions"></div>';
    box.querySelector('h2').textContent = title;
    box.querySelector('p').textContent = message;
    box.querySelector('.actions').append(
      button('Cancel', 'secondary', () => close(false)),
      button(okLabel, 'primary', () => close(true))
    );
  });
}

function passwordModal(retry, owner = false) {
  return modal((box, close) => {
    box.innerHTML = `<h2>Password required</h2><p></p>
      <input type="password" autocomplete="off" /><div class="actions"></div>`;
    box.querySelector('p').textContent = retry
      ? 'Incorrect password. Try again.'
      : owner ? 'Enter the owner password to allow editing.' : 'This document is protected. Enter its password to open it.';
    const input = box.querySelector('input');
    const submit = () => close(input.value);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
    box.querySelector('.actions').append(
      button('Cancel', 'secondary', () => close(null)),
      button('Open', 'primary', submit)
    );
    setTimeout(() => input.focus());
  });
}

const isEditable = (el) =>
  !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
const canEdit = () => !!state.pdf && !state.readOnly;

function updateUI() {
  for (const el of document.querySelectorAll('[data-needs-doc]')) el.disabled = !state.pdf;
  for (const el of document.querySelectorAll('[data-needs-edit]')) el.disabled = !canEdit();
  $('[data-action="undo"]').disabled = !state.undo.length;
  $('[data-action="redo"]').disabled = !state.redo.length;
  $('[data-action="save"]').disabled = !canEdit();
  $('#welcome').classList.toggle('hidden', !!state.pdf);
  $('#page-count').textContent = `/ ${state.pages.length}`;
  if (!state.pdf) $('#page-num').value = '–';
  api.setDocState({
    dirty: state.dirty,
    title: state.fileName,
    filePath: state.filePath,
    hasDocument: !!state.pdf,
  });
}

function markDirty() {
  state.dirty = true;
  state.version = (state.version || 0) + 1;
  updateUI();
  scheduleComments();
}

// ---- Crash recovery -------------------------------------------------------------
// While there are unsaved changes, a snapshot goes to the main process every few
// seconds; it is deleted on save or close, and offered back after a crash.

let recoveredVersion = 0;
setInterval(() => {
  // Never write a decrypted copy of a password-protected document to disk.
  if (!state.pdf || !state.dirty || state.version === recoveredVersion || state.protection || prefs?.recovery === false) return;
  recoveredVersion = state.version;
  const meta = {
    filePath: state.filePath, fileName: state.fileName, pageIds: state.pageIds,
    annotations: state.annotations, formValues: state.formValues,
  };
  api.saveRecovery(meta, state.bytes);
}, 5000);

api.onRestore(({ meta, bytes }) => enqueue(async () => {
  await openDocument({ data: bytes, path: meta.filePath, name: meta.fileName || 'Untitled.pdf' });
  if (meta.filePath) api.allowWrite(meta.filePath);
  if (meta.pageIds?.length === state.pageIds.length) {
    state.pageIds = meta.pageIds;
    state.annotations = meta.annotations || {};
    state.formValues = meta.formValues || {};
    layoutPages();
  }
  if (meta.fresh) state.filePath = null;
  markDirty();
  if (!meta.fresh) toast('Recovered unsaved changes.', { ms: 4000 });
}));

// Serialize anything that rebuilds the document so rapid clicks can't interleave.
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn).catch((err) => {
    console.error(err);
    toast(err.message || String(err), { error: true, ms: 5000 });
  });
  queue = run;
  return run;
}

// ---- Loading ---------------------------------------------------------------

async function loadPdfJs(bytes, password) {
  // pdf.js transfers the buffer to its worker, so always hand it a copy.
  const task = pdfjsLib.getDocument({ ...PDFJS_OPTIONS, data: bytes.slice(), password });
  task.onPassword = async (updatePassword, reason) => {
    const pw = await passwordModal(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
    if (pw == null) task.destroy();
    else updatePassword(pw);
  };
  return task.promise;
}

async function confirmDiscard() {
  if (!state.dirty) return true;
  return confirmModal('Discard unsaved changes?', 'The current document has changes that have not been saved.', 'Discard');
}

// Unlock a password-protected PDF for editing. Returns { bytes, protection }
// (plain bytes, and how to re-protect on save), { restricted } when the
// permissions forbid editing without the owner password, or null if cancelled.
async function unlock(bytes, { ownerOnly = false } = {}) {
  let res = ownerOnly ? null : await decryptPdf(bytes, '');
  let password = '';
  for (let retry = false; !res || (ownerOnly && !res.owner); retry = true) {
    password = await passwordModal(retry, ownerOnly);
    if (password == null) return null;
    res = await decryptPdf(bytes, password);
  }
  if (!res.owner && !res.permissions.modify) return { restricted: true, password };
  return { bytes: res.bytes, protection: { password, permissions: res.permissions } };
}

async function openDocument({ data, path = null, name = 'Untitled.pdf' }) {
  let bytes = new Uint8Array(data);
  const original = bytes;
  let readOnly = false;
  let imported = null;
  let protection = null;
  let viewPassword;
  if (isEncrypted(bytes)) {
    let unlocked;
    try {
      unlocked = await unlock(bytes);
    } catch {
      unlocked = { restricted: true }; // a security handler we can't decrypt: view only
    }
    if (!unlocked) return;
    if (unlocked.restricted) {
      readOnly = 'restricted';
      viewPassword = unlocked.password;
    } else {
      bytes = unlocked.bytes;
      protection = unlocked.protection;
      setTimeout(() => toast('Unlocked for editing. It will be saved with the same password.', { ms: 5000 }), 300);
    }
  }
  if (!readOnly) try {
    // Markup Agility saved as annotations comes back as editable objects; take it
    // out of the page so it isn't drawn twice.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    imported = takeAnnotations(doc, rotateAnnotation);
    if (imported) bytes = await doc.save();
  } catch (err) {
    readOnly = true;
    setTimeout(() => toast("This PDF couldn't be parsed for editing, so it opened read-only.", { ms: 6000 }), 300);
  }
  if (readOnly === 'restricted') {
    setTimeout(() => toast("The author doesn't allow editing this PDF. Use Unlock to enter the owner password.", { ms: 7000 }), 300);
  }
  let pdf;
  try {
    pdf = await loadPdfJs(bytes, viewPassword);
  } catch (err) {
    if (err?.name === 'PasswordException' || /destroyed/i.test(err?.message)) return;
    throw new Error(`Couldn't open “${name}”: ${err.message}`);
  }

  state.pdf?.loadingTask.destroy();
  const pageIds = Array.from({ length: pdf.numPages }, uid);
  const annotations = {};
  imported?.forEach((list, i) => list && pageIds[i] && (annotations[pageIds[i]] = list));
  // Saved links remember their target page by number; map it to this session's page ids.
  for (const a of Object.values(annotations).flat()) if (a.type === 'link' && a.pageIndex != null) a.pageId = pageIds[a.pageIndex];
  Object.assign(state, {
    bytes, readOnly, protection, original, filePath: path, fileName: name, pageIds, annotations,
    formValues: {}, undo: [], redo: [],
    dirty: false, selected: null, pendingImage: null, find: null, current: 0,
  });
  findInput.value = '';
  $('#find-status').textContent = '';
  await setPdf(pdf);
  setTool('select');
  setZoom(prefs?.defaultZoom || 'fit-width');
  viewerEl.scrollTop = 0;
  state.outline = await readOutline(pdf, pageIds);
  state.outlineEdited = false;
  renderBookmarks();
  updateUI();
  renderComments();
}

async function openPath(filePath) {
  if (!(await confirmDiscard())) return;
  await openDocument(await api.readPdf(filePath));
}

async function setPdf(pdf) {
  if (state.pdf && state.pdf !== pdf) state.pdf.loadingTask.destroy();
  for (const v of state.views) v.task?.cancel();
  state.pdf = pdf;
  state.pages = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)));
  state.textCache = new Map();
  buildPages();
  buildThumbs();
}

// Rebuild after a structural change, keeping the reader on roughly the same spot.
// Keep the exact scroll position: jumping to the top of the page would move the
// text out from under the pointer mid-click (callers that should move, such as
// inserting a page, scroll afterwards).
async function reloadBytes(bytes) {
  const { scrollTop, scrollLeft } = viewerEl;
  const pdf = await loadPdfJs(bytes);
  state.bytes = bytes;
  await setPdf(pdf);
  layoutPages();
  viewerEl.scrollTop = scrollTop;
  viewerEl.scrollLeft = scrollLeft;
  scheduleRender();
  updateUI();
}

// ---- Page views ----------------------------------------------------------------

const baseViewport = (i) => state.pages[i].getViewport({ scale: 1 });

function buildPages() {
  pagesEl.replaceChildren();
  state.views = state.pages.map((_, i) => {
    const el = div('page');
    const canvas = Object.assign(document.createElement('canvas'), { className: 'render', width: 0, height: 0 });
    const text = div('textLayer');
    const hits = div('hits');
    const annots = div('annots');
    const forms = div('forms');
    el.append(canvas, text, hits, annots, forms);
    pagesEl.append(el);
    // Listen on the page itself: with the Select and markup tools the annotation
    // layer lets presses through to the text layer so text can be selected.
    el.addEventListener('pointerdown', (e) => onPagePointerDown(e, i));
    el.addEventListener('dblclick', (e) => onPageDoubleClick(e, i));
    return { el, canvas, text, hits, annots, forms, renderedScale: 0, textScale: 0, task: null, widgets: null };
  });
}

// Size every page, then let renderVisible() fill in the ones near the view.
// Overlays that are cheap (markup, search hits) are laid out everywhere; form
// fields and edit-text targets only for pages near the view.
function layoutPages() {
  state.views.forEach((v, i) => {
    const vp = baseViewport(i);
    v.el.style.width = `${vp.width * state.scale}px`;
    v.el.style.height = `${vp.height * state.scale}px`;
    v.el.style.setProperty('--total-scale-factor', state.scale);
    v.formsScale = 0;
    v.editKey = null;
    renderAnnotations(i);
    drawHits(i);
  });
  state.tops = state.views.map((v) => v.el.offsetTop);
  scheduleRender();
}

// First page whose top is below y (pages are stacked in order).
function pageAt(y) {
  const tops = state.tops || [];
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Pages within a screen of the view get rendered; ones far away give their
// canvas and text layer back, so memory stays flat however long the document.
const KEEP_SCREENS = 4;
function renderVisible() {
  if (!state.views.length) return;
  const top = viewerEl.scrollTop;
  const h = viewerEl.clientHeight;
  const first = pageAt(top - h);
  const last = pageAt(top + 2 * h);
  for (let i = first; i <= last; i++) {
    const v = state.views[i];
    if (v.renderedScale !== state.scale) renderPage(i);
    else if (v.textScale !== state.scale && !v.task) renderTextLayer(i, state.scale);
    if (v.formsScale !== state.scale) renderForms(i);
    const editKey = `${state.tool}|${state.scale}`;
    if (v.editKey !== editKey) {
      v.editKey = editKey;
      renderEditLines(i);
    }
  }
  const keepFrom = pageAt(top - KEEP_SCREENS * h);
  const keepTo = pageAt(top + (KEEP_SCREENS + 1) * h);
  state.views.forEach((v, i) => {
    if ((i < keepFrom || i > keepTo) && (v.renderedScale || v.textScale)) releasePage(v);
  });
}

// Edit-text targets are rebuilt lazily for the pages near the view.
function refreshEditLines() {
  for (const v of state.views) v.editKey = null;
  scheduleRender();
}

function releasePage(v) {
  v.task?.cancel();
  v.textLayer?.cancel();
  const blank = Object.assign(document.createElement('canvas'), { className: 'render', width: 0, height: 0 });
  v.canvas.replaceWith(blank);
  v.canvas = blank;
  v.text.replaceChildren();
  v.renderedScale = 0;
  v.textScale = 0;
}

let renderFrame = 0;
let renderTimer = 0;
function scheduleRender(delay = 0) {
  clearTimeout(renderTimer);
  const go = () => {
    cancelAnimationFrame(renderFrame);
    renderFrame = requestAnimationFrame(() => {
      renderVisible();
      updateCurrentPage();
    });
  };
  if (delay) renderTimer = setTimeout(go, delay);
  else go();
}


async function renderPage(i) {
  const v = state.views[i];
  const page = state.pages[i];
  const scale = state.scale;
  v.task?.cancel();
  v.renderedScale = scale;
  const vp = page.getViewport({ scale });
  const maxPixels = 24e6;
  let ratio = window.devicePixelRatio || 1;
  if (vp.width * vp.height * ratio * ratio > maxPixels) ratio = Math.sqrt(maxPixels / (vp.width * vp.height));
  const canvas = Object.assign(document.createElement('canvas'), { className: 'render' });
  canvas.width = Math.floor(vp.width * ratio);
  canvas.height = Math.floor(vp.height * ratio);
  const task = page.render({
    canvasContext: canvas.getContext('2d'),
    viewport: vp,
    transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
    // Form widgets are drawn as live HTML inputs instead (see renderForms).
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
  });
  v.task = task;
  try {
    await task.promise;
    v.canvas.replaceWith(canvas);
    v.canvas = canvas;
    if (v.textScale !== scale) renderTextLayer(i, scale);
  } catch (err) {
    if (!(err instanceof pdfjsLib.RenderingCancelledException)) console.error(err);
    if (v.renderedScale === scale && v.task === task) v.renderedScale = 0;
  } finally {
    if (v.task === task) v.task = null;
  }
}

// Selectable text: pdf.js lays transparent spans over the glyphs; recognized
// (OCR) words get the same treatment so scanned pages can be selected too.
async function renderTextLayer(i, scale) {
  const v = state.views[i];
  const page = state.pages[i];
  v.textScale = scale;
  v.textLayer?.cancel();
  const container = div('textLayer');
  const layer = new pdfjsLib.TextLayer({
    textContentSource: page.streamTextContent({ includeMarkedContent: true }),
    container,
    viewport: page.getViewport({ scale }),
  });
  v.textLayer = layer;
  try {
    await layer.render();
  } catch {
    return; // superseded by a newer render
  }
  if (state.views[i] !== v || v.textLayer !== layer) return;
  addOcrSpans(i, container, scale);
  container.append(div('endOfContent'));
  v.text.replaceWith(container);
  v.text = container;
}

function addOcrSpans(i, container, scale) {
  for (const a of annotsOf(i)) {
    if (a.type !== 'ocrtext') continue;
    const span = Object.assign(document.createElement('span'), { className: 'ocr', textContent: `${a.text} ` });
    Object.assign(span.style, {
      left: `${a.x * scale}px`, top: `${a.y * scale}px`, fontSize: `${a.h * scale * 0.9}px`, width: `${a.w * scale}px`,
    });
    container.append(span);
  }
}

function refreshTextLayers() {
  state.views.forEach((v) => (v.textScale = 0));
  scheduleRender();
}

function updateCurrentPage() {
  if (!state.views.length) return;
  setCurrent(pageAt(viewerEl.scrollTop + viewerEl.clientHeight * 0.35));
}

function setCurrent(i) {
  if (state.thumbs[state.current]) state.thumbs[state.current].el.classList.remove('current');
  state.current = i;
  const t = state.thumbs[i];
  if (t) {
    t.el.classList.add('current');
    const tr = t.el.getBoundingClientRect();
    const sr = thumbsEl.getBoundingClientRect();
    if (tr.top < sr.top || tr.bottom > sr.bottom) t.el.scrollIntoView({ block: 'nearest' });
  }
  if (document.activeElement !== $('#page-num')) $('#page-num').value = String(i + 1);
}

function scrollToPage(i, top = null) {
  const v = state.views[i];
  if (!v) return;
  viewerEl.scrollTop = v.el.offsetTop - 16 + (top ? top * state.scale : 0);
  setCurrent(i);
  scheduleRender();
}

// ---- Zoom --------------------------------------------------------------------

function setZoom(mode) {
  if (!state.pdf) return;
  const availW = viewerEl.clientWidth - 48;
  const availH = viewerEl.clientHeight - 40;
  let scale;
  if (mode === 'fit-width') {
    const maxW = Math.max(...state.pages.map((_, i) => baseViewport(i).width));
    scale = availW / maxW;
  } else if (mode === 'fit-page') {
    const vp = baseViewport(state.current);
    scale = Math.min(availW / vp.width, availH / vp.height);
  } else {
    scale = Number(mode);
  }
  applyScale(clamp(scale, 0.1, 6), mode.startsWith?.('fit') ? mode : null);
}

function applyScale(scale, zoomMode = null, debounceRender = 0) {
  // Keep the same point of the current page under the top of the viewport.
  const v = state.views[state.current];
  const frac = v?.el.offsetHeight ? (viewerEl.scrollTop - v.el.offsetTop) / v.el.offsetHeight : 0;
  state.scale = scale;
  state.zoomMode = zoomMode;
  layoutPages();
  if (v) viewerEl.scrollTop = v.el.offsetTop + frac * v.el.offsetHeight;
  scheduleRender(debounceRender);

  const preset = [...zoomSelect.options].find((o) => o.value === zoomMode || Number(o.value) === scale);
  const custom = zoomSelect.querySelector('[value="custom"]');
  if (preset) {
    zoomSelect.value = preset.value;
  } else {
    custom.textContent = `${Math.round(scale * 100)}%`;
    zoomSelect.value = 'custom';
  }
}

function zoomStep(dir) {
  const s = state.scale;
  const next = dir > 0 ? ZOOM_STEPS.find((z) => z > s + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < s - 0.001);
  if (next) applyScale(next);
}

// ---- Thumbnails ------------------------------------------------------------------

let dragFrom = null;
function buildThumbs() {
  thumbsEl.replaceChildren();
  const gen = ++state.thumbGen;
  state.thumbs = state.pages.map((_, i) => {
    const el = div('thumb');
    const frame = div('frame');
    const canvas = document.createElement('canvas');
    const vp = baseViewport(i);
    const s = Math.min(120 / vp.width, 160 / vp.height);
    canvas.style.width = `${vp.width * s}px`;
    canvas.style.height = `${vp.height * s}px`;
    frame.append(canvas);
    const label = div('label');
    label.textContent = String(i + 1);
    el.append(frame, label);
    el.addEventListener('click', () => scrollToPage(i));

    el.draggable = canEdit();
    el.addEventListener('dragstart', (e) => {
      dragFrom = i;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-agility-page', String(i));
      el.classList.add('dragging');
    });
    el.addEventListener('dragover', (e) => {
      if (dragFrom == null) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      el.classList.toggle('drop-after', after);
      el.classList.toggle('drop-before', !after);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const after = el.classList.contains('drop-after');
      el.classList.remove('drop-before', 'drop-after');
      if (dragFrom == null) return;
      let to = after ? i + 1 : i;
      if (to > dragFrom) to--;
      if (to !== dragFrom) movePage(dragFrom, to);
    });
    el.addEventListener('dragend', () => {
      dragFrom = null;
      el.classList.remove('dragging');
    });
    thumbsEl.append(el);
    return { el, canvas, scale: s };
  });
  setCurrent(Math.min(state.current, state.pages.length - 1));
  renderThumbs(gen);
}

// Thumbnails render as they scroll into the sidebar and are dropped again when
// they scroll far away.
let thumbObserver = null;
function renderThumbs(gen) {
  thumbObserver?.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const i = Number(entry.target.dataset.index);
      const t = state.thumbs[i];
      if (!t || gen !== state.thumbGen) continue;
      if (entry.isIntersecting) renderThumb(i, gen);
      else if (t.rendered && Math.abs(i - state.current) > 60) {
        t.task?.cancel();
        t.canvas.width = t.canvas.height = 0;
        t.rendered = false;
      }
    }
  }, { root: thumbsEl, rootMargin: '600px 0px' });
  state.thumbs.forEach((t, i) => {
    t.el.dataset.index = i;
    thumbObserver.observe(t.el);
  });
}

async function renderThumb(i, gen) {
  const t = state.thumbs[i];
  if (t.rendered) return;
  t.rendered = true;
  const ratio = window.devicePixelRatio || 1;
  const vp = state.pages[i].getViewport({ scale: t.scale * ratio });
  t.canvas.width = Math.floor(vp.width);
  t.canvas.height = Math.floor(vp.height);
  t.task = state.pages[i].render({ canvasContext: t.canvas.getContext('2d'), viewport: vp });
  try {
    await t.task.promise;
  } catch {
    if (gen === state.thumbGen) t.rendered = false; // cancelled or document replaced
  }
}

// ---- Undo / redo ----------------------------------------------------------------

function snapshot() {
  return {
    bytes: state.bytes,
    pageIds: [...state.pageIds],
    annotations: structuredClone(state.annotations),
    outline: structuredClone(state.outline || []),
    outlineEdited: state.outlineEdited,
  };
}

function pushUndo(snap = snapshot()) {
  state.undo.push(snap);
  if (state.undo.length > 100) state.undo.shift();
  state.redo = [];
  updateUI();
}

async function restore(snap) {
  select(null);
  const structural = snap.bytes !== state.bytes;
  state.pageIds = snap.pageIds;
  state.annotations = snap.annotations;
  if (snap.outline) {
    state.outline = snap.outline;
    state.outlineEdited = snap.outlineEdited;
    renderBookmarks();
  }
  if (structural) await reloadBytes(snap.bytes);
  else state.views.forEach((_, i) => renderAnnotations(i));
}

function undo() {
  return enqueue(async () => {
    if (!state.undo.length) return;
    const snap = state.undo.pop();
    state.redo.push(snapshot());
    await restore(snap);
    markDirty();
  });
}

function redo() {
  return enqueue(async () => {
    if (!state.redo.length) return;
    const snap = state.redo.pop();
    state.undo.push(snapshot());
    await restore(snap);
    markDirty();
  });
}

// ---- Page operations ---------------------------------------------------------------

function mutateDocument(fn) {
  return enqueue(async () => {
    if (!canEdit()) return;
    document.activeElement?.blur();
    const before = snapshot();
    try {
      const doc = await PDFDocument.load(state.bytes, { updateMetadata: false });
      await fn(doc);
      const bytes = await doc.save();
      pushUndo(before);
      await reloadBytes(bytes);
      markDirty();
    } catch (err) {
      if (state.undo[state.undo.length - 1] === before) state.undo.pop();
      state.pageIds = before.pageIds;
      state.annotations = before.annotations;
      throw err;
    }
  });
}

// Map a point on the page when it turns 90° clockwise (dir 1) or counterclockwise (dir -1).
function rotatePoint([x, y], W, H, dir) {
  return dir > 0 ? [H - y, x] : [y, W - x];
}

function rotateAnnotation(a, W, H, dir) {
  const rp = (p) => rotatePoint(p, W, H, dir);
  if (a.type === 'markup') {
    a.rects = a.rects.map((r) => {
      const [x1, y1] = rp([r.x, r.y]);
      const [x2, y2] = rp([r.x + r.w, r.y + r.h]);
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    });
    a.vertical = !a.vertical;
  } else if (a.type === 'pen') {
    a.points = a.points.map(rp);
  } else if (a.type === 'line' || a.type === 'arrow') {
    [a.x1, a.y1] = rp([a.x1, a.y1]);
    [a.x2, a.y2] = rp([a.x2, a.y2]);
  } else if (a.type === 'text' || a.type === 'image') {
    // Text and images stay upright; only their position follows the page.
    const [cx, cy] = rp([a.x + (a.w || 0) / 2, a.y + (a.h || 0) / 2]);
    a.x = cx - (a.w || 0) / 2;
    a.y = cy - (a.h || 0) / 2;
  } else {
    const [x1, y1] = rp([a.x, a.y]);
    const [x2, y2] = rp([a.x + a.w, a.y + a.h]);
    Object.assign(a, { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) });
  }
}

function rotatePage(i, dir) {
  if (!state.pages[i]) return;
  const { width: W, height: H } = baseViewport(i);
  return mutateDocument((doc) => {
    const page = doc.getPage(i);
    const angle = (((page.getRotation().angle + 90 * dir) % 360) + 360) % 360;
    page.setRotation(degrees(angle));
    for (const a of annotsOf(i)) rotateAnnotation(a, W, H, dir);
  });
}

function deletePage(i) {
  if (state.pages.length <= 1) return toast("A document needs at least one page.", { error: true });
  return mutateDocument((doc) => {
    doc.removePage(i);
    const [id] = state.pageIds.splice(i, 1);
    delete state.annotations[id];
  });
}

function insertBlankPage(i) {
  return mutateDocument((doc) => {
    const { width, height } = doc.getPage(i).getSize();
    doc.insertPage(i + 1, [width, height]);
    state.pageIds.splice(i + 1, 0, uid());
  }).then(() => scrollToPage(i + 1));
}

function movePage(from, to) {
  return mutateDocument((doc) => {
    const page = doc.getPage(from);
    doc.removePage(from);
    doc.insertPage(to, page);
    const [id] = state.pageIds.splice(from, 1);
    state.pageIds.splice(to, 0, id);
  }).then(() => scrollToPage(to));
}

async function mergePdf() {
  if (!canEdit()) return;
  const file = await api.openPdfDialog();
  if (!file) return;
  const firstNew = state.pages.length;
  await mutateDocument(async (doc) => {
    let src;
    try {
      src = await PDFDocument.load(file.data, { updateMetadata: false });
    } catch (err) {
      throw new Error(`Couldn't combine “${file.name}”: ${err.message}`);
    }
    const pages = await doc.copyPages(src, src.getPageIndices());
    for (const p of pages) {
      doc.addPage(p);
      state.pageIds.push(uid());
    }
  });
  if (state.pages.length > firstNew) {
    scrollToPage(firstNew);
    toast(`Added pages from ${file.name}`);
  }
}

async function extractPage(i) {
  if (!state.pdf) return;
  await enqueue(async () => {
    const full = await PDFDocument.load(await buildOutput(), { updateMetadata: false });
    const out = await PDFDocument.create();
    const [page] = await out.copyPages(full, [i]);
    out.addPage(page);
    const base = (state.fileName || 'Document').replace(/\.pdf$/i, '');
    const res = await api.saveAs(await out.save(), `${base} - page ${i + 1}.pdf`);
    if (res) toast(`Saved ${res.name}`);
  });
}

// ---- Annotations: model & rendering ----------------------------------------------

function annotsOf(i) {
  const id = state.pageIds[i];
  return (state.annotations[id] ||= []);
}

const findAnnot = (i, id) => annotsOf(i).find((a) => a.id === id);
const headLength = (a) => Math.max(8, a.width * 4);

// Bounding box in page units, padded so strokes aren't clipped.
function bounds(a) {
  if (a.type === 'line' || a.type === 'arrow' || a.type === 'pen') {
    const pts = a.type === 'pen' ? a.points : [[a.x1, a.y1], [a.x2, a.y2]];
    const pad = a.width / 2 + (a.type === 'arrow' ? headLength(a) * 0.5 : 0) + 2;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x = Math.min(...xs) - pad;
    const y = Math.min(...ys) - pad;
    return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
  }
  if (a.type === 'markup') return unionBox(a.rects);
  if (a.type === 'rect' || a.type === 'ellipse') {
    const pad = a.width / 2 + 1;
    return { x: a.x - pad, y: a.y - pad, w: a.w + pad * 2, h: a.h + pad * 2 };
  }
  return { x: a.x, y: a.y, w: a.w || 0, h: a.h || 0 };
}

function arrowHead(a) {
  const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
  const L = headLength(a);
  const spread = Math.PI / 7;
  return [ang - spread, ang + spread].map((t) => [a.x2 - L * Math.cos(t), a.y2 - L * Math.sin(t)]);
}

function shapeSvg(a, b) {
  const svg = svgEl('svg', { viewBox: `${b.x} ${b.y} ${b.w} ${b.h}`, preserveAspectRatio: 'none' });
  const stroke = {
    fill: 'none', stroke: a.color, 'stroke-width': a.width,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  };
  if (a.type === 'rect') svg.append(svgEl('rect', { x: a.x, y: a.y, width: a.w, height: a.h, ...stroke }));
  if (a.type === 'ellipse') {
    svg.append(svgEl('ellipse', { cx: a.x + a.w / 2, cy: a.y + a.h / 2, rx: a.w / 2, ry: a.h / 2, ...stroke }));
  }
  if (a.type === 'line') svg.append(svgEl('line', { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, ...stroke }));
  if (a.type === 'arrow') {
    const [h1, h2] = arrowHead(a);
    const d = `M${a.x1} ${a.y1}L${a.x2} ${a.y2}M${h1[0]} ${h1[1]}L${a.x2} ${a.y2}L${h2[0]} ${h2[1]}`;
    svg.append(svgEl('path', { d, ...stroke }));
  }
  if (a.type === 'pen') {
    const pts = a.points.length === 1 ? [a.points[0], a.points[0]] : a.points;
    svg.append(svgEl('polyline', { points: pts.map((p) => p.join(',')).join(' '), ...stroke }));
  }
  return svg;
}

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function annotElement(a) {
  if (a.type === 'ocrtext') return null; // invisible OCR layer: searchable, never drawn
  const s = state.scale;
  const el = div(`annot ${a.type}`);
  el.dataset.id = a.id;
  if (state.selected?.id === a.id) el.classList.add('selected');
  const b = bounds(a);
  Object.assign(el.style, {
    left: `${b.x * s}px`, top: `${b.y * s}px`, width: `${b.w * s}px`, height: `${b.h * s}px`,
  });
  switch (a.type) {
    case 'text': {
      const content = div('content');
      content.textContent = a.text;
      content.style.fontSize = `${a.size * s}px`;
      content.style.padding = `${TEXT_PAD_Y}em ${TEXT_PAD_X}em`;
      content.style.color = a.color;
      if (a.highlight) content.style.background = hexToRgba(a.highlight, 0.4);
      Object.assign(content.style, textCss(a));
      if (a.lh) content.style.lineHeight = String(a.lh);
      if (a.wrap) Object.assign(content.style, { width: `${a.wrap * s}px`, whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
      el.style.width = el.style.height = '';
      el.append(content);
      break;
    }
    case 'image': {
      const img = Object.assign(document.createElement('img'), { src: a.src, draggable: false });
      el.append(img);
      break;
    }
    case 'highlight':
      el.style.background = hexToRgba(a.color, 0.4);
      break;
    case 'note': {
      // A fixed on-screen size, like other viewers' comment icons.
      el.style.width = el.style.height = '22px';
      const icon = div('icon');
      icon.style.background = a.color || '#ffd400';
      icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 8h12M6 12h12M6 16h7"/></svg>';
      el.append(icon);
      el.title = a.text || 'Comment';
      break;
    }
    case 'markup':
      for (const r of a.rects) {
        const part = div(`mark ${a.kind}`);
        Object.assign(part.style, {
          left: `${(r.x - b.x) * s}px`, top: `${(r.y - b.y) * s}px`, width: `${r.w * s}px`, height: `${r.h * s}px`,
        });
        if (a.kind === 'highlight') part.style.background = hexToRgba(a.color, 0.4);
        else part.style.setProperty('--mark-color', a.color);
        el.append(part);
      }
      break;
    case 'whiteout':
      el.style.background = a.color || '#fff';
      break;
    case 'redact':
      el.title = 'Marked for redaction — use Tools ▸ Apply Redactions to remove';
      break;
    case 'mark': {
      const svg = svgEl('svg', { viewBox: '0 0 16 16', preserveAspectRatio: 'none' });
      if (a.kind === 'dot') svg.append(svgEl('circle', { cx: 8, cy: 8, r: 4, fill: a.color, stroke: 'none' }));
      else svg.append(svgEl('path', { d: MARK_PATHS[a.kind], fill: 'none', stroke: a.color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      el.append(svg);
      break;
    }
    case 'field':
    case 'crop':
      break; // previews while drawing a new form field or crop box
    case 'link':
      el.title = a.url ? `Link to ${a.url} (⌘/Ctrl-click to open)` : a.pageId ? `Link to page ${state.pageIds.indexOf(a.pageId) + 1} (⌘/Ctrl-click to follow)` : 'Link';
      break;
    default:
      el.append(shapeSvg(a, b));
  }
  if (BOX_TYPES.has(a.type) || a.type === 'text') el.append(div('handle'));
  if (a.type === 'markup' && a.note) el.title = a.note;
  return el;
}

// Text boxes size to their content; record that size in page units.
function measureText(el, a) {
  a.w = el.offsetWidth / state.scale;
  a.h = el.offsetHeight / state.scale;
}

// Highlights sit beneath other markup, like a highlighter pen under ink, so they
// never block clicks on the text or shapes drawn on top of them.
const paintOrder = (list) => [...list.filter((a) => a.type === 'highlight'), ...list.filter((a) => a.type !== 'highlight')];

function renderAnnotations(i) {
  const v = state.views[i];
  if (!v) return;
  const list = annotsOf(i);
  v.annots.replaceChildren(...paintOrder(list).map(annotElement).filter(Boolean));
  list.forEach((a) => {
    if (a.type === 'text') measureText(v.annots.querySelector(`[data-id="${a.id}"]`), a);
  });
}

function updateAnnotElement(i, a) {
  const old = state.views[i].annots.querySelector(`[data-id="${a.id}"]`);
  const el = annotElement(a);
  if (old) old.replaceWith(el);
  else state.views[i].annots.append(el);
  if (a.type === 'text') measureText(el, a);
  return el;
}

function select(sel) {
  state.selected = sel;
  markActiveComment();
  for (const el of document.querySelectorAll('.annot.selected')) el.classList.remove('selected');
  if (!sel) return;
  state.views[sel.page]?.annots.querySelector(`[data-id="${sel.id}"]`)?.classList.add('selected');
  const a = findAnnot(sel.page, sel.id);
  if (a?.color) colorInput.value = a.color;
  if (a?.width) widthInput.value = String(a.width);
  if (a?.size) {
    // Edited PDF text keeps its exact size, which may not be one of the presets.
    const v = String(a.size);
    let opt = [...fontInput.options].find((o) => o.value === v);
    if (!opt) {
      opt = fontInput.querySelector('[data-custom]') || fontInput.appendChild(Object.assign(new Option(), { hidden: true }));
      opt.dataset.custom = '';
      opt.value = opt.textContent = v;
    }
    fontInput.value = v;
  }
  if (a?.type === 'text') syncTextStyleControls(a);
}

function syncTextStyleControls(style) {
  familyInput.value = style.font || 'sans';
  boldButton.classList.toggle('on', !!style.bold);
  italicButton.classList.toggle('on', !!style.italic);
}

function selectedAnnot() {
  return state.selected && findAnnot(state.selected.page, state.selected.id);
}

function deleteSelected() {
  const a = selectedAnnot();
  if (!a || !canEdit()) return;
  pushUndo();
  const list = annotsOf(state.selected.page);
  list.splice(list.indexOf(a), 1);
  const page = state.selected.page;
  select(null);
  renderAnnotations(page);
  markDirty();
}

function updateSelectedProp(apply) {
  const a = selectedAnnot();
  if (!a || !canEdit()) return;
  const before = snapshot();
  if (apply(a) === false) return;
  pushUndo(before);
  updateAnnotElement(state.selected.page, a).classList.add('selected');
  markDirty();
}

// ---- Annotations: interaction ----------------------------------------------------

function pagePoint(e, i) {
  const r = state.views[i].annots.getBoundingClientRect();
  return { x: (e.clientX - r.left) / state.scale, y: (e.clientY - r.top) / state.scale };
}

const colorKey = (tool) => (['text', 'highlight', 'underline', 'strike'].includes(tool) ? tool : 'shape');

// With a text box selected, Highlight marks that text (or clears it) and keeps
// the selection, instead of switching to the area-highlight tool.
function toggleTextHighlight() {
  const a = selectedAnnot();
  if (a?.type !== 'text') return false;
  pushUndo();
  if (a.highlight) delete a.highlight;
  else a.highlight = state.colors.highlight;
  updateAnnotElement(state.selected.page, a).classList.add('selected');
  markDirty();
  toast(a.highlight ? 'Highlighted' : 'Highlight removed', { ms: 1200 });
  return true;
}

function setTool(tool) {
  if (tool !== 'select' && !canEdit()) return;
  if (isEditable(document.activeElement)) document.activeElement.blur();
  if (tool === 'highlight' && toggleTextHighlight()) return;
  state.tool = tool;
  if (tool !== 'image' && tool !== 'signature') state.pendingImage = null;
  if (tool !== 'stamp') state.pendingStamp = null;
  viewerEl.dataset.tool = tool;
  for (const b of document.querySelectorAll('.tool')) b.classList.toggle('active', b.dataset.tool === tool);
  if (tool !== 'select') {
    select(null);
    colorInput.value = state.colors[colorKey(tool)];
  }
  if (tool === 'text') syncTextStyleControls(state.textStyle);
  if (tool === 'image') chooseImage();
  if (tool === 'signature') openSignaturePad();
  if (tool === 'edittext' && !state.editHintShown) {
    state.editHintShown = true;
    toast('Click any line of text to edit it. Run OCR first to edit scanned pages.', { ms: 4000 });
  }
  refreshEditLines();
}

// Begin text editing only once the click has finished. Focusing on pointerdown
// doesn't stick: the browser moves focus again when the button is released.
// Listening on window also catches a release outside the element that was pressed.
//
// Opening an editor can take a moment (editing PDF text reloads the page), so the
// second and third clicks of a double or triple click may land before it exists.
// Those clicks only raise the count, which decides what the editor selects when
// it opens, instead of starting another edit.
// (Only click events carry the count; pointerdown's detail is always 0.)
let pendingEdit = null;
window.addEventListener('click', (e) => {
  if (pendingEdit) pendingEdit.clicks = Math.max(pendingEdit.clicks, e.detail || 1);
}, true);
function afterClick(e, fn) {
  e.preventDefault();
  if (pendingEdit) return;
  const edit = (pendingEdit = { at: { x: e.clientX, y: e.clientY }, clicks: 1 });
  window.addEventListener('pointerup', () => setTimeout(async () => {
    try {
      await fn(edit.at);
    } finally {
      if (pendingEdit === edit) pendingEdit = null;
    }
  }), { once: true });
}

// Place the caret for a click count: 1 = at the point, 2 = the word, 3+ = everything.
function selectForClicks(content, at, clicks) {
  const range = document.createRange();
  const pos = clicks < 3 && at ? document.caretPositionFromPoint?.(at.x, at.y) : null;
  if (clicks >= 3) {
    range.selectNodeContents(content);
  } else if (pos && content.contains(pos.offsetNode)) {
    let start = pos.offset;
    let end = pos.offset;
    if (clicks === 2 && pos.offsetNode.nodeType === Node.TEXT_NODE) {
      const text = pos.offsetNode.textContent;
      const isWord = (ch) => /[\p{L}\p{N}_'’-]/u.test(ch);
      while (start > 0 && isWord(text[start - 1])) start--;
      while (end < text.length && isWord(text[end])) end++;
    }
    range.setStart(pos.offsetNode, start);
    range.setEnd(pos.offsetNode, end);
  } else {
    range.selectNodeContents(content);
    range.collapse(false);
  }
  getSelection().removeAllRanges();
  getSelection().addRange(range);
}

function onPageDoubleClick(e, i) {
  const note = document.elementFromPoint(e.clientX, e.clientY)?.closest('.annot.note');
  if (note) return openComment(note.dataset.id);
  // The drag started on pointerdown captures the pointer, so the event targets the
  // layer itself; look up what is actually under the cursor.
  const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.annot.text');
  if (!el || state.tool !== 'select' || !canEdit()) return;
  const at = { x: e.clientX, y: e.clientY };
  setTimeout(() => editText(i, el.dataset.id, snapshot(), false, at, 2));
}

// Topmost flat markup (text markup or area highlight) under a page point.
function passiveAt(i, p) {
  return [...paintOrder(annotsOf(i))].reverse().find((a) => {
    if (!PASSIVE_TYPES.has(a.type)) return false;
    const boxes = a.type === 'markup' ? a.rects : [a];
    return boxes.some((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y - 2 && p.y <= r.y + r.h + 2);
  });
}

// Let a press start a native text selection; if it turns out to be a plain click
// (no drag, nothing selected), run onClick instead.
function textPress(e, onClick) {
  const x0 = e.clientX;
  const y0 = e.clientY;
  window.addEventListener('pointerup', (ev) => {
    const still = Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4;
    if (still && getSelection().isCollapsed) onClick?.();
  }, { once: true });
}

function onPagePointerDown(e, i) {
  if (e.button !== 0 || !state.pdf) return;
  if (e.target.closest('.forms > *, .edit-lines')) return;
  const annotEl = e.target.closest('.annot');
  const tool = state.tool;
  // A glyph span, not just the text layer (which covers the whole page).
  const onText = !!e.target.closest('.textLayer span');

  if (tool === 'select') {
    if (!annotEl) {
      // Flat markup: an already-selected area highlight can be dragged; otherwise
      // the press selects text, and a plain click selects the markup under it.
      // (Text markup follows its text, so it never moves.)
      const hit = passiveAt(i, pagePoint(e, i));
      if (hit?.type === 'highlight' && hit.id === state.selected?.id && canEdit()) return startDrag(e, i, hit, 'move');
      return textPress(e, () => select(hit ? { page: i, id: hit.id } : null));
    }
    if (annotEl.classList.contains('editing')) return;
    if (annotEl.classList.contains('link') && (e.metaKey || e.ctrlKey)) {
      const l = findAnnot(i, annotEl.dataset.id);
      return followLink({ url: l?.url, pageId: l?.pageId });
    }
    // Everything stacked under the pointer, topmost first. If the selected item is
    // among them it stays the one being dragged; clicking it again without dragging
    // selects the next one down, so covered markup can still be reached.
    const stack = document.elementsFromPoint(e.clientX, e.clientY)
      .filter((el) => el.classList.contains('annot') && state.views[i].annots.contains(el));
    const k = stack.findIndex((el) => el.dataset.id === state.selected?.id);
    const resizing = e.target.classList.contains('handle');
    const current = resizing || k < 0 ? annotEl : stack[k];
    const cycle = () => {
      if (!resizing && k >= 0 && stack.length > 1) select({ page: i, id: stack[(k + 1) % stack.length].dataset.id });
    };
    select({ page: i, id: current.dataset.id });
    if (canEdit()) startDrag(e, i, findAnnot(i, current.dataset.id), resizing ? 'resize' : 'move', cycle);
    else cycle();
    return;
  }
  if (!canEdit()) return;

  if (tool === 'text') {
    if (annotEl?.classList.contains('text')) {
      if (!annotEl.classList.contains('editing')) afterClick(e, (at) => editText(i, annotEl.dataset.id, snapshot(), false, at));
      return;
    }
    const before = snapshot();
    const p = pagePoint(e, i);
    const size = Number(fontInput.value);
    const a = {
      id: uid(), type: 'text', text: '', size, color: colorInput.value, ...state.textStyle,
      x: p.x - size * TEXT_PAD_X, y: p.y - size * 0.7,
    };
    annotsOf(i).push(a);
    updateAnnotElement(i, a);
    afterClick(e, () => editText(i, a.id, before, true));
    return;
  }

  if (tool === 'stamp' && state.pendingStamp) {
    const p = pagePoint(e, i);
    const st = state.pendingStamp;
    const size = Number(fontInput.value);
    pushUndo();
    let a;
    if (st.type === 'text') {
      a = { id: uid(), type: 'text', text: st.text, size, color: colorInput.value, ...state.textStyle, x: p.x - size * TEXT_PAD_X, y: p.y - size * 0.7 };
    } else {
      const d = Math.max(10, size * 1.1);
      a = { id: uid(), type: 'mark', kind: st.kind, color: colorInput.value, x: p.x - d / 2, y: p.y - d / 2, w: d, h: d };
    }
    annotsOf(i).push(a);
    renderAnnotations(i);
    markDirty();
    e.preventDefault();
    // Marks are usually placed several at a time; a date only once.
    if (st.type === 'text') {
      state.pendingStamp = null;
      setTool('select');
      select({ page: i, id: a.id });
    }
    return;
  }

  if (tool === 'note') {
    const p = pagePoint(e, i);
    const a = { id: uid(), type: 'note', x: p.x - 4, y: p.y - 4, w: 20, h: 20, text: '', color: '#ffd400', author: state.userName, date: new Date().toISOString(), replies: [] };
    pushUndo();
    annotsOf(i).push(a);
    renderAnnotations(i);
    markDirty();
    afterClick(e, () => {
      setTool('select');
      select({ page: i, id: a.id });
      openComment(a.id);
    });
    return;
  }

  if (tool === 'edittext') {
    if (annotEl?.classList.contains('text') && !annotEl.classList.contains('editing')) {
      afterClick(e, (at) => editText(i, annotEl.dataset.id, snapshot(), false, at));
    }
    return;
  }

  if (tool === 'image' || tool === 'signature') {
    if (state.pendingImage) placeImage(i, pagePoint(e, i));
    else if (tool === 'image') chooseImage();
    else openSignaturePad();
    return;
  }

  if (MARKUP_TOOLS[tool]) {
    // Over text, the press selects text and the markup is applied on release;
    // elsewhere the highlighter falls back to drawing a box.
    if (onText) {
      window.addEventListener('pointerup', () => setTimeout(() => applyTextMarkup(MARKUP_TOOLS[tool])), { once: true });
      return;
    }
    if (tool !== 'highlight') return;
  }

  if (DRAW_TOOLS.has(tool)) startDraw(e, i, tool);
}

function translate(a, orig, dx, dy) {
  if (a.type === 'markup') a.rects = orig.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }));
  else if (a.type === 'pen') a.points = orig.points.map(([x, y]) => [x + dx, y + dy]);
  else if (a.type === 'line' || a.type === 'arrow') {
    Object.assign(a, { x1: orig.x1 + dx, y1: orig.y1 + dy, x2: orig.x2 + dx, y2: orig.y2 + dy });
  } else Object.assign(a, { x: orig.x + dx, y: orig.y + dy });
}

function resize(a, orig, dx, dy, free) {
  if (a.type === 'text' && a.wrap) {
    a.wrap = Math.max(a.size * 2, orig.wrap + dx); // reflow; size stays
  } else if (a.type === 'text') {
    a.size = Math.round(clamp((orig.size * (orig.w + dx)) / orig.w, 4, 400));
  } else if ((a.type === 'image' && !free) || a.type === 'mark') {
    a.w = Math.max(8, orig.w + dx);
    a.h = a.w * (orig.h / orig.w);
  } else if (BOX_TYPES.has(a.type)) {
    a.w = Math.max(4, orig.w + dx);
    a.h = Math.max(4, orig.h + dy);
  }
}

function trackPointer(e, layer, onMove, onUp) {
  layer.setPointerCapture(e.pointerId);
  const move = (ev) => onMove(ev);
  const up = (ev) => {
    layer.removeEventListener('pointermove', move);
    layer.removeEventListener('pointerup', up);
    layer.removeEventListener('pointercancel', up);
    onUp(ev);
  };
  layer.addEventListener('pointermove', move);
  layer.addEventListener('pointerup', up);
  layer.addEventListener('pointercancel', up);
}

function startDrag(e, i, a, mode, onClick = null) {
  if (!a) return;
  e.preventDefault();
  const start = pagePoint(e, i);
  const before = snapshot();
  const orig = structuredClone(a);
  let moved = false;
  trackPointer(e, state.views[i].el, (ev) => {
    const p = pagePoint(ev, i);
    const dx = p.x - start.x;
    const dy = p.y - start.y;
    if (!moved && Math.hypot(dx, dy) * state.scale < 3) return;
    moved = true;
    if (mode === 'move') translate(a, orig, dx, dy);
    else resize(a, orig, dx, dy, ev.shiftKey);
    updateAnnotElement(i, a).classList.add('selected');
  }, () => {
    if (!moved) return onClick?.();
    pushUndo(before);
    markDirty();
  });
}

function startDraw(e, i, tool) {
  e.preventDefault();
  const { width: W, height: H } = baseViewport(i);
  const p0 = pagePoint(e, i);
  const color = tool === 'whiteout' ? '#ffffff' : tool === 'redact' ? '#e5484d' : colorInput.value;
  const width = Number(widthInput.value);
  const a = { id: uid(), type: tool, color, width };
  if (tool === 'pen') a.points = [[p0.x, p0.y]];
  else if (tool === 'line' || tool === 'arrow') Object.assign(a, { x1: p0.x, y1: p0.y, x2: p0.x, y2: p0.y });
  else Object.assign(a, { x: p0.x, y: p0.y, w: 0, h: 0 });

  const layer = state.views[i].annots;
  let el = null;
  trackPointer(e, state.views[i].el, (ev) => {
    const p = pagePoint(ev, i);
    p.x = clamp(p.x, 0, W);
    p.y = clamp(p.y, 0, H);
    if (tool === 'pen') {
      const last = a.points[a.points.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) < 0.75) return;
      a.points.push([p.x, p.y]);
    } else if (tool === 'line' || tool === 'arrow') {
      let { x, y } = p;
      if (ev.shiftKey) {
        // Snap to 45° increments.
        const ang = Math.round(Math.atan2(y - p0.y, x - p0.x) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(x - p0.x, y - p0.y);
        x = p0.x + len * Math.cos(ang);
        y = p0.y + len * Math.sin(ang);
      }
      Object.assign(a, { x2: x, y2: y });
    } else {
      let w = p.x - p0.x;
      let h = p.y - p0.y;
      if (ev.shiftKey) {
        const m = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * m;
        h = Math.sign(h || 1) * m;
      }
      Object.assign(a, { x: Math.min(p0.x, p0.x + w), y: Math.min(p0.y, p0.y + h), w: Math.abs(w), h: Math.abs(h) });
    }
    const next = annotElement(a);
    if (el) el.replaceWith(next);
    else layer.append(next);
    el = next;
  }, () => {
    const b = bounds(a);
    const tooSmall =
      tool === 'pen' ? false
        : tool === 'line' || tool === 'arrow' ? Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 3
          : a.w < 3 || a.h < 3;
    if (tooSmall || !b.w) {
      el?.remove();
      return;
    }
    if (tool === 'field' || tool === 'crop' || tool === 'link') {
      el?.remove();
      return tool === 'field' ? createFormField(i, a) : tool === 'crop' ? cropTo(i, a) : createLink(i, a);
    }
    pushUndo();
    annotsOf(i).push(a);
    renderAnnotations(i);
    markDirty();
  });
}

function editText(i, id, before, isNew = false, at = null, clicks = pendingEdit?.clicks || 1) {
  const a = findAnnot(i, id);
  if (!a) return;
  select({ page: i, id });
  const el = state.views[i].annots.querySelector(`[data-id="${id}"]`);
  if (!el) return;
  const content = el.querySelector('.content');
  if (el.classList.contains('editing')) return selectForClicks(content, at, clicks);
  const original = a.text;
  el.classList.add('editing');
  viewerEl.classList.add('text-editing');
  content.contentEditable = 'plaintext-only';
  content.focus();
  selectForClicks(content, at, clicks);
  // Once open, a triple-click selects the whole box (the browser would stop at a line).
  const onClick = (ev) => {
    if (ev.detail >= 3) selectForClicks(content, null, 3);
  };
  content.addEventListener('click', onClick);

  const onInput = () => measureText(el, a);
  const onKey = (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey))) content.blur();
  };
  content.addEventListener('input', onInput);
  content.addEventListener('keydown', onKey);
  content.addEventListener('blur', () => {
    content.removeEventListener('click', onClick);
    content.removeEventListener('input', onInput);
    content.removeEventListener('keydown', onKey);
    viewerEl.classList.remove('text-editing');
    a.text = content.innerText.replace(/\n$/, '');
    const list = annotsOf(i);
    if (!a.text.trim()) {
      list.splice(list.indexOf(a), 1);
      if (!isNew) {
        pushUndo(before);
        markDirty();
      }
      select(null);
    } else if (isNew || a.text !== original) {
      pushUndo(before);
      markDirty();
    }
    renderAnnotations(i);
    if (state.selected) select(state.selected);
  }, { once: true });
}

// ---- Text selection and markup -----------------------------------------------------

// The current text selection as line boxes per page (page units at scale 1).
function selectionByPage() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return [];
  const range = sel.getRangeAt(0);
  const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer;
  const pages = new Map();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = root.nodeType === Node.TEXT_NODE ? root : walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node) || !node.parentElement?.closest('.textLayer')) continue;
    const pageEl = node.parentElement.closest('.page');
    const i = state.views.findIndex((v) => v.el === pageEl);
    if (i < 0) continue;
    const part = document.createRange();
    part.selectNodeContents(node);
    if (node === range.startContainer) part.setStart(node, range.startOffset);
    if (node === range.endContainer) part.setEnd(node, range.endOffset);
    const pr = pageEl.getBoundingClientRect();
    for (const r of part.getClientRects()) {
      if (r.width < 0.5 || r.height < 0.5) continue;
      if (!pages.has(i)) pages.set(i, []);
      pages.get(i).push({ x: (r.left - pr.left) / state.scale, y: (r.top - pr.top) / state.scale, w: r.width / state.scale, h: r.height / state.scale });
    }
  }
  return [...pages].map(([page, rects]) => ({ page, rects: mergeLineRects(rects) }));
}

// Join the per-span boxes of each line into one box per line.
function mergeLineRects(rects) {
  const lines = [];
  for (const r of [...rects].sort((p, q) => p.y - q.y || p.x - q.x)) {
    const line = lines.find((l) => {
      const overlap = Math.min(l.y + l.h, r.y + r.h) - Math.max(l.y, r.y);
      return overlap > Math.min(l.h, r.h) * 0.5 && r.x <= l.x + l.w + Math.max(l.h, r.h) * 1.2 && r.x + r.w >= l.x - Math.max(l.h, r.h) * 1.2;
    });
    if (line) Object.assign(line, unionBox([line, r]));
    else lines.push({ ...r });
  }
  return lines;
}

function applyTextMarkup(kind) {
  if (!canEdit()) return false;
  const parts = selectionByPage();
  if (!parts.length) return false;
  const text = getSelection().toString().trim();
  pushUndo();
  let last = null;
  for (const { page, rects } of parts) {
    last = { page, id: uid() };
    annotsOf(page).push({ id: last.id, type: 'markup', kind, color: state.colors[kind], rects, text, author: state.userName, date: new Date().toISOString() });
    renderAnnotations(page);
  }
  getSelection().removeAllRanges();
  hideSelectionPopup();
  markDirty();
  if (state.tool === 'select') select(last);
  return true;
}

const selPopup = $('#sel-popup');
function hideSelectionPopup() {
  selPopup.hidden = true;
}

function showSelectionPopup() {
  const sel = getSelection();
  if (!state.pdf || sel.isCollapsed || !sel.rangeCount || state.tool !== 'select') return hideSelectionPopup();
  const node = sel.focusNode?.parentElement;
  if (!node?.closest('.textLayer')) return hideSelectionPopup();
  const rects = sel.getRangeAt(0).getClientRects();
  const r = rects[rects.length - 1];
  if (!r) return hideSelectionPopup();
  selPopup.querySelectorAll('[data-needs-edit]').forEach((b) => (b.hidden = !canEdit()));
  selPopup.hidden = false;
  const w = selPopup.offsetWidth;
  selPopup.style.left = `${clamp(r.right - w / 2, 8, window.innerWidth - w - 8)}px`;
  selPopup.style.top = `${clamp(r.bottom + 8, 8, window.innerHeight - 48)}px`;
}

document.addEventListener('pointerup', () => setTimeout(showSelectionPopup), true);
document.addEventListener('selectionchange', () => {
  if (getSelection().isCollapsed) hideSelectionPopup();
});
viewerEl.addEventListener('scroll', hideSelectionPopup, { passive: true });
selPopup.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the selection
selPopup.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.markup) applyTextMarkup(b.dataset.markup);
  if (b.dataset.sel === 'comment' && applyTextMarkup('highlight')) openComment(state.selected?.id);
  if (b.dataset.sel === 'redact') markSelectionForRedaction();
  if (b.dataset.sel === 'copy') {
    navigator.clipboard.writeText(getSelection().toString());
    hideSelectionPopup();
    toast('Copied', { ms: 1000 });
  }
});

// ---- Images & signatures ------------------------------------------------------------

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That image format is not supported.'));
    img.src = src;
  });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function chooseImage() {
  const input = $('#image-input');
  input.value = '';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      let src = await readAsDataUrl(file);
      const img = await loadImage(src);
      // pdf-lib embeds PNG and JPEG; normalise everything else to PNG.
      if (!/^data:image\/(png|jpeg)/.test(src)) {
        const c = Object.assign(document.createElement('canvas'), { width: img.naturalWidth, height: img.naturalHeight });
        c.getContext('2d').drawImage(img, 0, 0);
        src = c.toDataURL('image/png');
      }
      state.pendingImage = { src, w: img.naturalWidth, h: img.naturalHeight, maxW: 220 };
      toast('Click on a page to place the image');
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  input.click();
}

function placeImage(i, p) {
  const img = state.pendingImage;
  const { width: W, height: H } = baseViewport(i);
  const s = Math.min(1, img.maxW / img.w, (W * 0.9) / img.w, (H * 0.9) / img.h);
  const w = img.w * s;
  const h = img.h * s;
  const a = {
    id: uid(), type: 'image', src: img.src,
    x: clamp(p.x - w / 2, 0, W - w), y: clamp(p.y - h / 2, 0, H - h), w, h,
  };
  pushUndo();
  annotsOf(i).push(a);
  state.pendingImage = null;
  setTool('select');
  renderAnnotations(i);
  select({ page: i, id: a.id });
  markDirty();
}

let signatureFonts = null;
function loadSignatureFonts() {
  signatureFonts ||= Promise.all(SIGNATURE_FONTS.map(async (f) => {
    const url = new URL(`../node_modules/@fontsource/${f.pkg}/files/${f.pkg}-latin-400-normal.woff2`, import.meta.url);
    const face = new FontFace(f.family, `url(${url.href})`);
    document.fonts.add(await face.load());
  })).catch((err) => {
    signatureFonts = null;
    throw err;
  });
  return signatureFonts;
}

function renderTypedSignature(text, family, color) {
  const size = 110;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${size}px "${family}"`;
  canvas.width = Math.ceil(ctx.measureText(text).width + size);
  canvas.height = Math.ceil(size * 1.9);
  ctx.font = `${size}px "${family}"`; // resizing the canvas resets its state
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, canvas.height / 2);
  return trimCanvas(canvas);
}

function openSignaturePad() {
  modal((box, close) => {
    box.innerHTML = `<h2>Signature</h2>
      <div class="sig-saved" hidden></div>
      <div class="tabs" role="tablist">
        <button class="tab active" data-tab="draw">Draw</button>
        <button class="tab" data-tab="type">Type</button>
      </div>
      <div class="pane" data-pane="draw">
        <p>Draw your signature below with a mouse, trackpad or stylus.</p>
        <canvas class="sig-pad"></canvas>
      </div>
      <div class="pane" data-pane="type" hidden>
        <input type="text" class="sig-name" placeholder="Type your name" maxlength="60" spellcheck="false" />
        <div class="sig-fonts"></div>
      </div>
      <div class="sig-row">Ink:
        <label><input type="radio" name="ink" value="#111111" checked /> Black</label>
        <label><input type="radio" name="ink" value="#1d3fbb" /> Blue</label>
      </div>
      <div class="actions"></div>`;
    const ink = () => box.querySelector('input[name="ink"]:checked').value;
    let tab = 'draw';
    for (const t of box.querySelectorAll('.tab')) {
      t.addEventListener('click', () => {
        tab = t.dataset.tab;
        box.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
        box.querySelectorAll('.pane').forEach((p) => (p.hidden = p.dataset.pane !== tab));
        if (tab === 'type') nameInput.focus();
      });
    }

    // Draw tab
    const canvas = box.querySelector('canvas');
    const W = 560;
    const H = 200;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.lineWidth = 2.6;
    let drawing = false;
    let empty = true;
    let last = null;
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    canvas.addEventListener('pointerdown', (e) => {
      drawing = true;
      empty = false;
      last = pos(e);
      canvas.setPointerCapture(e.pointerId);
      ctx.strokeStyle = ctx.fillStyle = ink();
      ctx.beginPath();
      ctx.arc(last[0], last[1], ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const p = pos(e);
      ctx.beginPath();
      ctx.moveTo(...last);
      ctx.lineTo(...p);
      ctx.stroke();
      last = p;
    });
    canvas.addEventListener('pointerup', () => (drawing = false));

    // Type tab: the name previewed in each signature font.
    const nameInput = box.querySelector('.sig-name');
    const fontsEl = box.querySelector('.sig-fonts');
    let family = SIGNATURE_FONTS[0].family;
    const options = SIGNATURE_FONTS.map((f) => {
      const b = Object.assign(document.createElement('button'), { className: 'sig-font' });
      b.style.fontFamily = `"${f.family}", cursive`;
      b.classList.toggle('active', f.family === family);
      b.addEventListener('click', () => {
        family = f.family;
        options.forEach((o) => o.classList.toggle('active', o === b));
      });
      fontsEl.append(b);
      return b;
    });
    const preview = () => {
      options.forEach((o) => {
        o.textContent = nameInput.value || 'Your Name';
        o.style.color = ink();
      });
    };
    nameInput.addEventListener('input', preview);
    nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
    box.querySelectorAll('input[name="ink"]').forEach((r) => r.addEventListener('change', preview));
    preview();
    loadSignatureFonts().then(preview, () => toast('Signature fonts failed to load.', { error: true }));

    const use = (sig, remember = false) => {
      state.pendingImage = sig;
      if (remember) api.saveSignature({ ...sig, id: uid(), saved: new Date().toISOString() });
      close(true);
      toast('Click on a page to place your signature');
    };
    const submit = async () => {
      const remember = box.querySelector('.sig-remember input').checked;
      if (tab === 'draw') {
        if (empty) return toast('Draw a signature first');
        return use(trimCanvas(canvas), remember);
      }
      const name = nameInput.value.trim();
      if (!name) return toast('Type your name first');
      await loadSignatureFonts().catch(() => {});
      use(renderTypedSignature(name, family, ink()), remember);
    };

    // Signatures saved on this computer, ready to reuse.
    const savedEl = box.querySelector('.sig-saved');
    const showSaved = (list) => {
      savedEl.replaceChildren();
      savedEl.hidden = !list.length;
      for (const sig of list) {
        const item = div('sig-item');
        const img = Object.assign(document.createElement('img'), { src: sig.src, alt: 'Saved signature', title: 'Use this signature' });
        img.addEventListener('click', () => use(sig));
        const del = Object.assign(document.createElement('button'), { className: 'del', textContent: '×', title: 'Forget this signature' });
        del.addEventListener('click', async () => showSaved(await api.deleteSignature(sig.id)));
        item.append(img, del);
        savedEl.append(item);
      }
    };
    api.signatures().then(showSaved);

    const actions = box.querySelector('.actions');
    actions.append(Object.assign(document.createElement('label'), { className: 'sig-remember', innerHTML: '<input type="checkbox" checked /> Remember on this computer' }));
    actions.append(
      button('Clear', 'secondary', () => {
        ctx.clearRect(0, 0, W, H);
        empty = true;
        nameInput.value = '';
        preview();
      }),
      button('Cancel', 'secondary', () => close(false)),
      button('Use signature', 'primary', submit)
    );
  }).then((ok) => {
    if (!ok) setTool('select');
  });
}

// Crop transparent margins so the placed signature hugs the ink.
function trimCanvas(canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const pad = 6;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  const w = Math.min(width, x1 + pad) - x0;
  const h = Math.min(height, y1 + pad) - y0;
  const out = Object.assign(document.createElement('canvas'), { width: w, height: h });
  out.getContext('2d').drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
  return { src: out.toDataURL('image/png'), w, h, maxW: 170 };
}

// ---- Editing existing PDF text ------------------------------------------------------

const unionBox = (boxes) => {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
};

// Lines of real PDF text on a page, merged from pdf.js text items, in user space
// (origin, direction, length) plus a display-space box at scale 1.
async function pageLines(i) {
  const page = state.pages[i];
  state.lineCache ||= new WeakMap();
  if (state.lineCache.has(page)) return state.lineCache.get(page);
  const tc = await page.getTextContent();
  const vp = page.getViewport({ scale: 1 });
  const lines = [];
  let cur = null;
  for (const it of tc.items) {
    if (!it.str || !it.width) {
      if (it.hasEOL) cur = null;
      continue;
    }
    const t = it.transform;
    const size = Math.hypot(t[2], t[3]);
    const dlen = Math.hypot(t[0], t[1]) || 1;
    const dx = t[0] / dlen;
    const dy = t[1] / dlen;
    if (cur && dx * cur.dx + dy * cur.dy > 0.99 && Math.abs(size - cur.size) < cur.size * 0.2) {
      const along = (t[4] - cur.x) * cur.dx + (t[5] - cur.y) * cur.dy;
      const perp = (t[4] - cur.x) * -cur.dy + (t[5] - cur.y) * cur.dx;
      const gap = along - cur.length;
      if (Math.abs(perp) < size * 0.3 && gap > -size * 0.5 && gap < size * 1.5) {
        if (gap > size * 0.12 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += ' ';
        cur.text += it.str;
        cur.length = Math.max(cur.length, along + it.width);
        if (it.hasEOL) cur = null;
        continue;
      }
    }
    const style = tc.styles[it.fontName] || {};
    cur = {
      source: 'pdf', x: t[4], y: t[5], dx, dy, size, length: it.width, text: it.str,
      fontName: it.fontName, family: style.fontFamily || '',
      ascent: style.ascent || 0.8, descent: style.descent || -0.2,
    };
    lines.push(cur);
    if (it.hasEOL) cur = null;
  }
  const result = [];
  for (const l of lines) {
    if (!l.text.trim()) continue;
    const [sx, sy] = vp.convertToViewportPoint(l.x, l.y);
    const [ex, ey] = vp.convertToViewportPoint(l.x + l.dx * l.length, l.y + l.dy * l.length);
    if (Math.abs(ey - sy) > 0.5 || ex <= sx) continue; // only text that reads left-to-right on screen
    l.baseline = { x: sx, y: sy };
    l.box = { x: sx, y: sy - l.ascent * l.size, w: ex - sx, h: (l.ascent - l.descent) * l.size };
    result.push(l);
  }
  result.paragraphs = groupParagraphs(result);
  state.lineCache.set(page, result);
  return result;
}

// Consecutive lines that read as one paragraph: same size, aligned left edges
// (a first-line indent is fine) and an even line spacing.
function groupParagraphs(lines) {
  const sorted = [...lines].sort((p, q) => p.baseline.y - q.baseline.y || p.baseline.x - q.baseline.x);
  const paras = [];
  let cur = null;
  for (const l of sorted) {
    const prev = cur?.lines[cur.lines.length - 1];
    const gap = prev ? l.baseline.y - prev.baseline.y : 0;
    const joins = prev
      && Math.abs(l.size - prev.size) < prev.size * 0.15
      && gap > prev.size * 0.9 && gap < prev.size * 1.65
      && (cur.lines.length < 2 || Math.abs(gap - cur.gap) < prev.size * 0.25)
      && (Math.abs(l.baseline.x - cur.left) < prev.size * 0.8 || (cur.lines.length === 1 && l.baseline.x < cur.left && cur.left - l.baseline.x < prev.size * 4));
    if (joins) {
      if (cur.lines.length === 1) {
        cur.gap = gap;
        cur.left = Math.min(cur.left, l.baseline.x);
      } else cur.gap = (cur.gap * (cur.lines.length - 1) + gap) / cur.lines.length;
      cur.lines.push(l);
    } else {
      cur = { lines: [l], left: l.baseline.x, gap: 0 };
      paras.push(cur);
    }
  }
  for (const p of paras) {
    p.box = unionBox(p.lines.map((l) => l.box));
    p.width = Math.max(...p.lines.map((l) => l.box.x + l.box.w)) - p.left;
    p.lines.forEach((l) => (l.para = p));
  }
  return paras;
}

// OCR words on a page grouped back into lines, with character offsets for search.
function ocrLines(i) {
  const groups = new Map();
  for (const a of annotsOf(i)) {
    if (a.type !== 'ocrtext') continue;
    if (!groups.has(a.line)) groups.set(a.line, []);
    groups.get(a.line).push(a);
  }
  return [...groups.values()].map((words) => {
    words.sort((p, q) => p.x - q.x);
    let text = '';
    const spans = words.map((w) => {
      if (text) text += ' ';
      const start = text.length;
      text += w.text;
      return { x: w.x, y: w.y, w: w.w, h: w.h, start, end: text.length };
    });
    const box = unionBox(words);
    const base = Math.max(...words.map((w) => w.y + w.h * (w.base ?? 0.8)));
    return { source: 'ocr', text, words: spans, ids: words.map((w) => w.id), box, baseline: { x: box.x, y: base }, size: (base - box.y) / 0.72 };
  });
}

async function renderEditLines(i) {
  const v = state.views[i];
  if (!v) return;
  if (!v.editLayer) {
    v.editLayer = div('edit-lines');
    v.el.append(v.editLayer);
  }
  if (state.tool !== 'edittext' || !canEdit()) return v.editLayer.replaceChildren();
  const pdfLines = await pageLines(i);
  // Paragraphs edit as one block; Alt-click picks a single line. OCR text edits by line.
  const targets = [...pdfLines.paragraphs.map((p) => (p.lines.length > 1 ? { block: p, box: p.box } : p.lines[0])), ...ocrLines(i)];
  if (state.views[i] !== v || state.tool !== 'edittext') return;
  const s = state.scale;
  v.editLayer.replaceChildren(...targets.map((target) => {
    const el = div(target.block ? 'textline para' : 'textline');
    Object.assign(el.style, {
      left: `${(target.box.x - 1) * s}px`, top: `${(target.box.y - 1) * s}px`,
      width: `${(target.box.w + 2) * s}px`, height: `${(target.box.h + 2) * s}px`,
    });
    el.title = target.source === 'ocr' ? 'Recognized text — click to edit'
      : target.block ? 'Click to edit the paragraph (Alt-click for one line)' : 'Click to edit';
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      if (target.block && !e.altKey) return afterClick(e, (at) => beginParagraphEdit(i, target.block, at));
      let line = target;
      if (target.block) {
        const y = pagePoint(e, i).y;
        line = target.block.lines.find((l) => y >= l.box.y - 1 && y <= l.box.y + l.box.h + 1) || target.block.lines[0];
      }
      afterClick(e, (at) => beginTextEdit(i, line, at));
    });
    return el;
  }));
}

// Pick the background and ink colours under a box from the rendered page.
function sampleColors(i, box) {
  const fallback = { ink: '#000000', bg: '#ffffff' };
  const c = state.views[i]?.canvas;
  if (!c?.width) return fallback;
  const r = c.width / baseViewport(i).width;
  const x = clamp(Math.floor(box.x * r), 0, c.width - 1);
  const y = clamp(Math.floor(box.y * r), 0, c.height - 1);
  const w = Math.min(c.width - x, Math.ceil(box.w * r));
  const h = Math.min(c.height - y, Math.ceil(box.h * r));
  if (w <= 0 || h <= 0) return fallback;
  const d = c.getContext('2d').getImageData(x, y, w, h).data;
  const counts = new Map();
  for (let k = 0; k < d.length; k += 4) {
    const key = ((d[k] >> 4) << 8) | ((d[k + 1] >> 4) << 4) | (d[k + 2] >> 4);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const bgKey = [...counts].sort((p, q) => q[1] - p[1])[0][0];
  const bg = [((bgKey >> 8) & 15) * 17, ((bgKey >> 4) & 15) * 17, (bgKey & 15) * 17];
  let best = 0;
  let ink = [0, 0, 0];
  for (let k = 0; k < d.length; k += 4) {
    const dist = Math.abs(d[k] - bg[0]) + Math.abs(d[k + 1] - bg[1]) + Math.abs(d[k + 2] - bg[2]);
    if (dist > best) {
      best = dist;
      ink = [d[k], d[k + 1], d[k + 2]];
    }
  }
  const hex = (c3) => `#${c3.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  return { ink: best > 60 ? hex(ink) : '#000000', bg: hex(bg) };
}

function detectFont(i, line) {
  let f = null;
  try {
    const objs = state.pages[i].commonObjs;
    if (objs.has(line.fontName)) f = objs.get(line.fontName);
  } catch {
    /* font not loaded yet */
  }
  const name = `${f?.name || ''} ${line.family}`;
  const mono = !!f?.isMonospace || /courier|mono|consol/i.test(name);
  const serif = !mono && (!!f?.isSerifFont || /times|georgia|garamond|roman|minion|cambria|palatino|\bserif/i.test(name.replace(/sans-serif/gi, '')));
  return {
    font: mono ? 'mono' : serif ? 'serif' : 'sans',
    bold: !!(f?.bold || f?.black || /bold|black|heavy|semibold|demi/i.test(name)),
    italic: !!(f?.italic || /italic|oblique/i.test(name)),
  };
}

// Join a paragraph's lines into running text, undoing line-end hyphenation.
const joinLines = (lines) => lines.reduce((text, l) => {
  if (!text) return l.text;
  if (/[a-z]-$/i.test(text) && /^[a-z]/.test(l.text)) return text.slice(0, -1) + l.text;
  return `${text.replace(/\s+$/, '')} ${l.text.replace(/^\s+/, '')}`;
}, '');

function beginParagraphEdit(i, para, at = null) {
  return enqueue(async () => {
    if (!canEdit()) return;
    const first = para.lines[0];
    const colors = sampleColors(i, para.box);
    const style = detectFont(i, first);
    const size = Math.round(first.size * 10) / 10;
    const text = joinLines(para.lines);
    const doc = await PDFDocument.load(state.bytes, { updateMetadata: false });
    const lineTarget = (l) => ({ x: l.x, y: l.y, dx: l.dx, dy: l.dy, length: l.length, size: l.size });
    const { fontKey } = removeTextLine(doc, i, lineTarget(first), { dryRun: true });
    style.docFont = await captureFont(doc, i, fontKey, text, api.findFont);
    if (style.docFont) await fontReady(fontChoice({ ...style, text }));
    let removed = 0;
    for (const l of para.lines) removed += removeTextLine(doc, i, lineTarget(l)).removed;
    if (!removed) return enqueueLater(() => beginTextEdit(i, first, at));

    const id = uid();
    const a = {
      id, type: 'text', edit: true, text, size, color: colors.ink, ...style,
      wrap: para.width + size * TEXT_PAD_X * 2 + 1, lh: Math.round((para.gap / size) * 1000) / 1000,
    };
    Object.assign(a, { x: para.left - size * TEXT_PAD_X, y: first.baseline.y - size * (TEXT_PAD_Y + textBaseline(a)) });
    const before = snapshot();
    const bytes = await doc.save();
    pushUndo(before);
    annotsOf(i).push(a);
    await reloadBytes(bytes);
    markDirty();
    editText(i, id, snapshot(), false, at);
  });
}

// Queue work to run after the current queued task finishes.
const enqueueLater = (fn) => setTimeout(fn);

function beginTextEdit(i, line, at = null) {
  return enqueue(async () => {
    if (!canEdit()) return;
    const colors = sampleColors(i, line.box);
    const style = line.source === 'pdf' ? detectFont(i, line) : { font: 'sans', bold: false, italic: false };
    const size = Math.round(line.size * 10) / 10;
    const id = uid();
    if (line.source === 'pdf') {
      // Reuse the document's own font when it (or the same installed font) has the characters.
      const doc = await PDFDocument.load(state.bytes, { updateMetadata: false });
      const { fontKey } = removeTextLine(doc, i, { x: line.x, y: line.y, dx: line.dx, dy: line.dy, length: line.length, size: line.size }, { dryRun: true });
      style.docFont = await captureFont(doc, i, fontKey, line.text, api.findFont);
      if (style.docFont) await fontReady(fontChoice({ ...style, text: line.text }));
    }
    const textAt = (text, bx, by) => {
      const a = { id, type: 'text', edit: true, text, size, color: colors.ink, ...style };
      return Object.assign(a, { x: bx - size * TEXT_PAD_X, y: by - size * (TEXT_PAD_Y + textBaseline(a)) });
    };

    let replaced = false;
    if (line.source === 'pdf') {
      const target = { x: line.x, y: line.y, dx: line.dx, dy: line.dy, length: line.length, size: line.size };
      const probe = removeTextLine(await PDFDocument.load(state.bytes, { updateMetadata: false }), i, target, { dryRun: true });
      if (probe.removed && !probe.invisible) {
        // Whole operators get removed, so widen to them and take along any neighbouring text they cover.
        const from = Math.min(0, probe.from);
        const to = Math.max(line.length, probe.to);
        const covered = (await pageLines(i)).filter((l) => {
          if (l.dx * line.dx + l.dy * line.dy < 0.99) return false;
          const along = (l.x - line.x) * line.dx + (l.y - line.y) * line.dy;
          const perp = (l.x - line.x) * -line.dy + (l.y - line.y) * line.dx;
          return Math.abs(perp) < line.size * 0.45 && along + l.length > from + 0.5 && along < to - 0.5;
        }).sort((p, q) => p.baseline.x - q.baseline.x);
        const start = covered[0] || line;
        const text = covered.map((l) => l.text).join(' ') || line.text;
        const wide = { ...target, x: line.x + line.dx * from, y: line.y + line.dy * from, length: to - from };
        // mutateDocument runs inside the queue we're already in, so call its body directly.
        const before = snapshot();
        const doc = await PDFDocument.load(state.bytes, { updateMetadata: false });
        removeTextLine(doc, i, wide);
        const bytes = await doc.save();
        pushUndo(before);
        annotsOf(i).push(textAt(text, start.baseline.x, start.baseline.y));
        await reloadBytes(bytes);
        markDirty();
        replaced = true;
      }
    }
    if (!replaced) {
      // Scanned pages (OCR) or text we can't reach in the content stream: cover it and retype.
      pushUndo();
      if (line.source === 'ocr') {
        const ids = new Set(line.ids);
        state.annotations[state.pageIds[i]] = annotsOf(i).filter((a) => !ids.has(a.id));
      }
      const b = line.box;
      const list = annotsOf(i);
      list.push({ id: uid(), type: 'whiteout', color: colors.bg, x: b.x - 1, y: b.y - 1, w: b.w + 2, h: b.h + 2 });
      list.push(textAt(line.text, line.baseline.x, line.baseline.y));
      renderAnnotations(i);
      renderEditLines(i);
      if (line.source === 'ocr') refreshTextLayers();
      markDirty();
    }
    editText(i, id, snapshot(), false, at);
  });
}

// ---- OCR --------------------------------------------------------------------------------

let ocrProgress = null;
api.onOcrProgress((m) => {
  if (ocrProgress && m.status === 'recognizing text') ocrProgress(m.progress);
});

function ocrOptionsModal() {
  return modal((box, close) => {
    box.innerHTML = `<h2>Recognize text (OCR)</h2>
      <p>Finds text in scanned pages and images so you can search, copy and edit it. Recognition runs on this computer.</p>
      <label class="opt"><input type="radio" name="scope" value="current" checked /> Current page</label>
      <label class="opt"><input type="radio" name="scope" value="all" /> All pages</label>
      <label class="opt"><input type="checkbox" name="skip" checked /> Skip pages that already contain text</label>
      <div class="actions"></div>`;
    box.querySelector('.actions').append(
      button('Cancel', 'secondary', () => close(null)),
      button('Recognize', 'primary', () => close({
        all: box.querySelector('input[name="scope"]:checked').value === 'all',
        skip: box.querySelector('input[name="skip"]').checked,
      }))
    );
  });
}

async function runOcr() {
  if (!canEdit()) return;
  const opts = await ocrOptionsModal();
  if (!opts) return;
  const pages = opts.all ? state.pages.map((_, i) => i) : [state.current];
  let cancelled = false;
  let setStatus;
  const progressDone = modal((box, close) => {
    box.innerHTML = `<h2>Recognizing text…</h2><p class="ocr-status">Starting…</p>
      <div class="progress"><div></div></div><div class="actions"></div>`;
    const bar = box.querySelector('.progress > div');
    const status = box.querySelector('.ocr-status');
    setStatus = (text, frac) => {
      if (text) status.textContent = text;
      bar.style.width = `${Math.round(clamp(frac, 0, 1) * 100)}%`;
    };
    setStatus.close = close;
    box.querySelector('.actions').append(button('Cancel', 'secondary', () => {
      cancelled = true;
      status.textContent = 'Cancelling…';
    }));
  });
  progressDone.then(() => (cancelled = true));

  await enqueue(async () => {
    const before = snapshot();
    let words = 0;
    let done = 0;
    let skipped = 0;
    try {
      for (const [n, i] of pages.entries()) {
        if (cancelled) break;
        const label = `Page ${i + 1}${pages.length > 1 ? ` (${n + 1} of ${pages.length})` : ''}`;
        setStatus(`${label}: preparing…`, n / pages.length);
        if (opts.skip && (await pageLines(i)).length > 3) {
          skipped++;
          continue;
        }
        const page = state.pages[i];
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(3, 4200 / Math.max(base.width, base.height));
        const vp = page.getViewport({ scale });
        const canvas = Object.assign(document.createElement('canvas'), { width: Math.floor(vp.width), height: Math.floor(vp.height) });
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const png = new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, 'image/png'))).arrayBuffer());
        setStatus(`${label}: recognizing…`, n / pages.length);
        ocrProgress = (p) => setStatus(null, (n + p) / pages.length);
        const lines = await api.ocr(png);
        ocrProgress = null;
        if (cancelled) break;

        const list = annotsOf(i).filter((a) => a.type !== 'ocrtext');
        for (const line of lines) {
          const lineId = uid();
          const bl = line.baseline;
          for (const w of line.words) {
            if (w.confidence < 20) continue;
            const { x0, y0, x1, y1 } = w.bbox;
            const cx = (x0 + x1) / 2;
            const baseY = bl && bl.x1 !== bl.x0 ? bl.y0 + ((bl.y1 - bl.y0) * (cx - bl.x0)) / (bl.x1 - bl.x0) : y1;
            list.push({
              id: uid(), type: 'ocrtext', line: lineId, text: w.text,
              x: x0 / scale, y: y0 / scale, w: (x1 - x0) / scale, h: (y1 - y0) / scale,
              base: clamp((baseY - y0) / Math.max(1, y1 - y0), 0.5, 1),
            });
            words++;
          }
        }
        state.annotations[state.pageIds[i]] = list;
        done++;
      }
    } finally {
      ocrProgress = null;
      setStatus?.close(true);
    }
    if (done) {
      pushUndo(before);
      markDirty();
      refreshEditLines();
      refreshTextLayers();
      if (state.find) runFind(findInput.value);
    }
    const skippedNote = skipped ? ` Skipped ${skipped} page${skipped > 1 ? 's' : ''} that already had text.` : '';
    if (done) toast(`Recognized ${words} words on ${done} page${done > 1 ? 's' : ''}. The text is now searchable and editable.${skippedNote}`, { ms: 6000 });
    else if (!cancelled) toast(`No pages needed recognition.${skippedNote}`, { ms: 5000 });
  });
}

// ---- Redaction --------------------------------------------------------------------------
// Marks are reviewable boxes; applying them permanently removes the text, images,
// markup and form fields underneath, then blacks the areas out.

function markSelectionForRedaction() {
  const parts = selectionByPage();
  if (!parts.length || !canEdit()) return;
  pushUndo();
  for (const { page, rects } of parts) {
    for (const r of rects) annotsOf(page).push({ id: uid(), type: 'redact', color: '#e5484d', x: r.x - 0.5, y: r.y - 0.5, w: r.w + 1, h: r.h + 1 });
    renderAnnotations(page);
  }
  getSelection().removeAllRanges();
  hideSelectionPopup();
  markDirty();
  toast('Marked for redaction. Use Apply Redactions to remove it permanently.', { ms: 4000 });
}

const boxesIntersect = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

async function applyRedactions() {
  if (!canEdit()) return;
  const pages = state.pageIds
    .map((id, i) => ({ i, marks: (state.annotations[id] || []).filter((a) => a.type === 'redact') }))
    .filter((p) => p.marks.length);
  const count = pages.reduce((n, p) => n + p.marks.length, 0);
  if (!count) return toast('Nothing is marked. Use Mark for Redaction, or select text and choose Redact.', { ms: 4500 });
  const ok = await confirmModal(
    'Apply redactions?',
    `This permanently removes the text, images, markup and form fields under ${count} marked area${count > 1 ? 's' : ''} on ${pages.length} page${pages.length > 1 ? 's' : ''}, and blacks them out. Once saved, the content can't be recovered.`,
    'Redact'
  );
  if (!ok) return;
  await enqueue(async () => {
    const before = snapshot();
    const doc = await PDFDocument.load(state.bytes, { updateMetadata: false });
    let rasterized = 0;
    for (const { i, marks } of pages) {
      const vp = state.pages[i].getViewport({ scale: 1 });
      const userRect = (m) => {
        const [x1, y1] = vp.convertToPdfPoint(m.x, m.y);
        const [x2, y2] = vp.convertToPdfPoint(m.x + m.w, m.y + m.h);
        return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
      };
      const rects = marks.map(userRect);
      const page = doc.getPage(i);
      const { complex } = redactText(doc, i, rects);
      if (complex) {
        // An image or embedded object is under a mark: replace the page with a
        // picture of itself with the areas burned in, plus its remaining text
        // as an invisible layer so it stays searchable.
        await rasterizePage(doc, i, rects, marks);
        rasterized++;
      } else {
        for (const r of rects) page.drawRectangle({ ...r, color: rgb(0, 0, 0) });
      }
      removeAnnotationsUnder(doc, page, rects);
      // Markup over the area could repeat what was removed.
      state.annotations[state.pageIds[i]] = annotsOf(i).filter((a) => a.type !== 'redact' && !marks.some((m) => boxesIntersect(bounds(a), m)));
    }
    collectGarbage(doc);
    const bytes = await doc.save();
    pushUndo(before);
    await reloadBytes(bytes);
    markDirty();
    toast(`Redacted ${count} area${count > 1 ? 's' : ''}${rasterized ? ` (${rasterized} page${rasterized > 1 ? 's were' : ' was'} converted to an image to remove pictures)` : ''}. Save to make it permanent.`, { ms: 6000 });
  });
}

// Remove links, comments and form fields whose area overlaps a redaction.
function removeAnnotationsUnder(doc, page, rects) {
  const annots = page.node.Annots();
  if (!annots) return;
  const keep = [];
  const form = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = form?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  for (const ref of annots.asArray()) {
    const dict = doc.context.lookupMaybe(ref, PDFDict);
    const r = dict?.lookupMaybe(PDFName.of('Rect'), PDFArray)?.asArray().map((n) => n.asNumber?.() ?? 0);
    const hit = r && rects.some((q) => Math.min(r[0], r[2]) < q.x + q.width && Math.max(r[0], r[2]) > q.x && Math.min(r[1], r[3]) < q.y + q.height && Math.max(r[1], r[3]) > q.y);
    if (!hit) {
      keep.push(ref);
      continue;
    }
    // A widget that is its own field also goes from the form, value and all.
    if (fields && dict.has(PDFName.of('FT'))) {
      const idx = fields.asArray().findIndex((f) => f.toString() === ref.toString());
      if (idx >= 0) fields.remove(idx);
    }
  }
  page.node.set(PDFName.of('Annots'), doc.context.obj(keep));
}

async function rasterizePage(doc, i, rects, marks) {
  const source = state.pages[i];
  const scale = 200 / 72;
  const vp = source.getViewport({ scale, rotation: 0 });
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.ceil(vp.width), height: Math.ceil(vp.height) });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await source.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.DISABLE }).promise;
  ctx.fillStyle = '#000';
  for (const r of rects) {
    const [x1, y1] = vp.convertToViewportPoint(r.x, r.y);
    const [x2, y2] = vp.convertToViewportPoint(r.x + r.width, r.y + r.height);
    ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  }
  const jpeg = new Uint8Array(await (await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9))).arrayBuffer());

  // Remaining text, minus anything under a mark, becomes invisible OCR-style words.
  const tc = await source.getTextContent();
  const dvp = source.getViewport({ scale: 1 });
  const words = [];
  for (const it of tc.items) {
    if (!it.str.trim() || !it.width) continue;
    const tx = pdfjsLib.Util.transform(dvp.transform, it.transform);
    if (Math.abs(tx[1]) > 0.01 || tx[0] <= 0) continue; // only text that reads left to right
    const h = Math.hypot(tx[2], tx[3]);
    const n = it.str.length;
    const cw = it.width / n;
    let start = null;
    const flush = (end) => {
      if (start === null) return;
      const text = it.str.slice(start, end).trim();
      if (text) words.push({ id: uid(), type: 'ocrtext', line: `r${i}-${tx[5].toFixed(1)}`, text, x: tx[4] + start * cw, y: tx[5] - h * 0.8, w: (end - start) * cw, h, base: 0.8 });
      start = null;
    };
    for (let k = 0; k < n; k++) {
      const box = { x: tx[4] + k * cw, y: tx[5] - h * 0.8, w: cw, h };
      const hidden = marks.some((m) => boxesIntersect(box, m));
      if (hidden || it.str[k] === ' ') flush(k);
      else if (start === null) start = k;
    }
    flush(n);
  }

  const page = doc.getPage(i);
  const crop = page.getCropBox();
  page.node.set(PDFName.of('Resources'), doc.context.obj({}));
  page.node.set(PDFName.of('Contents'), doc.context.obj([]));
  page.drawImage(await doc.embedJpg(jpeg), { x: crop.x, y: crop.y, width: crop.width, height: crop.height });
  annotsOf(i).push(...words);
}

// ---- Comments panel ---------------------------------------------------------------------

const commentsEl = $('#comments');
const commentList = $('#comment-list');
const COMMENT_LABEL = {
  note: 'Comment', highlight: 'Highlight', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line',
  arrow: 'Arrow', pen: 'Drawing', text: 'Text box',
  markup: { highlight: 'Highlight', underline: 'Underline', strike: 'Strikethrough' },
};

// Comments and text markup always appear; other markup once it has a note or replies.
const isCommentable = (a) => a.type === 'note' || a.type === 'markup'
  || (isAnnotationType(a) && !!(a.note || a.replies?.length));

function toggleComments(show = commentsEl.classList.contains('hidden')) {
  commentsEl.classList.toggle('hidden', !show);
  if (show) renderComments();
  if (state.zoomMode) setZoom(state.zoomMode);
}

let commentsTimer = 0;
function scheduleComments() {
  clearTimeout(commentsTimer);
  commentsTimer = setTimeout(renderComments, 50);
}

function markActiveComment() {
  for (const el of commentList.querySelectorAll('.comment')) el.classList.toggle('active', el.dataset.id === state.selected?.id);
}

// Show a comment (creating its card if needed) and put the cursor in its note.
function openComment(id) {
  if (!id) return;
  toggleComments(true);
  renderComments(true);
  const card = commentList.querySelector(`[data-id="${CSS.escape(id)}"]`);
  card?.scrollIntoView({ block: 'nearest' });
  card?.querySelector('textarea')?.focus();
}

const shortDate = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '');

function renderComments(force = false) {
  if (commentsEl.classList.contains('hidden')) return;
  // Don't rebuild under the user's cursor; the blur handler re-renders.
  if (!force && commentList.contains(document.activeElement)) return;
  const groups = state.pageIds.map((id, i) => ({ i, list: (state.annotations[id] || []).filter(isCommentable) }));
  const cards = [];
  for (const { i, list } of groups) {
    if (!list.length) continue;
    cards.push(Object.assign(div('comment-page'), { textContent: `Page ${i + 1}` }));
    for (const a of list) cards.push(commentCard(i, a));
  }
  if (!cards.length) {
    cards.push(Object.assign(div('comment-empty'), {
      textContent: 'No comments yet. Use the Comment tool (N), or select text and choose Comment.',
    }));
  }
  commentList.replaceChildren(...cards);
  markActiveComment();
}

function commentCard(i, a) {
  const card = div('comment');
  card.dataset.id = a.id;
  const label = a.type === 'markup' ? COMMENT_LABEL.markup[a.kind] : COMMENT_LABEL[a.type];
  card.innerHTML = `<div class="head"><span class="kind"></span><span class="who"></span><span class="when"></span>
    <button class="del" title="Delete">×</button></div>`;
  card.querySelector('.kind').style.background = a.color || '#ffd400';
  card.querySelector('.who').textContent = `${a.author || 'Unknown'} · ${label}`;
  card.querySelector('.when').textContent = shortDate(a.date);
  if (a.type === 'markup' && a.text) {
    card.append(Object.assign(document.createElement('p'), { className: 'quote', textContent: `“${a.text}”` }));
  }
  const field = a.type === 'note' ? 'text' : 'note';
  const note = Object.assign(document.createElement('textarea'), {
    value: a[field] || '', placeholder: a.type === 'note' ? 'Write a comment…' : 'Add a note…', rows: 2,
    disabled: !canEdit(),
  });
  let before = null;
  note.addEventListener('focus', () => (before = snapshot()));
  note.addEventListener('input', () => (a[field] = note.value));
  note.addEventListener('blur', () => {
    if (before && JSON.stringify(before.annotations) !== JSON.stringify(state.annotations)) {
      pushUndo(before);
      markDirty();
      renderAnnotations(i);
    }
    before = null;
    scheduleComments();
  });
  card.append(note);
  for (const r of a.replies || []) {
    const reply = div('reply');
    reply.innerHTML = '<span class="who"></span> <span class="when"></span><p></p>';
    reply.querySelector('.who').textContent = r.author || 'Unknown';
    reply.querySelector('.when').textContent = shortDate(r.date);
    reply.querySelector('p').textContent = r.text;
    card.append(reply);
  }
  if (canEdit()) {
    const input = Object.assign(document.createElement('input'), { className: 'reply-input', placeholder: 'Reply…' });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !input.value.trim()) return;
      pushUndo();
      (a.replies ||= []).push({ id: uid(), author: state.userName, date: new Date().toISOString(), text: input.value.trim() });
      input.value = '';
      markDirty();
      renderComments(true);
      commentList.querySelector(`[data-id="${CSS.escape(a.id)}"] .reply-input`)?.focus();
    });
    card.append(input);
  }
  card.querySelector('.del').hidden = !canEdit();
  card.querySelector('.del').addEventListener('click', (e) => {
    e.stopPropagation();
    select({ page: i, id: a.id });
    deleteSelected();
  });
  card.addEventListener('click', (e) => {
    if (e.target.closest('textarea, input, button')) return;
    select({ page: i, id: a.id });
    const el = state.views[i]?.annots.querySelector(`[data-id="${CSS.escape(a.id)}"]`);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else scrollToPage(i);
  });
  return card;
}

// ---- Fill & Sign -------------------------------------------------------------------------

const fillMenu = $('#fill-menu');
function startFill(kind) {
  fillMenu.hidden = true;
  if (!canEdit()) return;
  if (kind === 'signature') return setTool('signature');
  if (kind === 'form-edit') return toggleFormEdit();
  if (kind === 'detect-fields') return detectFormFields();
  if (kind === 'tab-order') return chooseTabOrder();
  if (kind.startsWith('field-')) {
    state.fieldKind = kind.slice(6);
    setTool('field');
    return toast('Drag on the page to place the field', { ms: 2500 });
  }
  setTool('stamp');
  state.pendingStamp = kind === 'date'
    ? { type: 'text', text: new Date().toLocaleDateString() }
    : { type: 'mark', kind };
  toast(kind === 'date' ? 'Click where the date goes' : 'Click to place; press Esc when done', { ms: 2500 });
}

$('#fill-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  fillMenu.hidden = !fillMenu.hidden;
  const r = e.currentTarget.getBoundingClientRect();
  Object.assign(fillMenu.style, { left: `${r.left}px`, top: `${r.bottom + 4}px` });
});
fillMenu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-fill]');
  if (b) startFill(b.dataset.fill);
});
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#fill-menu, #fill-btn')) fillMenu.hidden = true;
});

// ---- Form authoring ---------------------------------------------------------------------

function toggleFormEdit(on = !state.formEdit) {
  state.formEdit = on && canEdit();
  document.body.classList.toggle('form-edit', state.formEdit);
  for (const v of state.views) v.formsScale = 0;
  scheduleRender();
  if (state.formEdit) toast('Editing form fields: click a field for its properties. Use Fill & Sign ▸ Edit form fields again when done.', { ms: 5000 });
}

async function editFieldProperties(name) {
  const doc = await PDFDocument.load(state.bytes, { updateMetadata: false });
  let info;
  try {
    info = fieldInfo(doc, name);
  } catch {
    return toast(`Can't edit “${name}”.`, { error: true });
  }
  const isText = info.kind === 'Text';
  const isChoice = info.kind === 'Dropdown' || info.kind === 'OptionList';
  const next = await modal((m, close) => {
    m.innerHTML = `<h2>Field properties</h2><p class="hint-line">${info.kind.replace(/([a-z])([A-Z])/g, '$1 $2')} field</p><div class="form">
      <label class="field-row">Name <input type="text" class="f-name" /></label>
      <label class="field-row">Tooltip <input type="text" class="f-tip" placeholder="Read aloud by screen readers" /></label>
      ${isText ? `<label class="field-row">Value <input type="text" class="f-val" /></label>
        <label class="field-row">Max length <input type="number" class="f-max" min="0" style="width:80px" /></label>
        <label class="field-row">Font size <input type="number" class="f-size" min="0" max="72" placeholder="auto" style="width:80px" /></label>
        <label class="field-row">Align <select class="f-align"><option value="0">Left</option><option value="1">Center</option><option value="2">Right</option></select></label>
        <label class="opt"><input type="checkbox" class="f-multi" /> Multiple lines</label>` : ''}
      ${isChoice ? '<label class="field-row">Choices <input type="text" class="f-opts" placeholder="One, Two, Three" /></label>' : ''}
      ${info.kind === 'CheckBox' ? '<label class="opt"><input type="checkbox" class="f-checked" /> Checked</label>' : ''}
      <label class="opt"><input type="checkbox" class="f-req" /> Required</label>
      <label class="opt"><input type="checkbox" class="f-ro" /> Read-only</label>
    </div><div class="actions"></div>`;
    const q = (c) => m.querySelector(c);
    q('.f-name').value = info.name;
    q('.f-tip').value = info.tooltip;
    q('.f-req').checked = info.required;
    q('.f-ro').checked = info.readOnly;
    if (isText) {
      q('.f-val').value = info.value;
      q('.f-max').value = info.maxLength;
      q('.f-align').value = String(info.alignment ?? 0);
      q('.f-multi').checked = info.multiline;
    }
    if (isChoice) q('.f-opts').value = info.options.join(', ');
    if (info.kind === 'CheckBox') q('.f-checked').checked = info.value;
    const del = button('Delete field', 'secondary danger-text', () => close({ delete: true }));
    del.style.marginRight = 'auto';
    m.querySelector('.actions').append(del, button('Cancel', 'secondary', () => close(null)), button('Save', 'primary', () => close({
      kind: info.kind,
      name: q('.f-name').value.trim() || info.name,
      tooltip: q('.f-tip').value.trim(),
      required: q('.f-req').checked,
      readOnly: q('.f-ro').checked,
      ...(isText ? { value: q('.f-val').value, maxLength: q('.f-max').value, fontSize: q('.f-size').value, alignment: q('.f-align').value, multiline: q('.f-multi').checked } : {}),
      ...(isChoice ? { options: q('.f-opts').value.split(',').map((o) => o.trim()).filter(Boolean) } : {}),
      ...(info.kind === 'CheckBox' ? { value: q('.f-checked').checked } : {}),
    })));
  });
  if (!next) return;
  delete state.formValues[name]; // the field's own value now comes from the dialog
  await mutateDocument((d) => applyFieldInfo(d, name, next));
  toast(next.delete ? `Deleted “${name}”` : 'Field updated');
}

async function detectFormFields() {
  if (!canEdit()) return;
  const scope = await modal((m, close) => {
    m.innerHTML = `<h2>Detect form fields</h2><p>Finds fill-in lines, boxes and checkbox squares on flat forms and makes them fillable. Each field is named after the label next to it.</p>
      <label class="opt"><input type="radio" name="scope" value="current" checked /> Current page</label>
      <label class="opt"><input type="radio" name="scope" value="all" /> All pages</label><div class="actions"></div>`;
    m.querySelector('.actions').append(button('Cancel', 'secondary', () => close(null)), button('Detect', 'primary', () => close(m.querySelector('input[name="scope"]:checked').value)));
  });
  if (!scope) return;
  const pages = scope === 'all' ? state.pages.map((_, i) => i) : [state.current];
  const doc = await PDFDocument.load(state.bytes, { updateMetadata: false });
  const found = new Map();
  for (const i of pages) {
    const lines = await pageLines(i);
    const widgets = (await state.pages[i].getAnnotations()).filter((a) => a.subtype === 'Widget')
      .map((w) => ({ x: Math.min(w.rect[0], w.rect[2]), y: Math.min(w.rect[1], w.rect[3]), w: Math.abs(w.rect[2] - w.rect[0]), h: Math.abs(w.rect[3] - w.rect[1]) }));
    const fields = detectFields(doc, i, lines, widgets);
    if (fields.length) found.set(i, fields);
  }
  const all = [...found.values()].flat();
  if (!all.length) return toast('No fill-in areas found.', { ms: 3000 });
  const texts = all.filter((f) => f.kind === 'text').length;
  const ok = await confirmModal('Add detected fields?',
    `Found ${texts} text field${texts === 1 ? '' : 's'} and ${all.length - texts} checkbox${all.length - texts === 1 ? '' : 'es'}${all.some((f) => f.label) ? `, e.g. “${all.find((f) => f.label).label}”` : ''}. You can adjust them afterwards with Edit form fields.`, 'Add fields');
  if (!ok) return;
  await mutateDocument((d) => {
    for (const [i, fields] of found) addFields(d, i, fields);
  });
  toast(`Added ${all.length} field${all.length === 1 ? '' : 's'}`);
}

async function chooseTabOrder() {
  const mode = await modal((m, close) => {
    m.innerHTML = `<h2>Tab order</h2><p>Which order Tab moves through the form fields, on every page.</p>
      <label class="opt"><input type="radio" name="o" value="rows" checked /> By rows (left to right, top to bottom)</label>
      <label class="opt"><input type="radio" name="o" value="columns" /> By columns (top to bottom, left to right)</label>
      <label class="opt"><input type="radio" name="o" value="structure" /> Document structure (tagged PDFs)</label><div class="actions"></div>`;
    m.querySelector('.actions').append(button('Cancel', 'secondary', () => close(null)), button('Apply', 'primary', () => close(m.querySelector('input[name="o"]:checked').value)));
  });
  if (!mode) return;
  await mutateDocument((d) => d.getPages().forEach((_, i) => setTabOrder(d, i, mode)));
  toast('Tab order updated');
}

// Create a real, fillable form field in the drawn box.
async function createFormField(i, box) {
  const kind = state.fieldKind || 'text';
  const label = { text: 'Text field', checkbox: 'Checkbox', dropdown: 'Dropdown' }[kind];
  const answer = await modal((m, close) => {
    m.innerHTML = `<h2>New ${label.toLowerCase()}</h2>
      <label class="field-row">Name <input type="text" class="f-name" /></label>
      ${kind === 'dropdown' ? '<label class="field-row">Choices <input type="text" class="f-opts" placeholder="Red, Green, Blue" /></label>' : ''}
      <div class="actions"></div>`;
    const name = m.querySelector('.f-name');
    name.value = `${label.replace(' ', '')}${Date.now() % 1000}`;
    const submit = () => close({ name: name.value.trim(), options: (m.querySelector('.f-opts')?.value || '').split(',').map((o) => o.trim()).filter(Boolean) });
    m.querySelectorAll('input').forEach((inp) => inp.addEventListener('keydown', (e) => e.key === 'Enter' && submit()));
    m.querySelector('.actions').append(button('Cancel', 'secondary', () => close(null)), button('Add field', 'primary', submit));
    setTimeout(() => name.select());
  });
  if (!answer?.name) return;
  if (kind === 'dropdown' && !answer.options.length) return toast('Add at least one choice.', { error: true });
  const vp = state.pages[i].getViewport({ scale: 1 });
  const [x1, y1] = vp.convertToPdfPoint(box.x, box.y);
  const [x2, y2] = vp.convertToPdfPoint(box.x + box.w, box.y + box.h);
  const rect = { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
  await mutateDocument(async (doc) => {
    const form = doc.getForm();
    let name = answer.name;
    for (let n = 2; form.getFieldMaybe(name); n++) name = `${answer.name}${n}`;
    const page = doc.getPage(i);
    const look = { ...rect, borderColor: rgb(0.45, 0.45, 0.5), borderWidth: 1, backgroundColor: rgb(1, 1, 1) };
    if (kind === 'checkbox') form.createCheckBox(name).addToPage(page, look);
    else if (kind === 'dropdown') {
      const field = form.createDropdown(name);
      field.addOptions(answer.options);
      field.addToPage(page, look);
    } else form.createTextField(name).addToPage(page, look);
  });
  setTool('select');
  toast(`Added “${answer.name}”`);
}

// ---- Form fields ---------------------------------------------------------------------

async function renderForms(i) {
  const v = state.views[i];
  const page = state.pages[i];
  if (!v.widgets) {
    const annots = await page.getAnnotations({ intent: 'display' });
    v.widgets = annots.filter((a) => a.subtype === 'Widget' && a.fieldName && !a.hidden && !a.pushButton);
    v.links = annots.filter((a) => a.subtype === 'Link' && (a.url || a.unsafeUrl || a.dest));
  }
  renderLinks(i, v);
  if (state.views[i] !== v) return;
  const s = state.scale;
  v.formsScale = s;
  const vp = page.getViewport({ scale: s });
  const els = [];
  if (state.formEdit && canEdit()) {
    // Editing the form itself: each field is a labelled box that opens its properties.
    for (const w of v.widgets) {
      const [ax, ay] = vp.convertToViewportPoint(w.rect[0], w.rect[1]);
      const [bx, by] = vp.convertToViewportPoint(w.rect[2], w.rect[3]);
      const el = div('field-box');
      Object.assign(el.style, { left: `${Math.min(ax, bx)}px`, top: `${Math.min(ay, by)}px`, width: `${Math.abs(bx - ax)}px`, height: `${Math.abs(by - ay)}px` });
      el.dataset.field = w.fieldName;
      el.append(Object.assign(document.createElement('span'), { textContent: w.fieldName }));
      el.title = `${w.fieldName} — click for properties`;
      el.addEventListener('click', () => editFieldProperties(w.fieldName));
      els.push(el);
    }
    v.forms.replaceChildren(...els);
    return;
  }
  for (const w of v.widgets) {
    const [ax, ay] = vp.convertToViewportPoint(w.rect[0], w.rect[1]);
    const [bx, by] = vp.convertToViewportPoint(w.rect[2], w.rect[3]);
    const box = { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
    const key = w.fieldName;
    const stored = state.formValues[key];
    let el;
    if (w.fieldType === 'Tx') {
      el = document.createElement(w.multiLine ? 'textarea' : 'input');
      if (!w.multiLine) el.type = 'text';
      el.value = stored ?? w.fieldValue ?? '';
      if (w.maxLen) el.maxLength = w.maxLen;
      const fs = w.defaultAppearanceData?.fontSize || Math.min(12, (box.height / s) * 0.65);
      el.style.fontSize = `${fs * s}px`;
      el.addEventListener('input', () => setFormValue(key, el.value, el));
    } else if (w.fieldType === 'Btn' && w.checkBox) {
      el = Object.assign(document.createElement('input'), { type: 'checkbox' });
      el.checked = stored ?? (!!w.fieldValue && w.fieldValue !== 'Off');
      el.addEventListener('change', () => setFormValue(key, el.checked, el));
    } else if (w.fieldType === 'Btn' && w.radioButton) {
      el = Object.assign(document.createElement('input'), { type: 'radio', name: `field:${key}` });
      el.checked = (stored ?? w.fieldValue) === w.buttonValue;
      el.addEventListener('change', () => el.checked && setFormValue(key, w.buttonValue, el));
    } else if (w.fieldType === 'Ch') {
      el = document.createElement('select');
      for (const o of w.options || []) {
        el.append(new Option(o.displayValue ?? o.exportValue, o.exportValue));
      }
      const cur = stored ?? (Array.isArray(w.fieldValue) ? w.fieldValue[0] : w.fieldValue);
      if (cur != null) el.value = cur;
      el.style.fontSize = `${Math.min(12, (box.height / s) * 0.65) * s}px`;
      el.addEventListener('change', () => setFormValue(key, el.value, el));
    } else {
      continue;
    }
    el.dataset.field = key;
    el.disabled = !!w.readOnly || state.readOnly;
    el.title = w.alternativeText || key;
    for (const [k, val] of Object.entries(box)) el.style[k] = `${val}px`;
    els.push(el);
  }
  v.forms.replaceChildren(...els);
}

// The document's own links: clickable with the Select tool.
function renderLinks(i, v) {
  if (!v.linksLayer) {
    v.linksLayer = div('links');
    v.el.append(v.linksLayer);
  }
  const vp = state.pages[i].getViewport({ scale: state.scale });
  v.linksLayer.replaceChildren(...(v.links || []).map((l) => {
    const [ax, ay] = vp.convertToViewportPoint(l.rect[0], l.rect[1]);
    const [bx, by] = vp.convertToViewportPoint(l.rect[2], l.rect[3]);
    const a = document.createElement('a');
    Object.assign(a.style, { left: `${Math.min(ax, bx)}px`, top: `${Math.min(ay, by)}px`, width: `${Math.abs(bx - ax)}px`, height: `${Math.abs(by - ay)}px` });
    a.title = l.url || l.unsafeUrl || 'Go to page';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      followLink({ url: l.url || l.unsafeUrl, dest: l.dest });
    });
    return a;
  }));
}

async function followLink({ url, dest, pageId, top }) {
  if (url) {
    if (/^(https?|mailto):/i.test(url)) window.open(url, '_blank');
    return;
  }
  if (pageId) {
    const i = state.pageIds.indexOf(pageId);
    if (i >= 0) scrollToPage(i, top);
    return;
  }
  try {
    const d = typeof dest === 'string' ? await state.pdf.getDestination(dest) : dest;
    const i = typeof d[0] === 'number' ? d[0] : await state.pdf.getPageIndex(d[0]);
    const y = d[1]?.name === 'XYZ' && typeof d[3] === 'number' ? state.pages[i].getViewport({ scale: 1 }).convertToViewportPoint(0, d[3])[1] : null;
    scrollToPage(i, y);
  } catch {
    toast("That link's destination couldn't be found.", { error: true });
  }
}

async function createLink(i, box) {
  const count = state.pages.length;
  const target = await modal((m, close) => {
    m.innerHTML = `<h2>Add link</h2>
      <label class="opt"><input type="radio" name="kind" value="url" checked /> Web address <input type="text" class="u" placeholder="https://example.com" style="flex:1" /></label>
      <label class="opt"><input type="radio" name="kind" value="page" /> Page <input type="number" class="pg" min="1" max="${count}" value="1" style="width:70px" /> of ${count}</label>
      <div class="actions"></div>`;
    const submit = () => {
      const kind = m.querySelector('input[name="kind"]:checked').value;
      if (kind === 'url') {
        let u = m.querySelector('.u').value.trim();
        if (!u) return toast('Enter a web address', { error: true });
        if (!/^[a-z]+:/i.test(u)) u = u.includes('@') && !u.includes('/') ? `mailto:${u}` : `https://${u}`;
        return close({ url: u });
      }
      const n = Number(m.querySelector('.pg').value);
      if (!(n >= 1 && n <= count)) return toast(`Enter a page from 1 to ${count}`, { error: true });
      close({ pageId: state.pageIds[n - 1] });
    };
    m.querySelector('.u').addEventListener('focus', () => (m.querySelector('input[value="url"]').checked = true));
    m.querySelector('.pg').addEventListener('focus', () => (m.querySelector('input[value="page"]').checked = true));
    m.querySelectorAll('input[type="text"], input[type="number"]').forEach((inp) => inp.addEventListener('keydown', (e) => e.key === 'Enter' && submit()));
    m.querySelector('.actions').append(button('Cancel', 'secondary', () => close(null)), button('Add link', 'primary', submit));
    setTimeout(() => m.querySelector('.u').focus());
  });
  setTool('select');
  if (!target) return;
  pushUndo();
  const a = { id: uid(), type: 'link', x: box.x, y: box.y, w: box.w, h: box.h, ...target };
  annotsOf(i).push(a);
  renderAnnotations(i);
  select({ page: i, id: a.id });
  markDirty();
}

// ---- Bookmarks ----------------------------------------------------------------------------

const bookmarksEl = $('#bookmarks');
let bmSelected = null;

function bmFind(id, list = state.outline || [], parent = null) {
  for (let k = 0; k < list.length; k++) {
    if (list[k].id === id) return { node: list[k], list, index: k, parent };
    const found = bmFind(id, list[k].children, list[k]);
    if (found) return found;
  }
  return null;
}

function renderBookmarks() {
  const rows = [];
  const walk = (list, depth) => {
    for (const n of list) {
      const row = div(`bm-row${n.id === bmSelected ? ' selected' : ''}`);
      row.style.paddingLeft = `${6 + depth * 14}px`;
      const twisty = Object.assign(document.createElement('span'), { className: 'twisty', textContent: n.children.length ? (n.open ? '▾' : '▸') : '' });
      twisty.addEventListener('click', (e) => {
        e.stopPropagation();
        n.open = !n.open;
        renderBookmarks();
      });
      const title = Object.assign(document.createElement('span'), { className: 'title', textContent: n.title, title: n.title });
      row.append(twisty, title);
      row.addEventListener('click', () => {
        bmSelected = n.id;
        renderBookmarks();
        followLink({ url: n.url, pageId: n.pageId, top: n.top });
      });
      row.addEventListener('dblclick', () => canEdit() && renameBookmark(n.id));
      rows.push(row);
      if (n.open) walk(n.children, depth + 1);
    }
  };
  walk(state.outline || [], 0);
  if (!rows.length) rows.push(Object.assign(div('bm-empty'), { textContent: 'No bookmarks yet. Use + to bookmark the current page.' }));
  bookmarksEl.replaceChildren(...rows);
}

function editOutline(change) {
  pushUndo();
  change();
  state.outlineEdited = true;
  markDirty();
  renderBookmarks();
}

function renameBookmark(id) {
  const el = [...bookmarksEl.querySelectorAll('.bm-row')].find((r) => r.classList.contains('selected'))?.querySelector('.title');
  const found = bmFind(id);
  if (!el || !found) return;
  const before = snapshot();
  el.contentEditable = 'plaintext-only';
  el.focus();
  getSelection().selectAllChildren(el);
  el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      el.blur();
    }
  });
  el.addEventListener('blur', () => {
    const title = el.innerText.trim() || found.node.title;
    if (title !== found.node.title) {
      pushUndo(before);
      found.node.title = title;
      state.outlineEdited = true;
      markDirty();
    }
    renderBookmarks();
  }, { once: true });
}

document.querySelector('.sidebar').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-side]');
  if (tab) {
    document.querySelectorAll('.side-tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.sidebar [data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== tab.dataset.side));
    return;
  }
  const b = e.target.closest('[data-bm]');
  if (!b || b.disabled || !canEdit()) return;
  const found = bmSelected && bmFind(bmSelected);
  const op = b.dataset.bm;
  if (op === 'add') {
    const node = { id: uid(), title: `Page ${state.current + 1}`, pageId: state.pageIds[state.current], top: null, open: true, children: [] };
    editOutline(() => {
      if (found) found.list.splice(found.index + 1, 0, node);
      else (state.outline ||= []).push(node);
    });
    bmSelected = node.id;
    renderBookmarks();
    return renameBookmark(node.id);
  }
  if (!found) return toast('Select a bookmark first');
  const { list, index, node, parent } = found;
  if (op === 'delete') editOutline(() => list.splice(index, 1));
  if (op === 'up' && index > 0) editOutline(() => list.splice(index - 1, 0, ...list.splice(index, 1)));
  if (op === 'down' && index < list.length - 1) editOutline(() => list.splice(index + 1, 0, ...list.splice(index, 1)));
  if (op === 'indent' && index > 0) editOutline(() => {
    list.splice(index, 1);
    list[index - 1].children.push(node);
    list[index - 1].open = true;
  });
  if (op === 'outdent' && parent) editOutline(() => {
    const up = bmFind(parent.id);
    list.splice(index, 1);
    up.list.splice(up.index + 1, 0, node);
  });
});

function setFormValue(key, value, source) {
  state.formValues[key] = value;
  // Keep every widget of the same field (e.g. a name repeated on each page) in sync.
  for (const el of document.querySelectorAll(`[data-field="${CSS.escape(key)}"]`)) {
    if (el === source) continue;
    if (el.type === 'checkbox') el.checked = !!value;
    else if (el.type !== 'radio') el.value = value;
  }
  markDirty();
}

// ---- Find -----------------------------------------------------------------------------

async function pageText(i) {
  const page = state.pages[i];
  if (!state.textCache.has(page)) {
    const tc = await page.getTextContent();
    state.textCache.set(page, tc.items.filter((it) => it.str));
  }
  return state.textCache.get(page);
}

async function runFind(query) {
  const token = {};
  state.findToken = token;
  if (!query.trim() || !state.pdf) {
    state.find = null;
    $('#find-status').textContent = '';
    state.views.forEach((_, i) => drawHits(i));
    return;
  }
  const q = query.toLowerCase();
  const results = [];
  for (let i = 0; i < state.pages.length; i++) {
    const items = await pageText(i);
    if (state.findToken !== token) return;
    items.forEach((item, k) => {
      const s = item.str.toLowerCase();
      for (let pos = s.indexOf(q); pos !== -1; pos = s.indexOf(q, pos + 1)) {
        results.push({ page: i, item, start: pos, len: q.length, k });
      }
    });
    for (const line of ocrLines(i)) {
      const s = line.text.toLowerCase();
      for (let pos = s.indexOf(q); pos !== -1; pos = s.indexOf(q, pos + 1)) {
        const words = line.words.filter((w) => w.end > pos && w.start < pos + q.length);
        results.push({ page: i, box: unionBox(words), start: pos, len: q.length });
      }
    }
  }
  const startAt = results.findIndex((r) => r.page >= state.current);
  state.find = { results, index: results.length ? Math.max(0, startAt) : -1 };
  state.views.forEach((_, i) => drawHits(i));
  showFindResult();
}

function findStep(dir) {
  const f = state.find;
  if (!f || !f.results.length) return;
  const prevPage = f.results[f.index].page;
  f.index = (f.index + dir + f.results.length) % f.results.length;
  drawHits(prevPage);
  showFindResult();
}

function showFindResult() {
  const f = state.find;
  const status = $('#find-status');
  if (!f.results.length) {
    status.textContent = 'No matches';
    return;
  }
  status.textContent = `${f.index + 1} of ${f.results.length}`;
  const r = f.results[f.index];
  drawHits(r.page);
  scrollToPage(r.page);
  state.views[r.page].hits.querySelector('.hit.current')?.scrollIntoView({ block: 'center', inline: 'nearest' });
}

function drawHits(i) {
  const v = state.views[i];
  if (!v) return;
  const f = state.find;
  if (!f) return v.hits.replaceChildren();
  const vp = state.pages[i].getViewport({ scale: state.scale });
  const current = f.results[f.index];
  const els = f.results.filter((r) => r.page === i).map((r) => {
    if (r.box) {
      const el = div(r === current ? 'hit current' : 'hit');
      Object.assign(el.style, {
        left: `${r.box.x * state.scale}px`, top: `${r.box.y * state.scale}px`,
        width: `${r.box.w * state.scale}px`, height: `${r.box.h * state.scale}px`,
      });
      return el;
    }
    const tx = pdfjsLib.Util.transform(vp.transform, r.item.transform);
    const angle = Math.atan2(tx[1], tx[0]);
    const fontH = Math.hypot(tx[2], tx[3]);
    const total = r.item.width * state.scale;
    const n = r.item.str.length;
    const el = div(r === current ? 'hit current' : 'hit');
    Object.assign(el.style, {
      left: `${tx[4]}px`,
      top: `${tx[5] - fontH}px`,
      width: `${(total * r.len) / n}px`,
      height: `${fontH * 1.15}px`,
      transformOrigin: `0 ${fontH}px`,
      transform: `rotate(${angle}rad) translateX(${(total * r.start) / n}px)`,
    });
    return el;
  });
  v.hits.replaceChildren(...els);
}

// ---- Saving (bake overlay markup into the PDF) ----------------------------------------

function pdfColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// Standard fonts only cover WinAnsi; swap anything else for "?" rather than failing.
function encodable(font, text) {
  let out = '';
  for (const ch of text.replace(/\t/g, '    ')) {
    if (ch === '\n') {
      out += ch;
      continue;
    }
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += '?';
    }
  }
  return out;
}

// flatten: draw all markup into the page content instead of writing editable
// annotations (for a copy that looks the same everywhere and can't be changed).
async function buildOutput({ flatten = false } = {}) {
  if (isEditable(document.activeElement)) document.activeElement.blur();
  const doc = await PDFDocument.load(state.bytes, { updateMetadata: false });
  doc.registerFontkit(window.fontkit);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fonts = new Map([['Helvetica', font]]);
  // The same font choice the preview uses (document font, DejaVu or standard).
  const textFont = async (a) => {
    const choice = fontChoice(a);
    const key = choice.kind === 'standard' ? standardFontName(a) : choice.id || choice.name;
    if (!fonts.has(key)) {
      fonts.set(key, choice.kind === 'standard' ? await doc.embedFont(key) : await doc.embedFont(await fontBytes(choice), { subset: true }));
    }
    return fonts.get(key);
  };

  const entries = Object.entries(state.formValues);
  if (entries.length) {
    const form = doc.getForm();
    for (const [name, value] of entries) {
      try {
        const field = form.getField(name);
        if (field instanceof PDFTextField) field.setText(String(value));
        else if (field instanceof PDFCheckBox) value ? field.check() : field.uncheck();
        else if (field instanceof PDFRadioGroup || field instanceof PDFDropdown || field instanceof PDFOptionList) field.select(String(value));
      } catch (err) {
        console.warn(`Could not set form field "${name}":`, err);
      }
    }
  }

  if (state.outlineEdited) {
    writeOutline(doc, state.outline, state.pageIds, state.pages.map((p) => p.getViewport({ scale: 1 })));
  }

  const images = new Map();
  const embed = async (src) => {
    if (!images.has(src)) images.set(src, await (src.startsWith('data:image/jpeg') ? doc.embedJpg(src) : doc.embedPng(src)));
    return images.get(src);
  };

  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const list = state.annotations[state.pageIds[i]];
    if (!list?.length) continue;
    const page = pages[i];
    const vp = state.pages[i].getViewport({ scale: 1 });
    const rotate = degrees(vp.rotation);
    const pt = (x, y) => {
      const [px, py] = vp.convertToPdfPoint(x, y);
      return { x: px, y: py };
    };
    const box = (a) => {
      const p = pt(a.x, a.y);
      const q = pt(a.x + a.w, a.y + a.h);
      return { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), width: Math.abs(q.x - p.x), height: Math.abs(q.y - p.y) };
    };
    const segment = (a, [x1, y1], [x2, y2]) =>
      page.drawLine({ start: pt(x1, y1), end: pt(x2, y2), thickness: a.width, color: pdfColor(a.color), lineCap: LineCapStyle.Round });

    const annotationList = [];
    for (const a of paintOrder(list)) {
      if (!flatten && isAnnotationType(a)) {
        annotationList.push(a);
        continue;
      }
      switch (a.type) {
        case 'highlight':
          page.drawRectangle({ ...box(a), color: pdfColor(a.color), opacity: 0.4, blendMode: BlendMode.Multiply });
          break;
        case 'markup':
          for (const r of a.rects) {
            if (a.kind === 'highlight') {
              page.drawRectangle({ ...box(r), color: pdfColor(a.color), opacity: 0.4, blendMode: BlendMode.Multiply });
            } else {
              const y = a.kind === 'underline' ? r.y + r.h * 0.92 : r.y + r.h * 0.55;
              segment({ color: a.color, width: Math.max(0.75, r.h * 0.07) }, [r.x, y], [r.x + r.w, y]);
            }
          }
          break;
        case 'whiteout':
          page.drawRectangle({ ...box(a), color: pdfColor(a.color || '#ffffff') });
          break;
        case 'mark': {
          const at = (u, v) => [a.x + (u / 16) * a.w, a.y + (v / 16) * a.h];
          if (a.kind === 'dot') {
            const c = pt(...at(8, 8));
            page.drawEllipse({ x: c.x, y: c.y, xScale: a.w / 4, yScale: a.h / 4, color: pdfColor(a.color) });
          } else {
            const strokes = a.kind === 'check' ? [[[2.5, 8.5], [6.5, 12.5], [13.5, 3.5]]] : [[[3.5, 3.5], [12.5, 12.5]], [[12.5, 3.5], [3.5, 12.5]]];
            for (const line of strokes) for (let k = 1; k < line.length; k++) segment({ color: a.color, width: (a.w / 16) * 2 }, at(...line[k - 1]), at(...line[k]));
          }
          break;
        }
        case 'rect':
          page.drawRectangle({ ...box(a), borderColor: pdfColor(a.color), borderWidth: a.width });
          break;
        case 'ellipse': {
          const r = box(a);
          page.drawEllipse({
            x: r.x + r.width / 2, y: r.y + r.height / 2, xScale: r.width / 2, yScale: r.height / 2,
            borderColor: pdfColor(a.color), borderWidth: a.width,
          });
          break;
        }
        case 'line':
          segment(a, [a.x1, a.y1], [a.x2, a.y2]);
          break;
        case 'arrow': {
          const [h1, h2] = arrowHead(a);
          segment(a, [a.x1, a.y1], [a.x2, a.y2]);
          segment(a, h1, [a.x2, a.y2]);
          segment(a, h2, [a.x2, a.y2]);
          break;
        }
        case 'pen':
          if (a.points.length === 1) segment(a, a.points[0], a.points[0]);
          for (let k = 1; k < a.points.length; k++) segment(a, a.points[k - 1], a.points[k]);
          break;
        case 'text': {
          // Anchor at the first baseline; rotating by the page rotation keeps it upright on screen.
          if (a.highlight) {
            page.drawRectangle({ ...box(a), color: pdfColor(a.highlight), opacity: 0.4, blendMode: BlendMode.Multiply });
          }
          const f = await textFont(a);
          const origin = pt(a.x + a.size * TEXT_PAD_X, a.y + a.size * (TEXT_PAD_Y + textBaseline(a)));
          page.drawText(encodable(f, layoutLines(a).join('\n')), {
            ...origin, size: a.size, font: f, color: pdfColor(a.color), lineHeight: a.size * (a.lh || 1.2), rotate,
          });
          break;
        }
        case 'ocrtext': {
          // Invisible text (render mode 3) sized to the word, like a scanner's OCR layer.
          const text = encodable(font, a.text);
          const unit = font.widthOfTextAtSize(text, 1);
          if (!text.trim() || !unit) break;
          const size = a.w / unit;
          const o = pt(a.x, a.y + a.h * (a.base ?? 0.8));
          const r = (vp.rotation * Math.PI) / 180;
          page.setFont(font);
          page.pushOperators(
            pushGraphicsState(), beginText(), setFontAndSize(page.fontKey, size),
            setTextRenderingMode(TextRenderingMode.Invisible),
            setTextMatrix(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), o.x, o.y),
            showText(font.encodeText(text)), endText(), popGraphicsState()
          );
          break;
        }
        case 'image': {
          const origin = pt(a.x, a.y + a.h);
          page.drawImage(await embed(a.src), { ...origin, width: a.w, height: a.h, rotate });
          break;
        }
      }
    }
    if (annotationList.length) {
      await writeAnnotations({
        doc, page, vp, pt, arrowHead, encodable, textBaseline, layoutLines, TEXT_PAD_X, TEXT_PAD_Y,
        pageIndexOf: (id) => state.pageIds.indexOf(id), pageRef: (k) => pages[k]?.ref,
        viewportOf: (k) => state.pages[k]?.getViewport({ scale: 1 }),
        fontFor: textFont,
      }, annotationList);
    }
  }
  return doc.save();
}

function save({ saveAs = false } = {}) {
  return enqueue(async () => {
    if (!state.pdf) return false;
    if (state.readOnly) {
      toast(state.readOnly === 'restricted' ? 'Editing this PDF needs the owner password (Unlock).' : 'This PDF can’t be saved with edits.', { error: true });
      return false;
    }
    let out = await buildOutput();
    // Opened with a password: save it protected the same way.
    if (state.protection) out = await encryptPdf(out, state.protection.password, null, state.protection.permissions);
    const res = !saveAs && state.filePath ? await api.write(state.filePath, out) : await api.saveAs(out, state.fileName);
    if (!res) return false;
    state.filePath = res.path;
    state.fileName = res.name;
    state.dirty = false;
    api.clearRecovery();
    updateUI();
    toast(`Saved ${res.name}`);
    return true;
  });
}

function saveFlattened() {
  return enqueue(async () => {
    if (!state.pdf || state.readOnly) return;
    const base = (state.fileName || 'Document').replace(/\.pdf$/i, '');
    const res = await api.saveAs(await buildOutput({ flatten: true }), `${base} (flattened).pdf`);
    if (res) toast(`Saved ${res.name}`);
  });
}

// ---- Print -------------------------------------------------------------------------------

function printDocument() {
  return enqueue(async () => {
    if (!state.pdf) return;
    toast('Preparing pages for printing…');
    const bytes = state.readOnly ? state.bytes : await buildOutput();
    const pdf = await loadPdfJs(bytes);
    const root = $('#print-root');
    const urls = [];
    try {
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const vp = page.getViewport({ scale: 2 }); // ~144 dpi
        const canvas = Object.assign(document.createElement('canvas'), { width: vp.width, height: vp.height });
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, intent: 'print' }).promise;
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
        const url = URL.createObjectURL(blob);
        urls.push(url);
        const img = new Image();
        img.src = url;
        await img.decode();
        root.append(img);
      }
      // Clean up only once the system print dialog has closed.
      await new Promise((resolve) => {
        window.addEventListener('afterprint', resolve, { once: true });
        window.print();
      });
    } finally {
      root.replaceChildren();
      urls.forEach(URL.revokeObjectURL);
      pdf.loadingTask.destroy();
    }
  });
}

// ---- Wiring ---------------------------------------------------------------------------------

const actions = {
  open: () => api.openFiles(),
  save: () => save(),
  'save-as': () => save({ saveAs: true }),
  'save-flattened': () => saveFlattened(),
  'toggle-comments': () => toggleComments(),
  'tool-note': () => setTool('note'),
  'tool-redact': () => setTool('redact'),
  preferences: () => openPreferences(),
  unlock: () => enqueue(async () => {
    if (state.readOnly !== 'restricted') return toast('This document is already editable.');
    const unlocked = await unlock(state.original, { ownerOnly: true });
    if (!unlocked?.bytes) return;
    const { filePath, fileName } = state;
    await openDocument({ data: unlocked.bytes, path: filePath, name: fileName });
    state.original = unlocked.bytes;
    state.protection = unlocked.protection;
    toast('Unlocked for editing.');
  }),
  'remove-password': () => {
    if (!state.protection) return toast('This document has no password.');
    state.protection = null;
    markDirty();
    toast('The password will be removed when you save.');
  },
  'insert-date': () => startFill('date'),
  'tool-field': () => startFill('field-text'),
  'form-edit': () => toggleFormEdit(),
  'detect-fields': () => detectFormFields(),
  'tab-order': () => chooseTabOrder(),
  'apply-redactions': () => applyRedactions(),
  'save-and-close': async () => {
    if (await save()) api.forceClose();
    else api.closeCancelled();
  },
  merge: () => mergePdf(),
  print: () => printDocument(),
  undo: () => (isEditable(document.activeElement) ? document.execCommand('undo') : undo()),
  redo: () => (isEditable(document.activeElement) ? document.execCommand('redo') : redo()),
  find: () => {
    findInput.focus();
    findInput.select();
  },
  'zoom-in': () => zoomStep(1),
  'zoom-out': () => zoomStep(-1),
  'zoom-actual': () => setZoom('1'),
  'zoom-fit-width': () => setZoom('fit-width'),
  'zoom-fit-page': () => setZoom('fit-page'),
  'toggle-sidebar': () => {
    $('#sidebar').classList.toggle('hidden');
    if (state.zoomMode) setZoom(state.zoomMode);
  },
  'rotate-cw': () => rotatePage(state.current, 1),
  'rotate-ccw': () => rotatePage(state.current, -1),
  'insert-blank': () => insertBlankPage(state.current),
  'delete-page': async () => {
    if (await confirmModal('Delete page?', `Page ${state.current + 1} will be removed from the document.`, 'Delete')) {
      deletePage(state.current);
    }
  },
  'extract-page': () => extractPage(state.current),
  ocr: () => runOcr(),
  'tool-edittext': () => setTool('edittext'),
  'tool-signature': () => setTool('signature'),
};

Object.assign(actions, installPageTools({
  state, api, modal, button, toast, enqueue, mutateDocument, buildOutput, setTool, annotsOf, translate,
  snapshot, pushUndo, reloadBytes, markDirty, collectGarbage, loadPdfJs, encodable, pdfColor, ocrLines,
}));

const pageMenu = $('#page-menu');
$('#page-menu-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  pageMenu.hidden = !pageMenu.hidden;
  const r = e.currentTarget.getBoundingClientRect();
  Object.assign(pageMenu.style, { left: `${r.left}px`, top: `${r.bottom + 4}px` });
});
pageMenu.addEventListener('click', () => (pageMenu.hidden = true));
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#page-menu, #page-menu-btn')) pageMenu.hidden = true;
});

api.onMenu((action) => {
  if (!state.pdf && !['open', 'toggle-sidebar', 'from-images', 'preferences'].includes(action)) return;
  actions[action]?.();
});
api.onOpenPath((p) => enqueue(() => openPath(p)));

function renderRecent(list) {
  const el = $('#recent');
  el.replaceChildren();
  if (!list?.length) return;
  el.append(Object.assign(document.createElement('h2'), { textContent: 'Recent' }));
  for (const p of list.slice(0, 8)) {
    const b = Object.assign(document.createElement('button'), { className: 'recent-item', title: p });
    const name = p.split(/[\\/]/).pop();
    b.append(Object.assign(document.createElement('span'), { textContent: name }));
    b.append(Object.assign(document.createElement('small'), { textContent: p.slice(0, p.length - name.length - 1) }));
    b.addEventListener('click', () => api.openRecent(p));
    el.append(b);
  }
}
api.recent().then(renderRecent);
api.onRecentChanged(renderRecent);

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]');
  if (b && !b.disabled) actions[b.dataset.action]?.();
  // Toolbar buttons only: the viewer also carries data-tool (for cursor styling).
  const t = e.target.closest('button[data-tool]');
  if (t && !t.disabled) setTool(t.dataset.tool);
});

zoomSelect.addEventListener('change', () => {
  if (zoomSelect.value !== 'custom') setZoom(zoomSelect.value);
});

$('#page-num').addEventListener('change', (e) => {
  const n = parseInt(e.target.value, 10);
  if (n >= 1 && n <= state.pages.length) scrollToPage(n - 1);
  e.target.value = String(state.current + 1);
  e.target.blur();
});

let findTimer;
findInput.addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(() => runFind(findInput.value), 200);
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (state.find) findStep(e.shiftKey ? -1 : 1);
    else runFind(findInput.value);
  }
  if (e.key === 'Escape') {
    findInput.value = '';
    runFind('');
    findInput.blur();
  }
});

colorInput.addEventListener('change', () => {
  state.colors[colorKey(state.tool)] = colorInput.value;
  updateSelectedProp((a) => {
    if (!a.color || a.type === 'whiteout') return false;
    a.color = colorInput.value;
  });
});
widthInput.addEventListener('change', () =>
  updateSelectedProp((a) => {
    if (!a.width) return false;
    a.width = Number(widthInput.value);
  })
);
familyInput.addEventListener('change', () => setTextStyle({ font: familyInput.value }));
boldButton.addEventListener('click', () => setTextStyle({ bold: !boldButton.classList.contains('on') }));
italicButton.addEventListener('click', () => setTextStyle({ italic: !italicButton.classList.contains('on') }));

function setTextStyle(change) {
  const a = selectedAnnot();
  if (a?.type === 'text') {
    updateSelectedProp((t) => Object.assign(t, change));
    syncTextStyleControls(a);
  } else {
    Object.assign(state.textStyle, change);
    syncTextStyleControls(state.textStyle);
  }
}

fontInput.addEventListener('change', () =>
  updateSelectedProp((a) => {
    if (a.type !== 'text') return false;
    a.size = Number(fontInput.value);
  })
);

viewerEl.addEventListener('scroll', () => scheduleRender(), { passive: true });
viewerEl.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey) || !state.pdf) return;
  e.preventDefault();
  applyScale(clamp(state.scale * Math.exp(-e.deltaY * 0.01), 0.1, 6), null, 120);
}, { passive: false });

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.pdf && state.zoomMode) setZoom(state.zoomMode);
    else scheduleRender();
  }, 100);
});

const TOOL_KEYS = { v: 'select', x: 'edittext', n: 'note', d: 'redact', t: 'text', p: 'pen', h: 'highlight', u: 'underline', k: 'strike', r: 'rect', e: 'ellipse', l: 'line', a: 'arrow', w: 'whiteout', i: 'image', s: 'signature' };
document.addEventListener('keydown', (e) => {
  if (isEditable(e.target) || !$('#modal').hidden || !state.pdf) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const sel = selectedAnnot();
  const key = e.key.toLowerCase();
  if ((key === 'h' || key === 'u') && !getSelection().isCollapsed && applyTextMarkup(key === 'h' ? 'highlight' : 'underline')) {
    e.preventDefault();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelected();
  } else if (e.key === 'Escape') {
    select(null);
    setTool('select');
  } else if (e.key.startsWith('Arrow') && sel && canEdit()) {
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1;
    const dx = { ArrowLeft: -d, ArrowRight: d }[e.key] || 0;
    const dy = { ArrowUp: -d, ArrowDown: d }[e.key] || 0;
    pushUndo();
    translate(sel, structuredClone(sel), dx, dy);
    updateAnnotElement(state.selected.page, sel).classList.add('selected');
    markDirty();
  } else if (e.key === 'PageDown' || (e.key === 'ArrowRight' && !sel)) {
    e.preventDefault();
    scrollToPage(Math.min(state.current + 1, state.pages.length - 1));
  } else if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && !sel)) {
    e.preventDefault();
    scrollToPage(Math.max(state.current - 1, 0));
  } else if (TOOL_KEYS[e.key.toLowerCase()]) {
    setTool(TOOL_KEYS[e.key.toLowerCase()]);
  }
});

// Drag a PDF from Finder / Explorer / a file manager onto the window to open it.
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  $('#drop-overlay').classList.add('show');
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) $('#drop-overlay').classList.remove('show');
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').classList.remove('show');
  const file = [...e.dataTransfer.files].find((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!file) return toast('Drop a PDF file to open it.', { error: true });
  const filePath = api.pathForFile(file);
  // A tab holds one document; dropping onto a tab that has one opens a new tab.
  if (filePath && state.pdf) return api.openFiles([filePath]);
  enqueue(async () => {
    if (filePath) return openPath(filePath);
    if (!(await confirmDiscard())) return;
    await openDocument({ data: new Uint8Array(await file.arrayBuffer()), name: file.name });
  });
});

// ---- Preferences --------------------------------------------------------------------------

let prefs = null;
function applyPrefs(p) {
  prefs = p;
  state.userName = p.authorName || state.osUserName || state.userName;
  Object.assign(state.colors, p.colors);
  Object.assign(state.textStyle, p.textStyle);
  fontInput.value = String(p.fontSize);
  widthInput.value = String(p.strokeWidth);
  if (!state.selected) {
    colorInput.value = state.colors[colorKey(state.tool)] || state.colors.shape;
    syncTextStyleControls(state.textStyle);
  }
}
api.info().then((info) => {
  state.osUserName = info.userName;
  state.userName ||= info.userName;
  return api.prefs();
}).then(applyPrefs);
api.onPrefsChanged(applyPrefs);

async function openPreferences() {
  const p = prefs || (await api.prefs());
  const color = (key, label) => `<label class="pref-color"><input type="color" data-color="${key}" value="${p.colors[key]}" /> ${label}</label>`;
  const next = await modal((m, close) => {
    m.innerHTML = `<h2>Settings</h2><div class="form">
      <label class="field-row">Your name <input type="text" class="author" placeholder="${state.osUserName || ''}" /></label>
      <p class="hint-line">Shown as the author of comments and markup.</p>
      <label class="field-row">Appearance <select class="theme"><option value="system">Match system</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <label class="field-row">Open documents at <select class="zoom"><option value="fit-width">Fit width</option><option value="fit-page">Fit page</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option></select></label>
      <div class="field-row">Default colors</div>
      <div class="pref-colors">${color('text', 'Text')}${color('shape', 'Shapes & pen')}${color('highlight', 'Highlight')}${color('underline', 'Underline')}${color('strike', 'Strike')}</div>
      <label class="field-row">Text <select class="font"><option value="sans">Sans</option><option value="serif">Serif</option><option value="mono">Mono</option></select>
        <input type="number" class="size" min="4" max="200" style="width:70px" /> pt</label>
      <label class="field-row">Line width <input type="number" class="width" min="1" max="20" style="width:70px" /> pt</label>
      <label class="opt"><input type="checkbox" class="recovery" /> Keep crash-recovery snapshots of unsaved work</label>
    </div><div class="actions"></div>`;
    m.querySelector('.author').value = p.authorName;
    m.querySelector('.theme').value = p.theme;
    m.querySelector('.zoom').value = p.defaultZoom;
    m.querySelector('.font').value = p.textStyle.font;
    m.querySelector('.size').value = p.fontSize;
    m.querySelector('.width').value = p.strokeWidth;
    m.querySelector('.recovery').checked = p.recovery;
    m.querySelector('.actions').append(button('Cancel', 'secondary', () => close(null)), button('Save', 'primary', () => {
      const colors = {};
      m.querySelectorAll('[data-color]').forEach((c) => (colors[c.dataset.color] = c.value));
      close({
        authorName: m.querySelector('.author').value.trim(),
        theme: m.querySelector('.theme').value,
        defaultZoom: m.querySelector('.zoom').value,
        colors,
        textStyle: { ...p.textStyle, font: m.querySelector('.font').value },
        fontSize: Math.max(4, Number(m.querySelector('.size').value) || 14),
        strokeWidth: Math.max(1, Number(m.querySelector('.width').value) || 2),
        recovery: m.querySelector('.recovery').checked,
      });
    }));
  });
  if (next) applyPrefs(await api.setPrefs(next));
}
onFontLoaded(() => {
  baselineCache.clear();
  state.views.forEach((_, i) => renderAnnotations(i));
});

viewerEl.dataset.tool = 'select';
$('[data-tool="select"]').classList.add('active');
updateUI();

// Exposed for debugging from DevTools.
window.agility = { state, actions, buildOutput, applyRedactions, pageLines, openPath: (p) => enqueue(() => openPath(p)) };
