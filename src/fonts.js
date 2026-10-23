// Fonts for text Agility writes. In order of preference:
//   1. the document's own font (its embedded file, or the same font installed on
//      this computer) when it has every character of the text;
//   2. a bundled DejaVu font when the text needs characters outside Latin-1;
//   3. one of the PDF standard fonts.
// The same choice drives the on-screen preview and the saved file.

const { PDFName, PDFDict, PDFRawStream, decodePDFRawStream } = window.PDFLib;
const fontkit = window.fontkit;

// Characters the standard fonts can encode (WinAnsi).
const WIN_ANSI = new Set([
  ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
  ...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ',
  ...Array.from({ length: 96 }, (_, i) => String.fromCharCode(160 + i)),
  '\n', '\t',
]);
export const needsUnicode = (text) => [...text].some((ch) => !WIN_ANSI.has(ch));

const DEJAVU = {
  sans: ['DejaVuSans', 'DejaVuSans-Bold', 'DejaVuSans-Oblique', 'DejaVuSans-BoldOblique'],
  serif: ['DejaVuSerif', 'DejaVuSerif-Bold', 'DejaVuSerif-Italic', 'DejaVuSerif-BoldItalic'],
  mono: ['DejaVuSansMono', 'DejaVuSansMono-Bold', 'DejaVuSansMono-Oblique', 'DejaVuSansMono-BoldOblique'],
};
const dejavuName = (a) => DEJAVU[a.font || 'sans'][(a.bold ? 1 : 0) + (a.italic ? 2 : 0)];
const dejavuUrl = (name) => new URL(`../node_modules/dejavu-fonts-ttf/ttf/${name}.ttf`, import.meta.url).href;

const store = new Map(); // id -> { bytes, font, family, name }
const faces = new Map(); // css family -> load promise
let onLoaded = () => {};

/** Called whenever a preview font finishes loading (layouts need re-measuring). */
export function onFontLoaded(fn) {
  onLoaded = fn;
}

function ensureFace(family, source) {
  if (!faces.has(family)) {
    const face = new FontFace(family, source);
    faces.set(family, face.load().then((f) => {
      document.fonts.add(f);
      onLoaded();
    }).catch(() => {}));
  }
  return faces.get(family);
}

const covers = (font, text) => [...text].every((ch) => /\s/.test(ch) || font.hasGlyphForCodePoint(ch.codePointAt(0)));

/**
 * Which font a text box uses: { kind: 'custom' | 'dejavu' | 'standard', family? }.
 * family is a CSS font-family for the preview (variant baked into the file).
 */
export function fontChoice(a) {
  const text = a.text || '';
  const stored = a.docFont && store.get(a.docFont);
  if (stored && covers(stored.font, text)) return { kind: 'custom', id: a.docFont, family: stored.family };
  if (needsUnicode(text)) {
    const name = dejavuName(a);
    const family = `AG ${name}`;
    ensureFace(family, `url(${dejavuUrl(name)})`);
    return { kind: 'dejavu', name, family: `"${family}"` };
  }
  return { kind: 'standard' };
}

const dejavuBytes = new Map();
/** Bytes to embed for a non-standard choice. */
export async function fontBytes(choice) {
  if (choice.kind === 'custom') return store.get(choice.id).bytes;
  if (!dejavuBytes.has(choice.name)) {
    dejavuBytes.set(choice.name, fetch(dejavuUrl(choice.name)).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)));
  }
  return dejavuBytes.get(choice.name);
}

function parse(bytes) {
  try {
    const font = fontkit.create(bytes);
    return font.fonts ? null : font; // collections (.ttc) can't be embedded directly
  } catch {
    return null;
  }
}

// Waits for the preview font so text placed with it is measured correctly.
async function register(bytes, font, name) {
  const id = `f${store.size + 1}${Math.random().toString(36).slice(2, 6)}`;
  const family = `AG doc ${id}`;
  store.set(id, { bytes, font, family: `"${family}"`, name });
  await ensureFace(family, bytes);
  return id;
}

/** Make sure a choice's preview font is ready (before measuring text with it). */
export const fontReady = (choice) => (choice.family ? faces.get(choice.family.slice(1, -1)) : null);

const stripSubset = (name) => String(name || '').replace(/^\/?[A-Z]{6}\+/, '').replace(/^\//, '');

// A page font resource: its base name and, if fontkit can read it, the font program.
function pageFont(doc, pageIndex, key) {
  const fonts = doc.getPage(pageIndex).node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
  let dict = fonts?.lookupMaybe(PDFName.of(key), PDFDict);
  if (!dict) return null;
  const base = dict.lookup(PDFName.of('BaseFont'))?.toString() || '';
  const desc = dict.lookup(PDFName.of('DescendantFonts'));
  if (desc) dict = desc.lookup(0, PDFDict);
  const fd = dict.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
  // TrueType (FontFile2) or OpenType (FontFile3 /OpenType); bare CFF and Type 1 can't be re-embedded.
  let file = fd?.lookup(PDFName.of('FontFile2'));
  const ff3 = fd?.lookup(PDFName.of('FontFile3'));
  if (!file && ff3?.dict?.lookup(PDFName.of('Subtype'))?.toString() === '/OpenType') file = ff3;
  return {
    name: stripSubset(base),
    subset: /^\/[A-Z]{6}\+/.test(base),
    bytes: file instanceof PDFRawStream ? decodePDFRawStream(file).decode() : null,
  };
}

/**
 * Find a font matching a page font resource (fontKey), able to draw `text`.
 * Prefers the complete installed font over an embedded subset (a subset only has
 * the characters the document already used). Returns a font id or null.
 */
export async function captureFont(doc, pageIndex, fontKey, text, findInstalled) {
  const info = fontKey && pageFont(doc, pageIndex, fontKey);
  if (!info?.name) return null;
  const embeddedFont = info.bytes && parse(info.bytes);
  if (embeddedFont && !info.subset && covers(embeddedFont, text)) return register(info.bytes, embeddedFont, info.name);
  const installed = await findInstalled([info.name]).catch(() => null);
  const installedFont = installed && parse(installed.data);
  if (installedFont && covers(installedFont, text)) return register(installed.data, installedFont, info.name);
  if (embeddedFont && covers(embeddedFont, text)) return register(info.bytes, embeddedFont, info.name);
  return null;
}

export const fontName = (id) => store.get(id)?.name || null;
