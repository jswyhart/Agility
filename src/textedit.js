// Removes text from a page's content stream so it can be replaced.
//
// The page content is tokenised and run through a small text-state interpreter
// that tracks where each text-showing operator (Tj, TJ, ', ") starts and ends in
// user space. Operators that fall on the target line are replaced by an empty
// TJ with the same advance, so any text that follows on the line stays put.

const { PDFName, PDFArray, PDFDict, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream, StandardFontEmbedder } = window.PDFLib;

// WinAnsi codes 128–159 that differ from Latin-1.
const WIN_ANSI_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
const STANDARD_ALIASES = [
  [/^(helvetica|arial)(mt)?$/, 'Helvetica'], [/^(helvetica|arial)(mt)?,?-?bold(mt)?$/, 'Helvetica-Bold'],
  [/^(helvetica|arial)(mt)?,?-?(italic|oblique)(mt)?$/, 'Helvetica-Oblique'], [/^(helvetica|arial)(mt)?,?-?bold(italic|oblique)(mt)?$/, 'Helvetica-BoldOblique'],
  [/^times(newroman)?(ps)?(mt)?(-roman)?$/, 'Times-Roman'], [/^times(newroman)?(ps)?,?-?bold(mt)?$/, 'Times-Bold'],
  [/^times(newroman)?(ps)?,?-?italic(mt)?$/, 'Times-Italic'], [/^times(newroman)?(ps)?,?-?bolditalic(mt)?$/, 'Times-BoldItalic'],
  [/^courier(new)?(ps)?(mt)?$/, 'Courier'], [/^courier(new)?(ps)?,?-?bold(mt)?$/, 'Courier-Bold'],
  [/^courier(new)?(ps)?,?-?(italic|oblique)(mt)?$/, 'Courier-Oblique'], [/^courier(new)?(ps)?,?-?bold(italic|oblique)(mt)?$/, 'Courier-BoldOblique'],
  [/^symbol$/, 'Symbol'], [/^zapfdingbats$/, 'ZapfDingbats'],
];

// Metrics for the 14 standard fonts, which PDFs may use without a /Widths array.
function standardWidths(baseFont) {
  const key = baseFont.replace(/^\/?([A-Z]{6}\+)?/, '').toLowerCase().replace(/\s+/g, '');
  const match = STANDARD_ALIASES.find(([re]) => re.test(key));
  if (!match) return null;
  const embedder = StandardFontEmbedder.for(match[1]);
  const cache = new Map();
  return (code) => {
    if (!cache.has(code)) {
      const ch = code >= 128 && code < 160 ? WIN_ANSI_HIGH[code - 128] : String.fromCharCode(code);
      let w;
      try {
        w = embedder.widthOfTextAtSize(ch, 1000);
      } catch {
        w = 500;
      }
      cache.set(code, w);
    }
    return cache.get(code);
  };
}

// ---- Tokeniser ----------------------------------------------------------------

const isWS = (c) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const DELIMS = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));
const isDelim = (c) => DELIMS.has(c);

function readLiteral(b, i) {
  // b[i] === '('
  const out = [];
  let depth = 1;
  i++;
  while (i < b.length) {
    const c = b[i];
    if (c === 0x5c) {
      const n = b[++i];
      const map = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 };
      if (n in map) out.push(map[n]);
      else if (n >= 0x30 && n <= 0x37) {
        let v = n - 0x30;
        for (let k = 0; k < 2 && b[i + 1] >= 0x30 && b[i + 1] <= 0x37; k++) v = v * 8 + (b[++i] - 0x30);
        out.push(v & 255);
      } else if (n === 13) {
        if (b[i + 1] === 10) i++;
      } else if (n !== 10) out.push(n);
      i++;
      continue;
    }
    if (c === 0x28) depth++;
    if (c === 0x29 && --depth === 0) return [new Uint8Array(out), i + 1];
    out.push(c);
    i++;
  }
  return [new Uint8Array(out), i];
}

