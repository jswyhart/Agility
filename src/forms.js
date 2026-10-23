// Form authoring: detecting fillable areas on flat forms, tab order, and field
// properties. Everything here works on a pdf-lib document in user space.

import { pageShapes } from './textedit.js';

const {
  PDFName, PDFDict, PDFArray, PDFHexString, TextAlignment, rgb,
  PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFSignature,
} = window.PDFLib;

// (Class names are minified in the browser build, so test with instanceof.)
const kindOf = (field) => (field instanceof PDFTextField ? 'Text' : field instanceof PDFCheckBox ? 'CheckBox'
  : field instanceof PDFDropdown ? 'Dropdown' : field instanceof PDFOptionList ? 'OptionList'
    : field instanceof PDFRadioGroup ? 'RadioGroup' : field instanceof PDFSignature ? 'Signature' : 'Button');

const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const area = (b) => b.w * b.h;

/**
 * Suggest form fields for page i of `doc`:
 *  - lines (painted strokes, or thin filled bars) at least 40pt long → text fields above them;
 *  - boxes 6–18pt square → checkboxes; wider boxes 12–60pt tall → text fields inside them;
 *  - runs of underscores in the text → text fields over them.
 * `textLines` are pdf.js text lines in user space ({ x, y, length, size, text }),
 * `existing` the boxes of fields already on the page. Returns
 * [{ kind: 'text' | 'checkbox', box: {x, y, w, h}, multiline, label }].
 */
export function detectFields(doc, i, textLines, existing) {
  const found = [];
  const textBoxes = textLines.map((l) => ({ x: l.x, y: l.y - l.size * 0.25, w: l.length, h: l.size * 1.1, line: l }));
  const add = (cand) => {
    const b = cand.box;
    if (b.w < 6 || b.h < 6) return;
    if (existing.some((e) => overlaps(e, b))) return;
    if (found.some((f) => overlaps(f.box, b) && area(f.box) * 0.5 < area(b))) return; // duplicate
    found.push(cand);
  };

  for (const s of pageShapes(doc, i)) {
    const box = { x: s.box.x0, y: s.box.y0, w: s.box.x1 - s.box.x0, h: s.box.y1 - s.box.y0 };
    const isLine = (s.kind === 'line' && box.h < 1.5) || (s.kind === 'rect' && box.h < 2 && box.w >= 40);
    if (isLine && box.w >= 40) {
      // Space above the line, unless text already sits there (a heading rule).
      const field = { x: box.x, y: box.y + 1, w: box.w, h: 16 };
      if (!textBoxes.some((t) => overlaps(t, field) && t.x > field.x + 4)) add({ kind: 'text', box: field });
    } else if (s.kind === 'rect' && box.w >= 6 && box.w <= 18 && Math.abs(box.w - box.h) < 2) {
      add({ kind: 'checkbox', box });
    } else if (s.kind === 'rect' && box.w >= 40 && box.h >= 12 && box.h <= 120 && s.stroked) {
      const inner = { x: box.x + 1, y: box.y + 1, w: box.w - 2, h: box.h - 2 };
      if (!textBoxes.some((t) => overlaps(t, inner))) add({ kind: 'text', box: inner, multiline: box.h > 40 });
    }
  }
  for (const l of textLines) {
    const m = /_{4,}/.exec(l.text);
    if (!m) continue;
    const cw = l.length / l.text.length;
    const before = l.text.slice(0, m.index).replace(/[:*\s]+$/, '').trim();
    add({ kind: 'text', box: { x: l.x + m.index * cw, y: l.y - 2, w: m[0].length * cw, h: l.size + 4 }, label: before || null });
  }

  // Name each field after its label: a checkbox's is usually to its right, other
  // fields' to their left on the same line, or just above.
  for (const f of found) {
    if (f.label) continue;
    const b = f.box;
    const mid = b.y + b.h / 2;
    const right = f.kind === 'checkbox' && textLines
      .filter((l) => Math.abs(l.y + l.size * 0.35 - mid) < l.size && l.x >= b.x + b.w - 2 && l.x - (b.x + b.w) < 30)
      .sort((p, q) => p.x - q.x)[0];
    const left = textLines
      .filter((l) => Math.abs(l.y - (b.y + 3)) < l.size && l.x + l.length <= b.x + 2 && b.x - (l.x + l.length) < 160)
      .sort((p, q) => q.x - p.x)[0];
    const above = textLines
      .filter((l) => l.y > b.y + b.h && l.y - (b.y + b.h) < 24 && l.x < b.x + b.w && l.x + l.length > b.x)
      .sort((p, q) => p.y - q.y)[0];
    const label = (right || left || (f.kind === 'checkbox' ? null : above))?.text.replace(/_{2,}.*$/, '').replace(/[:*\s]+$/, '').trim();
    f.label = label || null;
  }
  return found;
}

