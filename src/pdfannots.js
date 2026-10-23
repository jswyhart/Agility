// Markup as real PDF annotations.
//
// Highlights, shapes, ink, text boxes and comments are written as standard
// annotations (with appearance streams, so every viewer draws them the same) and
// carry Agility's own description in /AgilityData. When Agility reopens the file
// it turns those back into editable objects and takes them out of the page.

const {
  PDFName, PDFDict, PDFString, PDFHexString,
  drawRectangle, drawEllipse, drawLine, drawText, degrees, rgb,
  pushGraphicsState, popGraphicsState, setGraphicsState,
} = window.PDFLib;

const DATA_KEY = 'AgilityData';
const deg0 = degrees(0);

// Types written as annotations; everything else is drawn into the page.
export function isAnnotationType(a) {
  if (a.type === 'text') return !a.edit; // edited PDF text belongs in the content
  return ['markup', 'highlight', 'rect', 'ellipse', 'line', 'arrow', 'pen', 'note'].includes(a.type);
}

const pdfDate = (iso) => {
  const d = iso ? new Date(iso) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};

function hexColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Write one page's annotations.
 * ctx: { doc, page, vp, pt(x, y) -> {x, y}, fontFor(name) -> PDFFont, standardFontName(a),
 *        textBaseline(a), encodable(font, text), TEXT_PAD_X, TEXT_PAD_Y, arrowHead(a) }
 */
