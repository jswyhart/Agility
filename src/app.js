// Agility — renderer.
//
// pdf.js renders pages; pdf-lib owns the document structure. The current page
// structure lives in `state.bytes` (rotations, page order, inserted/merged pages
// are applied to it immediately). Markup the user adds lives as editable
// overlay objects in `state.annotations`, stored in unscaled display units of
// each page (points, origin top-left, page's current rotation). On save they're
// drawn into the page content with pdf-lib.

import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';
import { removeTextLine } from './textedit.js';

const {
  PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle,
  PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList,
  pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setTextMatrix,
  setTextRenderingMode, showText, TextRenderingMode,
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
const DRAW_TOOLS = new Set(['pen', 'highlight', 'rect', 'ellipse', 'line', 'arrow', 'whiteout']);
const BOX_TYPES = new Set(['highlight', 'whiteout', 'rect', 'ellipse', 'image']);
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

// Distance from the top of a text box's first line to its baseline, in em, measured
// from the browser's own layout so saved text lands exactly where it was shown.
const baselineCache = new Map();
function textBaseline(a) {
  const key = `${a.font || 'sans'}|${a.bold ? 1 : 0}|${a.italic ? 1 : 0}`;
  if (!baselineCache.has(key)) {
    const probe = div('');
    Object.assign(probe.style, {
      position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', fontSize: '100px', lineHeight: '1.2',
      fontFamily: FONT_CSS[a.font || 'sans'], fontWeight: a.bold ? 'bold' : 'normal', fontStyle: a.italic ? 'italic' : 'normal',
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
  colors: { shape: '#e5484d', text: '#1a1a1a', highlight: '#ffd400' },
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

function passwordModal(retry) {
  return modal((box, close) => {
    box.innerHTML = `<h2>Password required</h2><p></p>
      <input type="password" autocomplete="off" /><div class="actions"></div>`;
    box.querySelector('p').textContent = retry
      ? 'Incorrect password. Try again.'
      : 'This document is protected. Enter its password to open it.';
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
  updateUI();
}

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

async function loadPdfJs(bytes) {
  // pdf.js transfers the buffer to its worker, so always hand it a copy.
  const task = pdfjsLib.getDocument({ ...PDFJS_OPTIONS, data: bytes.slice() });
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

async function openDocument({ data, path = null, name = 'Untitled.pdf' }) {
  const bytes = new Uint8Array(data);
  let pdf;
  try {
    pdf = await loadPdfJs(bytes);
  } catch (err) {
    if (err?.name === 'PasswordException' || /destroyed/i.test(err?.message)) return;
    throw new Error(`Couldn't open “${name}”: ${err.message}`);
  }
  let readOnly = false;
  try {
    await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    readOnly = true;
    const why = /encrypt/i.test(err.message) ? 'is encrypted' : "couldn't be parsed for editing";
    setTimeout(() => toast(`This PDF ${why}, so it opened read-only.`, { ms: 6000 }), 300);
  }

  state.pdf?.loadingTask.destroy();
  Object.assign(state, {
    bytes, readOnly, filePath: path, fileName: name,
    pageIds: Array.from({ length: pdf.numPages }, uid),
    annotations: {}, formValues: {}, undo: [], redo: [],
    dirty: false, selected: null, pendingImage: null, find: null, current: 0,
  });
  findInput.value = '';
  $('#find-status').textContent = '';
  await setPdf(pdf);
  setTool('select');
  setZoom('fit-width');
  viewerEl.scrollTop = 0;
  updateUI();
}

async function openFromDialog() {
  if (!(await confirmDiscard())) return;
  const file = await api.openPdfDialog();
  if (file) await openDocument(file);
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
async function reloadBytes(bytes) {
  const keep = state.current;
  const pdf = await loadPdfJs(bytes);
  state.bytes = bytes;
  await setPdf(pdf);
  layoutPages();
  scrollToPage(Math.min(keep, state.pages.length - 1));
  updateUI();
}

// ---- Page views ----------------------------------------------------------------

const baseViewport = (i) => state.pages[i].getViewport({ scale: 1 });

function buildPages() {
  pagesEl.replaceChildren();
  state.views = state.pages.map((_, i) => {
    const el = div('page');
    const canvas = Object.assign(document.createElement('canvas'), { className: 'render' });
    const hits = div('hits');
    const annots = div('annots');
    const forms = div('forms');
    el.append(canvas, hits, annots, forms);
    pagesEl.append(el);
    annots.addEventListener('pointerdown', (e) => onPagePointerDown(e, i));
    annots.addEventListener('dblclick', (e) => onPageDoubleClick(e, i));
    return { el, canvas, hits, annots, forms, renderedScale: 0, task: null, widgets: null };
  });
}

function layoutPages() {
  state.views.forEach((v, i) => {
    const vp = baseViewport(i);
    v.el.style.width = `${vp.width * state.scale}px`;
    v.el.style.height = `${vp.height * state.scale}px`;
    renderAnnotations(i);
    renderForms(i);
    drawHits(i);
    renderEditLines(i);
  });
  scheduleRender();
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

function renderVisible() {
  const vr = viewerEl.getBoundingClientRect();
  state.views.forEach((v, i) => {
    const r = v.el.getBoundingClientRect();
    if (r.bottom < vr.top - vr.height || r.top > vr.bottom + vr.height) return;
    if (v.renderedScale !== state.scale) renderPage(i);
  });
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
  } catch (err) {
    if (!(err instanceof pdfjsLib.RenderingCancelledException)) console.error(err);
    if (v.renderedScale === scale && v.task === task) v.renderedScale = 0;
  } finally {
    if (v.task === task) v.task = null;
  }
}

function updateCurrentPage() {
  if (!state.views.length) return;
  const vr = viewerEl.getBoundingClientRect();
  const probe = vr.top + vr.height * 0.35;
  let cur = 0;
  for (let i = 0; i < state.views.length; i++) {
    if (state.views[i].el.getBoundingClientRect().top <= probe) cur = i;
    else break;
  }
  setCurrent(cur);
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

function scrollToPage(i) {
  const v = state.views[i];
  if (!v) return;
  viewerEl.scrollTop = v.el.offsetTop - 16;
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

async function renderThumbs(gen) {
  const ratio = window.devicePixelRatio || 1;
  for (let i = 0; i < state.thumbs.length; i++) {
    if (gen !== state.thumbGen) return;
    const t = state.thumbs[i];
    const vp = state.pages[i].getViewport({ scale: t.scale * ratio });
    t.canvas.width = Math.floor(vp.width);
    t.canvas.height = Math.floor(vp.height);
    try {
      await state.pages[i].render({ canvasContext: t.canvas.getContext('2d'), viewport: vp }).promise;
    } catch {
      /* document replaced mid-render */
    }
  }
}

// ---- Undo / redo ----------------------------------------------------------------

function snapshot() {
  return {
    bytes: state.bytes,
    pageIds: [...state.pageIds],
    annotations: structuredClone(state.annotations),
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
  if (a.type === 'pen') {
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
      content.style.fontFamily = FONT_CSS[a.font || 'sans'];
      content.style.fontWeight = a.bold ? 'bold' : 'normal';
      content.style.fontStyle = a.italic ? 'italic' : 'normal';
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
    case 'whiteout':
      el.style.background = a.color || '#fff';
      break;
    default:
      el.append(shapeSvg(a, b));
  }
  if (BOX_TYPES.has(a.type) || a.type === 'text') el.append(div('handle'));
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

const colorKey = (tool) => (tool === 'text' ? 'text' : tool === 'highlight' ? 'highlight' : 'shape');

function setTool(tool) {
  if (tool !== 'select' && !canEdit()) return;
  if (isEditable(document.activeElement)) document.activeElement.blur();
  state.tool = tool;
  if (tool !== 'image' && tool !== 'signature') state.pendingImage = null;
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
  state.views.forEach((_, i) => renderEditLines(i));
}

// Begin text editing only once the click has finished. Focusing on pointerdown
// doesn't stick: the browser moves focus again when the button is released.
// Listening on window also catches a release outside the element that was pressed.
function afterClick(e, fn) {
  e.preventDefault();
  const at = { x: e.clientX, y: e.clientY };
  window.addEventListener('pointerup', () => setTimeout(() => fn(at)), { once: true });
}

function onPageDoubleClick(e, i) {
  // The drag started on pointerdown captures the pointer, so the event targets the
  // layer itself; look up what is actually under the cursor.
  const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.annot.text');
  if (!el || state.tool !== 'select' || !canEdit()) return;
  const at = { x: e.clientX, y: e.clientY };
  setTimeout(() => editText(i, el.dataset.id, snapshot(), false, at));
}

function onPagePointerDown(e, i) {
  if (e.button !== 0 || !state.pdf) return;
  const annotEl = e.target.closest('.annot');
  const tool = state.tool;

  if (tool === 'select') {
    if (!annotEl) return select(null);
    if (annotEl.classList.contains('editing')) return;
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

  if (DRAW_TOOLS.has(tool)) startDraw(e, i, tool);
}

function translate(a, orig, dx, dy) {
  if (a.type === 'pen') a.points = orig.points.map(([x, y]) => [x + dx, y + dy]);
  else if (a.type === 'line' || a.type === 'arrow') {
    Object.assign(a, { x1: orig.x1 + dx, y1: orig.y1 + dy, x2: orig.x2 + dx, y2: orig.y2 + dy });
  } else Object.assign(a, { x: orig.x + dx, y: orig.y + dy });
}

function resize(a, orig, dx, dy, free) {
  if (a.type === 'text') {
    a.size = Math.round(clamp((orig.size * (orig.w + dx)) / orig.w, 4, 400));
  } else if (a.type === 'image' && !free) {
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
  trackPointer(e, state.views[i].annots, (ev) => {
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
  const color = tool === 'whiteout' ? '#ffffff' : colorInput.value;
  const width = Number(widthInput.value);
  const a = { id: uid(), type: tool, color, width };
  if (tool === 'pen') a.points = [[p0.x, p0.y]];
  else if (tool === 'line' || tool === 'arrow') Object.assign(a, { x1: p0.x, y1: p0.y, x2: p0.x, y2: p0.y });
  else Object.assign(a, { x: p0.x, y: p0.y, w: 0, h: 0 });

  const layer = state.views[i].annots;
  let el = null;
  trackPointer(e, layer, (ev) => {
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
    pushUndo();
    annotsOf(i).push(a);
    renderAnnotations(i);
    markDirty();
  });
}

function editText(i, id, before, isNew = false, at = null) {
  const a = findAnnot(i, id);
  if (!a) return;
  select({ page: i, id });
  const el = state.views[i].annots.querySelector(`[data-id="${id}"]`);
  if (!el) return;
  const content = el.querySelector('.content');
  const original = a.text;
  el.classList.add('editing');
  viewerEl.classList.add('text-editing');
  content.contentEditable = 'plaintext-only';
  content.focus();
  // Put the caret where the user clicked; fall back to the end of the text.
  let range = null;
  if (at) {
    const pos = document.caretPositionFromPoint?.(at.x, at.y);
    if (pos && content.contains(pos.offsetNode)) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
    }
  }
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
  }
  getSelection().removeAllRanges();
  getSelection().addRange(range);

  const onInput = () => measureText(el, a);
  const onKey = (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey))) content.blur();
  };
  content.addEventListener('input', onInput);
  content.addEventListener('keydown', onKey);
  content.addEventListener('blur', () => {
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
    box.innerHTML = `<h2>Create signature</h2>
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

    const use = (sig) => {
      state.pendingImage = sig;
      state.lastSignature = sig;
      close(true);
      toast('Click on a page to place your signature');
    };
    const submit = async () => {
      if (tab === 'draw') {
        if (empty) return toast('Draw a signature first');
        return use(trimCanvas(canvas));
      }
      const name = nameInput.value.trim();
      if (!name) return toast('Type your name first');
      await loadSignatureFonts().catch(() => {});
      use(renderTypedSignature(name, family, ink()));
    };
    const actions = box.querySelector('.actions');
    if (state.lastSignature) {
      actions.append(button('Use previous', 'secondary', () => use(state.lastSignature)));
    }
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
  state.lineCache.set(page, result);
  return result;
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
  const lines = [...(await pageLines(i)), ...ocrLines(i)];
  if (state.views[i] !== v || state.tool !== 'edittext') return;
  const s = state.scale;
  v.editLayer.replaceChildren(...lines.map((line) => {
    const el = div('textline');
    Object.assign(el.style, {
      left: `${(line.box.x - 1) * s}px`, top: `${(line.box.y - 1) * s}px`,
      width: `${(line.box.w + 2) * s}px`, height: `${(line.box.h + 2) * s}px`,
    });
    el.title = line.source === 'ocr' ? 'Recognized text — click to edit' : 'Click to edit';
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
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

function beginTextEdit(i, line, at = null) {
  return enqueue(async () => {
    if (!canEdit()) return;
    const colors = sampleColors(i, line.box);
    const style = line.source === 'pdf' ? detectFont(i, line) : { font: 'sans', bold: false, italic: false };
    const size = Math.round(line.size * 10) / 10;
    const id = uid();
    const textAt = (text, bx, by) => ({
      id, type: 'text', text, size, color: colors.ink, ...style,
      x: bx - size * TEXT_PAD_X, y: by - size * (TEXT_PAD_Y + textBaseline(style)),
    });

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
      state.views.forEach((_, i) => renderEditLines(i));
      if (state.find) runFind(findInput.value);
    }
    const skippedNote = skipped ? ` Skipped ${skipped} page${skipped > 1 ? 's' : ''} that already had text.` : '';
    if (done) toast(`Recognized ${words} words on ${done} page${done > 1 ? 's' : ''}. The text is now searchable and editable.${skippedNote}`, { ms: 6000 });
    else if (!cancelled) toast(`No pages needed recognition.${skippedNote}`, { ms: 5000 });
  });
}

// ---- Form fields ---------------------------------------------------------------------

async function renderForms(i) {
  const v = state.views[i];
  const page = state.pages[i];
  if (!v.widgets) {
    const annots = await page.getAnnotations({ intent: 'display' });
    v.widgets = annots.filter((a) => a.subtype === 'Widget' && a.fieldName && !a.hidden && !a.pushButton);
  }
  if (state.views[i] !== v) return;
  const s = state.scale;
  const vp = page.getViewport({ scale: s });
  const els = [];
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

async function buildOutput() {
  if (isEditable(document.activeElement)) document.activeElement.blur();
  const doc = await PDFDocument.load(state.bytes, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fonts = new Map([['Helvetica', font]]);
  const fontFor = async (name) => {
    if (!fonts.has(name)) fonts.set(name, await doc.embedFont(name));
    return fonts.get(name);
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

    for (const a of paintOrder(list)) {
      switch (a.type) {
        case 'highlight':
          page.drawRectangle({ ...box(a), color: pdfColor(a.color), opacity: 0.4, blendMode: BlendMode.Multiply });
          break;
        case 'whiteout':
          page.drawRectangle({ ...box(a), color: pdfColor(a.color || '#ffffff') });
          break;
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
          const f = await fontFor(standardFontName(a));
          const origin = pt(a.x + a.size * TEXT_PAD_X, a.y + a.size * (TEXT_PAD_Y + textBaseline(a)));
          page.drawText(encodable(f, a.text), {
            ...origin, size: a.size, font: f, color: pdfColor(a.color), lineHeight: a.size * 1.2, rotate,
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
  }
  return doc.save();
}

function save({ saveAs = false } = {}) {
  return enqueue(async () => {
    if (!state.pdf) return false;
    if (state.readOnly) {
      toast('This PDF is protected and can’t be saved with edits.', { error: true });
      return false;
    }
    const out = await buildOutput();
    const res = !saveAs && state.filePath ? await api.write(state.filePath, out) : await api.saveAs(out, state.fileName);
    if (!res) return false;
    state.filePath = res.path;
    state.fileName = res.name;
    state.dirty = false;
    updateUI();
    toast(`Saved ${res.name}`);
    return true;
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
  open: () => enqueue(openFromDialog),
  save: () => save(),
  'save-as': () => save({ saveAs: true }),
  'save-and-close': async () => {
    if (await save()) api.forceClose();
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

api.onMenu((action) => {
  if (!state.pdf && !['open', 'toggle-sidebar'].includes(action)) return;
  actions[action]?.();
});
api.onOpenPath((p) => enqueue(() => openPath(p)));

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]');
  if (b && !b.disabled) actions[b.dataset.action]?.();
  const t = e.target.closest('[data-tool]');
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

const TOOL_KEYS = { v: 'select', x: 'edittext', t: 'text', p: 'pen', h: 'highlight', r: 'rect', e: 'ellipse', l: 'line', a: 'arrow', w: 'whiteout', i: 'image', s: 'signature' };
document.addEventListener('keydown', (e) => {
  if (isEditable(e.target) || !$('#modal').hidden || !state.pdf) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const sel = selectedAnnot();
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
  enqueue(async () => {
    if (filePath) return openPath(filePath);
    if (!(await confirmDiscard())) return;
    await openDocument({ data: new Uint8Array(await file.arrayBuffer()), name: file.name });
  });
});

viewerEl.dataset.tool = 'select';
$('[data-tool="select"]').classList.add('active');
updateUI();

// Exposed for debugging from DevTools.
window.agility = { state, buildOutput, openPath: (p) => enqueue(() => openPath(p)) };