function readHex(b, i) {
  const digits = [];
  i++;
  while (i < b.length && b[i] !== 0x3e) {
    if (!isWS(b[i])) digits.push(b[i]);
    i++;
  }
  if (digits.length % 2) digits.push(0x30);
  const out = new Uint8Array(digits.length / 2);
  for (let k = 0; k < out.length; k++) out[k] = parseInt(String.fromCharCode(digits[2 * k], digits[2 * k + 1]), 16);
  return [out, i + 1];
}

function tokenize(b) {
  const tokens = [];
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (isWS(c)) { i++; continue; }
    if (c === 0x25) { while (i < b.length && b[i] !== 10 && b[i] !== 13) i++; continue; } // comment
    const start = i;
    if (c === 0x28) {
      const [v, j] = readLiteral(b, i);
      tokens.push({ t: 'str', v, start, end: (i = j) });
    } else if (c === 0x3c && b[i + 1] === 0x3c) {
      tokens.push({ t: '<<', start, end: (i += 2) });
    } else if (c === 0x3e && b[i + 1] === 0x3e) {
      tokens.push({ t: '>>', start, end: (i += 2) });
    } else if (c === 0x3c) {
      const [v, j] = readHex(b, i);
      tokens.push({ t: 'str', v, start, end: (i = j) });
    } else if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) {
      tokens.push({ t: String.fromCharCode(c), start, end: ++i });
    } else if (c === 0x2f) {
      i++;
      while (i < b.length && !isWS(b[i]) && !isDelim(b[i])) i++;
      tokens.push({ t: 'name', v: String.fromCharCode(...b.subarray(start + 1, i)), start, end: i });
    } else {
      while (i < b.length && !isWS(b[i]) && !isDelim(b[i])) i++;
      if (i === start) i++; // stray delimiter
      const word = String.fromCharCode(...b.subarray(start, i));
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) tokens.push({ t: 'num', v: parseFloat(word), start, end: i });
      else {
        tokens.push({ t: 'op', v: word, start, end: i });
        if (word === 'ID') {
          // Inline image data: skip raw bytes up to "EI" surrounded by whitespace.
          i++;
          while (i < b.length && !(isWS(b[i - 1]) && b[i] === 0x45 && b[i + 1] === 0x49 && (i + 2 >= b.length || isWS(b[i + 2])))) i++;
        }
      }
    }
  }
  return tokens;
}

// Group tokens into operations: { op, args, start, end }.
function parseOps(bytes) {
  const tokens = tokenize(bytes);
  const ops = [];
  let args = [];
  let argStart = null;
  const stack = [];
  for (const tok of tokens) {
    if (argStart === null) argStart = tok.start;
    if (tok.t === '[') { stack.push([]); continue; }
    if (tok.t === ']') {
      const arr = stack.pop() || [];
      (stack.length ? stack[stack.length - 1] : args).push(arr);
      continue;
    }
    if (tok.t === '<<' || tok.t === '>>' || tok.t === '{' || tok.t === '}') continue;
    if (tok.t !== 'op') {
      const val = tok.t === 'str' ? { str: tok.v } : tok.t === 'name' ? { name: tok.v } : tok.v;
      (stack.length ? stack[stack.length - 1] : args).push(val);
      continue;
    }
    ops.push({ op: tok.v, args, start: argStart, end: tok.end });
    args = [];
    argStart = null;
    stack.length = 0;
  }
  return ops;
}

// ---- Fonts ----------------------------------------------------------------------

function num(obj, fallback = 0) {
  return obj instanceof PDFNumber ? obj.asNumber() : fallback;
}