export async function writeAnnotations(ctx, list) {
  const { doc, page, vp } = ctx;
  const context = doc.context;
  const refs = new Map(); // annotation id -> ref, so replies can point at their parent
  const rotation = vp.rotation;
  const gsMultiply = context.obj({ Type: 'ExtGState', BM: 'Multiply', ca: 0.4, CA: 0.4 });

  const userBox = (r) => {
    const p = ctx.pt(r.x, r.y);
    const q = ctx.pt(r.x + r.w, r.y + r.h);
    return { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), width: Math.abs(q.x - p.x), height: Math.abs(q.y - p.y) };
  };
  const pad = (b, d) => ({ x: b.x - d, y: b.y - d, width: b.width + 2 * d, height: b.height + 2 * d });
  const rectArray = (b) => [b.x, b.y, b.x + b.width, b.y + b.height];

  const add = (a, subtype, rect, extra, ops, resources = {}) => {
    const appearance = context.register(context.formXObject(ops, { BBox: rectArray(rect), Resources: resources }));
    const dict = context.obj({
      Type: 'Annot',
      Subtype: subtype,
      Rect: rectArray(rect),
      F: 4,
      NM: PDFString.of(a.id),
      M: PDFString.of(pdfDate(a.date)),
      AP: { N: appearance },
      P: page.ref,
      ...extra,
    });
    if (a.color) dict.set(PDFName.of('C'), context.obj(hexColor(a.color)));
    if (a.author) dict.set(PDFName.of('T'), PDFHexString.fromText(a.author));
    const text = a.note ?? a.text;
    if (text) dict.set(PDFName.of('Contents'), PDFHexString.fromText(text));
    dict.set(PDFName.of(DATA_KEY), PDFHexString.fromText(JSON.stringify({ v: 1, rot: rotation, a })));
    const ref = context.register(dict);
    page.node.addAnnot(ref);
    refs.set(a.id, ref);
    return { ref, dict };
  };

  for (const a of list) {
    switch (a.type) {
      case 'markup':
      case 'highlight': {
        const rects = a.type === 'markup' ? a.rects : [a];
        const kind = a.type === 'markup' ? a.kind : 'highlight';
        const quads = [];
        const ops = [pushGraphicsState()];
        if (kind === 'highlight') ops.push(setGraphicsState('GS0'));
        for (const r of rects) {
          const ul = ctx.pt(r.x, r.y);
          const ur = ctx.pt(r.x + r.w, r.y);
          const ll = ctx.pt(r.x, r.y + r.h);
          const lr = ctx.pt(r.x + r.w, r.y + r.h);
          quads.push(ul.x, ul.y, ur.x, ur.y, ll.x, ll.y, lr.x, lr.y);
          if (kind === 'highlight') {
            ops.push(...drawRectangle({ ...userBox(r), color: rgb(...hexColor(a.color)), borderWidth: 0, rotate: deg0, xSkew: deg0, ySkew: deg0 }));
          } else {
            const f = kind === 'underline' ? 0.92 : 0.55;
            ops.push(...drawLine({
              start: ctx.pt(r.x, r.y + r.h * f), end: ctx.pt(r.x + r.w, r.y + r.h * f),
              thickness: Math.max(0.75, r.h * 0.07), color: rgb(...hexColor(a.color)),
            }));
          }
        }
        ops.push(popGraphicsState());
        const rect = pad(rects.map(userBox).reduce((p, q) => {
          const x = Math.min(p.x, q.x);
          const y = Math.min(p.y, q.y);
          return { x, y, width: Math.max(p.x + p.width, q.x + q.width) - x, height: Math.max(p.y + p.height, q.y + q.height) - y };
        }), 1);
        const subtype = { highlight: 'Highlight', underline: 'Underline', strike: 'StrikeOut' }[kind];
        add(a, subtype, rect, { QuadPoints: quads }, ops, kind === 'highlight' ? { ExtGState: { GS0: gsMultiply } } : {});
        break;
      }
      case 'rect':
      case 'ellipse': {
        const b = userBox(a);
        const color = rgb(...hexColor(a.color));
        const ops = a.type === 'rect'
          ? drawRectangle({ ...b, borderColor: color, borderWidth: a.width, rotate: deg0, xSkew: deg0, ySkew: deg0 })
          : drawEllipse({ x: b.x + b.width / 2, y: b.y + b.height / 2, xScale: b.width / 2, yScale: b.height / 2, borderColor: color, borderWidth: a.width, rotate: deg0 });
        add(a, a.type === 'rect' ? 'Square' : 'Circle', pad(b, a.width / 2 + 1), { BS: { W: a.width, S: 'S' } }, ops);
        break;
      }
      case 'line':
      case 'arrow':
      case 'pen': {
        const color = rgb(...hexColor(a.color));
        const seg = (p, q) => drawLine({ start: ctx.pt(...p), end: ctx.pt(...q), thickness: a.width, color, lineCap: 1 });
        const ops = [];
        let pts;
        if (a.type === 'pen') {
          pts = a.points;
          if (pts.length === 1) ops.push(...seg(pts[0], pts[0]));
          for (let k = 1; k < pts.length; k++) ops.push(...seg(pts[k - 1], pts[k]));
        } else {
          pts = [[a.x1, a.y1], [a.x2, a.y2]];
          ops.push(...seg(pts[0], pts[1]));
          if (a.type === 'arrow') {
            const [h1, h2] = ctx.arrowHead(a);
            ops.push(...seg(h1, pts[1]), ...seg(h2, pts[1]));
            pts = [...pts, h1, h2];
          }
        }
        const user = pts.map((p) => ctx.pt(...p));
        const xs = user.map((p) => p.x);
        const ys = user.map((p) => p.y);
        const d = a.width / 2 + 2;
        const rect = { x: Math.min(...xs) - d, y: Math.min(...ys) - d, width: Math.max(...xs) - Math.min(...xs) + 2 * d, height: Math.max(...ys) - Math.min(...ys) + 2 * d };
        const extra = { BS: { W: a.width, S: 'S' } };
        if (a.type === 'pen') extra.InkList = [a.points.flatMap((p) => { const u = ctx.pt(...p); return [u.x, u.y]; })];
        else {
          const s = ctx.pt(a.x1, a.y1);
          const e = ctx.pt(a.x2, a.y2);
          extra.L = [s.x, s.y, e.x, e.y];
          if (a.type === 'arrow') extra.LE = ['None', 'OpenArrow'];
        }
        add(a, a.type === 'pen' ? 'Ink' : 'Line', rect, extra, ops);
        break;
      }
      case 'text': {
        const font = await ctx.fontFor(a);
        const b = userBox({ x: a.x, y: a.y, w: a.w || 0, h: a.h || 0 });
        const ops = [];
        if (a.highlight) {
          ops.push(pushGraphicsState(), setGraphicsState('GS0'),
            ...drawRectangle({ ...b, color: rgb(...hexColor(a.highlight)), borderWidth: 0, rotate: deg0, xSkew: deg0, ySkew: deg0 }),
            popGraphicsState());
        }
        const lines = ctx.encodable(font, a.text).split('\n');
        lines.forEach((line, k) => {
          const o = ctx.pt(a.x + a.size * ctx.TEXT_PAD_X, a.y + a.size * (ctx.TEXT_PAD_Y + ctx.textBaseline(a) + 1.2 * k));
          if (!line) return;
          ops.push(...drawText(font.encodeText(line), {
            color: rgb(...hexColor(a.color)), font: 'F0', size: a.size, rotate: degrees(rotation), xSkew: deg0, ySkew: deg0,
            x: o.x, y: o.y,
          }));
        });
        const [cr, cg, cb] = hexColor(a.color);
        const { dict } = add(a, 'FreeText', pad(b, 1), {
          DA: PDFString.of(`/F0 ${a.size} Tf ${cr} ${cg} ${cb} rg`),
        }, ops, { Font: { F0: font.ref }, ExtGState: { GS0: gsMultiply } });
        dict.delete(PDFName.of('C')); // C is the box border/background for FreeText
        break;
      }
      case 'note': {
        // Sticky note: a 20×20 icon at its point; replies are separate notes that
        // reference the first (In Reply To), the standard way to thread comments.
        const o = ctx.pt(a.x, a.y);
        const rect = { x: o.x, y: o.y - 20, width: 20, height: 20 };
        const [r1, g1, b1] = hexColor(a.color || '#ffd400');
        const ops = [
          ...drawRectangle({ x: rect.x + 1, y: rect.y + 1, width: 18, height: 18, color: rgb(r1, g1, b1), borderColor: rgb(r1 * 0.6, g1 * 0.6, b1 * 0.6), borderWidth: 1, rotate: deg0, xSkew: deg0, ySkew: deg0 }),
          ...[6, 10, 14].map((dy) => drawLine({ start: { x: rect.x + 5, y: rect.y + 20 - dy }, end: { x: rect.x + 15, y: rect.y + 20 - dy }, thickness: 1, color: rgb(r1 * 0.45, g1 * 0.45, b1 * 0.45) })).flat(),
        ];
        const { ref: parent } = add(a, 'Text', rect, { Name: 'Comment', Open: false }, ops);
        for (const reply of a.replies || []) {
          const appearance = context.register(context.formXObject([], { BBox: rectArray(rect) }));
          const rd = context.obj({
            Type: 'Annot', Subtype: 'Text', Rect: rectArray(rect), F: 4 | 2 /* hidden: shown in the thread */, Name: 'Comment',
            NM: PDFString.of(reply.id), M: PDFString.of(pdfDate(reply.date)), IRT: parent, RT: 'R', P: page.ref, AP: { N: appearance },
          });
          if (reply.author) rd.set(PDFName.of('T'), PDFHexString.fromText(reply.author));
          rd.set(PDFName.of('Contents'), PDFHexString.fromText(reply.text || ''));
          page.node.addAnnot(context.register(rd));
        }
        break;
      }
    }
  }
}

