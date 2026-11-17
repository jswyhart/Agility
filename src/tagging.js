// Adds accessibility tags to an untagged PDF.
//
// A tagged PDF has a structure tree (headings, paragraphs, figures, in reading
// order) whose leaves point at marked pieces of the page content. The source
// application normally writes it; here it is worked out from the layout:
//
// - text is grouped into blocks by line spacing and size, in content order;
// - a block clearly larger than the body text becomes a heading (H1, H2, … by size);
// - every image becomes a Figure, to be given alternate text.
//
// Each text-showing operator and image is wrapped in its own marked-content
// sequence, so nothing in the page is moved or redrawn.

import { parseOps, interpret, readPageContent } from './textedit.js';

const { PDFName, PDFDict, PDFArray, PDFNumber, PDFHexString, PDFBool, PDFRef } = window.PDFLib;

const HEADING_RATIO = 1.15; // this much larger than the body text reads as a heading
const HEADING_MAX_LINES = 3;

const bucket = (size) => Math.round(size * 2) / 2;

/** Group one page's text runs into blocks: [{ size, lines, runs: [run] }]. */
function blocksOf(runs) {
  const blocks = [];
  let cur = null;
  let prev = null;
  for (const r of runs) {
    const size = r.size || 1;
    let join = false;
    if (cur && prev) {
      const down = prev.y0 - r.y0; // how far below the previous run this one starts
      const sameLine = Math.abs(down) < 0.5 * size;
      const nextLine = down >= 0.5 * size && down < 1.9 * Math.max(size, cur.size);
      const sameSize = Math.abs(size - cur.size) <= 0.08 * cur.size;
      // The same line stays together (superscripts, mixed styles); a new line joins
      // only if it follows at normal line spacing in the same size.
      join = sameLine ? Math.abs(size - cur.size) <= 0.4 * cur.size : nextLine && sameSize;
      if (join && !sameLine) cur.lines++;
    }
    if (!join) {
      cur = { size, lines: 1, runs: [] };
      blocks.push(cur);
    }
    cur.runs.push(r);
    prev = r;
  }
  return blocks;
}

/** Images drawn by a page: the content operations that paint an image XObject. */
function imageOps(page, ops) {
  const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xobjects) return [];
  return ops.filter((o) => {
    if (o.op !== 'Do' || !o.args[0]?.name) return false;
    const x = xobjects.lookup(PDFName.of(o.args[0].name));
    return x?.dict?.get(PDFName.of('Subtype'))?.toString() === '/Image';
  });
}

/**
 * Tag every page of `doc`. Returns { blocks, headings, figures } counts.
 * A document that already has a structure tree is left alone.
 */