function fontMetrics(fontDict) {
  if (!(fontDict instanceof PDFDict)) return { twoByte: false, width: () => 500 };
  const subtype = fontDict.lookup(PDFName.of('Subtype'))?.toString();
  if (subtype === '/Type0') {
    const desc = fontDict.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)?.lookup(0, PDFDict);
    const dw = num(desc?.lookup(PDFName.of('DW')), 1000);
    const widths = new Map();
    const w = desc?.lookup(PDFName.of('W'));
    if (w instanceof PDFArray) {
      const items = w.asArray().map((x) => desc.context.lookup(x));
      for (let k = 0; k < items.length;) {
        const first = num(items[k]);
        const next = items[k + 1];
        if (next instanceof PDFArray) {
          next.asArray().forEach((x, j) => widths.set(first + j, num(desc.context.lookup(x))));
          k += 2;
        } else {
          const last = num(next);
          const width = num(items[k + 2]);
          for (let c = first; c <= last; c++) widths.set(c, width);
          k += 3;
        }
      }
    }
    return { twoByte: true, width: (code) => widths.get(code) ?? dw };
  }
  const first = num(fontDict.lookup(PDFName.of('FirstChar')));
  const arr = fontDict.lookup(PDFName.of('Widths'));
  const widths = arr instanceof PDFArray ? arr.asArray().map((x) => num(fontDict.context.lookup(x))) : null;
  const descriptor = fontDict.lookup(PDFName.of('FontDescriptor'));
  const missing = descriptor instanceof PDFDict ? num(descriptor.lookup(PDFName.of('MissingWidth'))) : 0;
  const base = fontDict.lookup(PDFName.of('BaseFont'))?.toString() || '';
  // Type 3 glyph widths are in glyph space; scale them by the FontMatrix.
  const fm = fontDict.lookup(PDFName.of('FontMatrix'));
  const scale = subtype === '/Type3' && fm instanceof PDFArray ? num(fm.lookup(0)) * 1000 : 1;
  const standard = widths ? null : standardWidths(base);
  const fallback = /courier|mono/i.test(base) ? 600 : 500;
  return {
    twoByte: false,
    width: (code) => {
      if (widths && code >= first && code < first + widths.length) return widths[code - first] * scale;
      if (standard) return standard(code);
      return widths ? missing || fallback : fallback;
    },
  };
}

// ---- Interpreter -------------------------------------------------------------------

const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const boxOf = (m, x0, y0, x1, y1) => {
  const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};