/** Add detected fields to the document's form, naming them uniquely. */
export function addFields(doc, i, fields) {
  const form = doc.getForm();
  const page = doc.getPage(i);
  const used = new Set(form.getFields().map((f) => f.getName()));
  const unique = (base) => {
    let name = (base || 'Field').replace(/[.\s]+/g, ' ').trim().slice(0, 40) || 'Field';
    for (let n = 2; used.has(name); n++) name = `${base || 'Field'} ${n}`;
    used.add(name);
    return name;
  };
  for (const f of fields) {
    const look = { x: f.box.x, y: f.box.y, width: f.box.w, height: f.box.h, borderWidth: 0, backgroundColor: rgb(0.93, 0.95, 1) };
    if (f.kind === 'checkbox') form.createCheckBox(unique(f.label || 'Check')).addToPage(page, { ...look, borderWidth: 1, borderColor: rgb(0.4, 0.4, 0.45) });
    else {
      const field = form.createTextField(unique(f.label || 'Text'));
      if (f.multiline) field.enableMultiline();
      field.addToPage(page, look);
    }
  }
}

/**
 * Order a page's fields for Tab: 'rows' (top to bottom, left to right),
 * 'columns' (left to right, top to bottom) or 'structure' (tagged order).
 */
export function setTabOrder(doc, i, mode) {
  const page = doc.getPage(i);
  page.node.set(PDFName.of('Tabs'), PDFName.of(mode === 'columns' ? 'C' : mode === 'structure' ? 'S' : 'R'));
  if (mode === 'structure') return;
  const annots = page.node.Annots();
  if (!annots) return;
  const items = annots.asArray().map((ref) => {
    const dict = doc.context.lookup(ref, PDFDict);
    const r = dict.lookupMaybe(PDFName.of('Rect'), PDFArray)?.asArray().map((n) => n.asNumber());
    const isWidget = dict.get(PDFName.of('Subtype'))?.toString() === '/Widget';
    return { ref, isWidget, x: r ? Math.min(r[0], r[2]) : 0, top: r ? Math.max(r[1], r[3]) : 0 };
  });
  const widgets = items.filter((it) => it.isWidget);
  // Same row when tops are within 6pt.
  widgets.sort(mode === 'columns'
    ? (a, b) => (Math.abs(a.x - b.x) < 6 ? b.top - a.top : a.x - b.x)
    : (a, b) => (Math.abs(a.top - b.top) < 6 ? a.x - b.x : b.top - a.top));
  page.node.set(PDFName.of('Annots'), doc.context.obj([...widgets, ...items.filter((it) => !it.isWidget)].map((it) => it.ref)));
}

/** Current properties of a field, for the properties dialog. */
export function fieldInfo(doc, name) {
  const form = doc.getForm();
  const field = form.getField(name);
  const kind = kindOf(field);
  const dict = field.acroField.dict;
  const info = {
    name,
    kind, // TextField → "Text", CheckBox, Dropdown, OptionList, RadioGroup, Button, Signature
    tooltip: dict.lookupMaybe(PDFName.of('TU'), PDFHexString)?.decodeText() ?? dict.get(PDFName.of('TU'))?.decodeText?.() ?? '',
    required: field.isRequired(),
    readOnly: field.isReadOnly(),
  };
  if (kind === 'Text') {
    Object.assign(info, { value: field.getText() || '', multiline: field.isMultiline(), maxLength: field.getMaxLength() ?? '', alignment: field.getAlignment() });
  }
  if (kind === 'Dropdown' || kind === 'OptionList') Object.assign(info, { options: field.getOptions(), value: field.getSelected()[0] || '' });
  if (kind === 'CheckBox') info.value = field.isChecked();
  return info;
}

/** Apply edited properties (see fieldInfo) to the field named `name`. */
export function applyFieldInfo(doc, name, next) {
  const form = doc.getForm();
  const field = form.getField(name);
  const dict = field.acroField.dict;
  if (next.delete) return form.removeField(field);
  if (next.tooltip) dict.set(PDFName.of('TU'), PDFHexString.fromText(next.tooltip));
  else dict.delete(PDFName.of('TU'));
  next.required ? field.enableRequired() : field.disableRequired();
  next.readOnly ? field.enableReadOnly() : field.disableReadOnly();
  if (next.kind === 'Text') {
    next.multiline ? field.enableMultiline() : field.disableMultiline();
    if (next.maxLength) field.setMaxLength(Number(next.maxLength));
    else field.removeMaxLength();
    if (next.fontSize) field.setFontSize(Number(next.fontSize));
    field.setAlignment(Number(next.alignment) || TextAlignment.Left);
    field.setText(next.value || undefined);
  }
  if ((next.kind === 'Dropdown' || next.kind === 'OptionList') && next.options?.length) {
    field.setOptions(next.options);
    if (next.value && next.options.includes(next.value)) field.select(next.value);
  }
  if (next.kind === 'CheckBox') (next.value ? field.check() : field.uncheck());
  // Renaming: the partial name (/T) of the field itself.
  if (next.name && next.name !== name) dict.set(PDFName.of('T'), PDFHexString.fromText(next.name));
}