export function tagDocument(doc) {
  const { context, catalog } = doc;
  if (catalog.has(PDFName.of('StructTreeRoot'))) return { blocks: 0, headings: 0, figures: 0, skipped: true };
  const pages = doc.getPages();

  // Pass 1: read each page and decide what its blocks are.
  const plans = pages.map((page) => {
    const bytes = readPageContent(page);
    const ops = parseOps(bytes);
    const fonts = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
    const runs = interpret(ops, fonts).filter((r) => Math.hypot(r.x1 - r.x0, r.y1 - r.y0) > 0.01); // not empty strings
    return { page, bytes, ops, blocks: blocksOf(runs), images: imageOps(page, ops) };
  });

  // The body size is the one most of the text is set in (by run length).
  const weight = new Map();
  for (const { blocks } of plans) {
    for (const b of blocks) {
      for (const r of b.runs) weight.set(bucket(b.size), (weight.get(bucket(b.size)) || 0) + Math.hypot(r.x1 - r.x0, r.y1 - r.y0));
    }
  }
  const body = [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
  const isHeading = (b) => body > 0 && b.size >= body * HEADING_RATIO && b.lines <= HEADING_MAX_LINES;
  // Heading levels follow size: the largest heading size is H1, and so on.
  const headingSizes = [...new Set(plans.flatMap((p) => p.blocks.filter(isHeading).map((b) => bucket(b.size))))].sort((a, b) => b - a);
  const role = (b) => (isHeading(b) ? `H${Math.min(6, headingSizes.indexOf(bucket(b.size)) + 1)}` : 'P');

  // Pass 2: mark the content and build the tree.
  const rootRef = context.nextRef();
  const docRef = context.nextRef();
  const kids = [];
  const parentNums = [];
  const counts = { blocks: 0, headings: 0, figures: 0 };
  const enc = new TextEncoder();

  plans.forEach(({ page, bytes, ops, blocks, images }, pageIndex) => {
    const inserts = []; // { at, text } to splice into the content
    const parents = []; // structure element for each MCID on this page
    const mark = (op, tag) => {
      const mcid = parents.length;
      inserts.push({ at: op.start, text: `/${tag} <</MCID ${mcid}>> BDC ` }, { at: op.end, text: ' EMC ' });
      return mcid;
    };
    const element = (tag, mcids) => {
      const ref = context.register(context.obj({
        Type: 'StructElem', S: tag, P: docRef, Pg: page.ref, K: mcids.length === 1 ? mcids[0] : mcids,
      }));
      for (const id of mcids) parents[id] = ref;
      return ref;
    };
    // Blocks and figures in the order the page draws them.
    const items = [
      ...blocks.map((b) => ({ at: ops[b.runs[0].index].start, block: b })),
      ...images.map((op) => ({ at: op.start, image: op })),
    ].sort((a, b) => a.at - b.at);
    for (const item of items) {
      if (item.block) {
        const tag = role(item.block);
        kids.push(element(tag, item.block.runs.map((r) => mark(ops[r.index], tag))));
        counts.blocks++;
        if (tag !== 'P') counts.headings++;
      } else {
        kids.push(element('Figure', [mark(item.image, 'Figure')]));
        counts.figures++;
      }
    }
    if (!inserts.length) return;

    // Where one operation ends exactly as the next begins, close before opening.
    inserts.sort((a, b) => a.at - b.at || (a.text === ' EMC ' ? -1 : 1) - (b.text === ' EMC ' ? -1 : 1));
    const parts = [];
    let cursor = 0;
    for (const ins of inserts) {
      parts.push(bytes.subarray(cursor, ins.at), enc.encode(ins.text));
      cursor = ins.at;
    }
    parts.push(bytes.subarray(cursor));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    page.node.set(PDFName.of('Contents'), context.register(context.flateStream(out)));
    page.node.set(PDFName.of('StructParents'), PDFNumber.of(pageIndex));
    page.node.set(PDFName.of('Tabs'), PDFName.of('S')); // tab through fields in structure order
    parentNums.push(pageIndex, context.register(context.obj(parents)));
  });

  context.assign(docRef, context.obj({ Type: 'StructElem', S: 'Document', P: rootRef, K: kids }));
  context.assign(rootRef, context.obj({
    Type: 'StructTreeRoot', K: docRef, ParentTree: context.register(context.obj({ Nums: parentNums })), ParentTreeNextKey: pages.length,
  }));
  catalog.set(PDFName.of('StructTreeRoot'), rootRef);
  catalog.set(PDFName.of('MarkInfo'), context.obj({ Marked: PDFBool.True }));
  return counts;
}

// ---- Figures -----------------------------------------------------------------------

// Every Figure element in the structure tree, in reading order.
function figureElements(doc) {
  const out = [];
  const seen = new Set();
  const walk = (node) => {
    if (node instanceof PDFRef) {
      if (seen.has(node.toString())) return;
      seen.add(node.toString());
      node = doc.context.lookup(node);
    }
    if (node instanceof PDFArray) return node.asArray().forEach(walk);
    if (!(node instanceof PDFDict)) return;
    if (node.get(PDFName.of('S'))?.toString() === '/Figure') out.push(node);
    walk(node.get(PDFName.of('K')));
  };
  walk(doc.catalog.get(PDFName.of('StructTreeRoot')));
  return out;
}

/** Tagged figures: [{ page (1-based, 0 if unknown), alt }]. */
export function listFigures(doc) {
  const pages = doc.getPages();
  return figureElements(doc).map((el) => ({
    page: pages.findIndex((p) => p.ref === el.get(PDFName.of('Pg'))) + 1,
    alt: el.get(PDFName.of('Alt'))?.decodeText?.() ?? '',
  }));
}

/** Set alternate text on the figures, in listFigures order; '' leaves one undescribed. */
export function setFigureAlts(doc, alts) {
  figureElements(doc).forEach((el, k) => {
    const text = (alts[k] || '').trim();
    if (text) el.set(PDFName.of('Alt'), PDFHexString.fromText(text));
    else el.delete(PDFName.of('Alt'));
  });
}