// Returns every text-showing operation with its user-space start/end points.
// With glyphs: true each run also lists its parts: { kern } numbers and
// { bytes, adv, box } glyphs (box in user space). runs.draws lists images and
// form XObjects with their user-space boxes.
function interpret(ops, fonts, { glyphs = false } = {}) {
  const runs = [];
  runs.draws = [];
  runs.shapes = []; // painted rectangles and straight lines: { kind: 'rect' | 'line', box, stroked }
  let path = [];
  let point = null;
  let gs = { ctm: [1, 0, 0, 1, 0, 0], Tc: 0, Tw: 0, Th: 1, TL: 0, font: null, Tfs: 0, Ts: 0, Tr: 0 };
  const stack = [];
  let Tm = [1, 0, 0, 1, 0, 0];
  let Tlm = Tm;
  const metricsCache = new Map();
  const metrics = (name) => {
    if (!metricsCache.has(name)) metricsCache.set(name, fontMetrics(fonts?.lookup(PDFName.of(name))));
    return metricsCache.get(name);
  };
  const nextLine = (tx, ty) => {
    Tlm = mul([1, 0, 0, 1, tx, ty], Tlm);
    Tm = Tlm;
  };
  // Advance across one string; returns the horizontal displacement in text space.
  const advance = (bytes) => {
    const m = metrics(gs.font);
    let tx = 0;
    const step = m.twoByte ? 2 : 1;
    for (let k = 0; k + step - 1 < bytes.length; k += step) {
      const code = m.twoByte ? (bytes[k] << 8) | bytes[k + 1] : bytes[k];
      const w0 = m.width(code) / 1000;
      tx += (w0 * gs.Tfs + gs.Tc + (!m.twoByte && code === 32 ? gs.Tw : 0)) * gs.Th;
    }
    return tx;
  };

  ops.forEach((o, index) => {
    const a = o.args;
    switch (o.op) {
      case 'q': stack.push({ ...gs }); break;
      case 'Q': if (stack.length) gs = stack.pop(); break;
      case 'cm': if (a.length === 6) gs.ctm = mul(a, gs.ctm); break;
      case 'BT': Tm = Tlm = [1, 0, 0, 1, 0, 0]; break;
      case 'Tc': gs.Tc = a[0] ?? 0; break;
      case 'Tw': gs.Tw = a[0] ?? 0; break;
      case 'Tz': gs.Th = (a[0] ?? 100) / 100; break;
      case 'TL': gs.TL = a[0] ?? 0; break;
      case 'Ts': gs.Ts = a[0] ?? 0; break;
      case 'Tr': gs.Tr = a[0] ?? 0; break;
      case 'Tf': gs.font = a[0]?.name; gs.Tfs = a[1] ?? 0; break;
      case 'Td': nextLine(a[0] ?? 0, a[1] ?? 0); break;
      case 'TD': gs.TL = -(a[1] ?? 0); nextLine(a[0] ?? 0, a[1] ?? 0); break;
      case 'Tm': if (a.length === 6) Tm = Tlm = a.slice(); break;
      case 'T*': nextLine(0, -gs.TL); break;
      case 'Do':
        if (a[0]?.name) runs.draws.push({ name: a[0].name, box: boxOf(gs.ctm, 0, 0, 1, 1) });
        break;
      case 're':
        if (a.length === 4) path.push({ kind: 'rect', box: boxOf(gs.ctm, a[0], a[1], a[0] + a[2], a[1] + a[3]) });
        break;
      case 'm':
        point = a.length === 2 ? a.slice() : null;
        break;
      case 'l':
        if (point && a.length === 2) path.push({ kind: 'line', box: boxOf(gs.ctm, point[0], point[1], a[0], a[1]) });
        point = a.length === 2 ? a.slice() : null;
        break;
      case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*':
        for (const shape of path) runs.shapes.push({ ...shape, stroked: /^[SsBb]/.test(o.op) });
        path = [];
        point = null;
        break;
      case 'n':
        path = [];
        point = null;
        break;
      case 'EI':
        runs.draws.push({ inline: true, box: boxOf(gs.ctm, 0, 0, 1, 1) });
        break;
      case "'": case '"': case 'Tj': case 'TJ': {
        if (o.op === '"') { gs.Tw = a[0] ?? 0; gs.Tc = a[1] ?? 0; }
        if (o.op === "'" || o.op === '"') nextLine(0, -gs.TL);
        const m0 = mul(Tm, gs.ctm);
        const [x0, y0] = apply(m0, 0, gs.Ts);
        let total = 0;
        const parts = o.op === 'TJ' ? (Array.isArray(a[0]) ? a[0] : []) : [a[a.length - 1]];
        const detail = glyphs ? [] : null;
        for (const p of parts) {
          if (typeof p === 'number') {
            total -= (p / 1000) * gs.Tfs * gs.Th;
            detail?.push({ kern: p });
          } else if (p?.str) {
            if (!detail) {
              total += advance(p.str);
              continue;
            }
            // One glyph at a time, so each can be kept or dropped.
            const m = metrics(gs.font);
            const step = m.twoByte ? 2 : 1;
            for (let k = 0; k + step - 1 < p.str.length; k += step) {
              const code = m.twoByte ? (p.str[k] << 8) | p.str[k + 1] : p.str[k];
              const w = (m.width(code) / 1000) * gs.Tfs * gs.Th;
              const adv = w + (gs.Tc + (!m.twoByte && code === 32 ? gs.Tw : 0)) * gs.Th;
              const box = boxOf(m0, total, gs.Ts - 0.25 * gs.Tfs, total + Math.max(w, 0.01), gs.Ts + 0.85 * gs.Tfs);
              detail.push({ bytes: p.str.subarray(k, k + step), adv, box });
              total += adv;
            }
          }
        }
        Tm = mul([1, 0, 0, 1, total, 0], Tm);
        const [x1, y1] = apply(mul(Tm, gs.ctm), 0, gs.Ts);
        const size = Math.hypot(m0[2], m0[3]) * gs.Tfs;
        runs.push({ index, x0, y0, x1, y1, total, Tfs: gs.Tfs, Th: gs.Th, size, font: gs.font, invisible: gs.Tr === 3 || gs.Tr === 7, parts: detail });
        break;
      }
    }
  });
  return runs;
}