/**
 * Pull Agility's annotations out of a loaded document.
 * Returns an array (by page index) of annotation lists, or null when none were
 * found; the document is modified in place (annotations removed), so the caller
 * should save and use the new bytes.
 */
export function takeAnnotations(doc, rotateAnnotation) {
  const result = [];
  let found = false;
  doc.getPages().forEach((page, i) => {
    const annots = page.node.Annots();
    if (!annots) return;
    const keep = [];
    const list = [];
    const ownRefs = new Set();
    const items = annots.asArray();
    for (const ref of items) {
      const dict = doc.context.lookup(ref);
      const raw = dict instanceof PDFDict ? dict.get(PDFName.of(DATA_KEY)) : null;
      if (!raw) continue;
      try {
        const text = raw instanceof PDFHexString ? raw.decodeText() : raw.decodeText?.() ?? String(raw);
        const { rot, a } = JSON.parse(text);
        // Adjust if the page was rotated by another app since Agility saved it.
        const current = page.getRotation().angle;
        const turns = ((((current - rot) / 90) % 4) + 4) % 4;
        const { width, height } = page.getCropBox();
        for (let t = 0; t < turns; t++) {
          const swap = ((rot / 90 + t) % 2) === 1;
          rotateAnnotation(a, swap ? height : width, swap ? width : height, 1);
        }
        list.push(a);
        ownRefs.add(ref);
      } catch {
        /* not ours after all */
      }
    }
    for (const ref of items) {
      if (ownRefs.has(ref)) continue;
      // Replies to our notes are rebuilt from the note itself.
      const dict = doc.context.lookup(ref);
      const irt = dict instanceof PDFDict ? dict.get(PDFName.of('IRT')) : null;
      if (irt && ownRefs.has(irt)) continue;
      keep.push(ref);
    }
    if (list.length) {
      found = true;
      result[i] = list;
      page.node.set(PDFName.of('Annots'), doc.context.obj(keep));
    }
  });
  return found ? result : null;
}