// ---- Public API ------------------------------------------------------------------

function contentStreams(page) {
  const contents = page.node.Contents();
  if (!contents) return [];
  const list = contents instanceof PDFArray ? contents.asArray().map((r) => page.doc.context.lookup(r)) : [contents];
  return list.filter(Boolean);
}

function streamBytes(stream) {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  if (typeof stream.getUnencodedContents === 'function') return stream.getUnencodedContents();
  return stream.getContents();
}

function readPageContent(page) {
  const chunks = contentStreams(page).map(streamBytes);
  const length = chunks.reduce((n, c) => n + c.length + 1, 0);
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    bytes[at + c.length] = 10;
    at += c.length + 1;
  }
  return bytes;
}

/**
 * Find (and unless dryRun, remove) text runs along a line.
 * target: { x, y, dx, dy, length, size } — baseline origin, unit direction and
 * length of the line in user space, plus the font size (for tolerance).
 * Returns { removed, from, to, invisible, fontKey } where from/to bound the
 * matched runs along the line (relative to the target origin) and fontKey is the
 * page font resource the line starts in.
 */
export function removeTextLine(doc, pageIndex, target, { dryRun = false } = {}) {
  const page = doc.getPage(pageIndex);
  const bytes = readPageContent(page);
  const ops = parseOps(bytes);
  const fonts = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
  const runs = interpret(ops, fonts);

  const { x, y, dx, dy, length, size } = target;
  const tolPerp = Math.max(1, size * 0.45);
  const along = (px, py) => (px - x) * dx + (py - y) * dy;
  const perp = (px, py) => (px - x) * -dy + (py - y) * dx;
  const hits = runs.filter((r) => {
    const len = Math.hypot(r.x1 - r.x0, r.y1 - r.y0);
    if (len > 0.01 && ((r.x1 - r.x0) * dx + (r.y1 - r.y0) * dy) / len < 0.98) return false; // other direction
    if (Math.abs(perp(r.x0, r.y0)) > tolPerp) return false;
    const a0 = along(r.x0, r.y0);
    const a1 = along(r.x1, r.y1);
    return a1 > 0.5 && a0 < length - 0.5; // overlaps the line
  });
  if (!hits.length) return { removed: 0 };
  const from = Math.min(...hits.map((r) => along(r.x0, r.y0)));
  const to = Math.max(...hits.map((r) => along(r.x1, r.y1)));
  const invisible = hits.every((r) => r.invisible);
  const fontKey = hits[0].font;
  if (dryRun) return { removed: hits.length, from, to, invisible, fontKey };

  // Rebuild the stream, swapping each hit for an equivalent empty move.
  const enc = new TextEncoder();
  const parts = [];
  let cursor = 0;
  const fmt = (n) => (Math.abs(n) < 1e-6 ? '0' : n.toFixed(4).replace(/\.?0+$/, ''));
  for (const r of hits) {
    const o = ops[r.index];
    parts.push(bytes.subarray(cursor, o.start));
    const kern = r.Tfs && r.Th ? (-r.total * 1000) / (r.Tfs * r.Th) : 0;
    let repl = `[${fmt(kern)}] TJ`;
    if (o.op === "'") repl = `T* ${repl}`;
    if (o.op === '"') repl = `${fmt(o.args[0] ?? 0)} Tw ${fmt(o.args[1] ?? 0)} Tc T* ${repl}`;
    parts.push(enc.encode(` ${repl} `));
    cursor = o.end;
  }
  parts.push(bytes.subarray(cursor));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  const ref = doc.context.register(doc.context.flateStream(out));
  page.node.set(PDFName.of('Contents'), ref);
  return { removed: hits.length, from, to, invisible, fontKey };
}


const intersects = (b, r) => b.x0 < r.x + r.width && b.x1 > r.x && b.y0 < r.y + r.height && b.y1 > r.y;

/**
 * Permanently remove the text under some user-space rectangles ({x, y, width, height}).
 * Only the glyphs inside are taken out (each replaced by an equal move, so the
 * rest of the line stays put). Returns { glyphs, complex }, where complex means an
 * image or embedded form object also lies under a rectangle, which needs the
 * page to be rasterized to remove it.
 */
export function redactText(doc, pageIndex, rects) {
  const page = doc.getPage(pageIndex);
  const bytes = readPageContent(page);
  const ops = parseOps(bytes);
  const resources = page.node.Resources();
  const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
  const runs = interpret(ops, fonts, { glyphs: true });
  const complex = runs.draws.some((d) => rects.some((r) => intersects(d.box, r)));

  const enc = new TextEncoder();
  const hex = (b) => `<${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}>`;
  const fmt = (n) => (Math.abs(n) < 1e-6 ? '0' : n.toFixed(4).replace(/\.?0+$/, ''));
  const out = [];
  let cursor = 0;
  let removed = 0;
  for (const r of runs) {
    if (!r.parts?.some((g) => g.box && rects.some((rect) => intersects(g.box, rect)))) continue;
    const o = ops[r.index];
    const items = [];
    for (const g of r.parts) {
      if (!g.box) items.push(fmt(g.kern));
      else if (rects.some((rect) => intersects(g.box, rect))) {
        removed++;
        if (r.Tfs && r.Th) items.push(fmt((-g.adv * 1000) / (r.Tfs * r.Th)));
      } else items.push(hex(g.bytes));
    }
    let repl = `[${items.join(' ')}] TJ`;
    if (o.op === "'") repl = `T* ${repl}`;
    if (o.op === '"') repl = `${fmt(o.args[0] ?? 0)} Tw ${fmt(o.args[1] ?? 0)} Tc T* ${repl}`;
    out.push(bytes.subarray(cursor, o.start), enc.encode(` ${repl} `));
    cursor = o.end;
  }
  if (removed) {
    out.push(bytes.subarray(cursor));
    const total = out.reduce((n, p) => n + p.length, 0);
    const merged = new Uint8Array(total);
    let at = 0;
    for (const p of out) {
      merged.set(p, at);
      at += p.length;
    }
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(merged)));
  }
  return { glyphs: removed, complex };
}

/**
 * Delete every object nothing refers to any more. pdf-lib writes all objects it
 * holds, so content replaced by an edit or redaction would otherwise still be in
 * the saved file.
 */
export function collectGarbage(doc) {
  const { context } = doc;
  const seen = new Set();
  const visit = (obj) => {
    if (!obj) return;
    if (obj instanceof PDFRef) {
      const key = obj.toString();
      if (seen.has(key)) return;
      seen.add(key);
      visit(context.lookup(obj));
    } else if (obj instanceof PDFDict) {
      for (const [, v] of obj.entries()) visit(v);
    } else if (obj instanceof PDFArray) {
      for (const v of obj.asArray()) visit(v);
    } else if (obj?.dict instanceof PDFDict) {
      visit(obj.dict); // stream
    }
  };
  const t = context.trailerInfo;
  for (const root of [t.Root, t.Info, t.Encrypt]) visit(root);
  let deleted = 0;
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!seen.has(ref.toString())) {
      context.delete(ref);
      deleted++;
    }
  }
  return deleted;
}

/** Painted rectangles and straight lines on a page (user space), for form detection. */
export function pageShapes(doc, pageIndex) {
  const page = doc.getPage(pageIndex);
  const ops = parseOps(readPageContent(page));
  const fonts = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
  return interpret(ops, fonts).shapes;
}

// For tagging.js, which marks up the same content streams.
export { parseOps, interpret, readPageContent };