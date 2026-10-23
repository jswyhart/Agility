// Bookmarks (the document outline): read from pdf.js into an editable tree,
// and written back with pdf-lib when edited.
//
// Tree items: { id, title, pageId, top, url, open, children }. pageId ties a
// bookmark to a page through reorders; top is the y on the page (screen units).

const { PDFName, PDFHexString, PDFNumber, PDFNull, PDFString } = window.PDFLib;

const uid = () => Math.random().toString(36).slice(2, 10);

/** Read the outline of a pdf.js document. pageIds maps page index -> stable id. */
export async function readOutline(pdf, pageIds) {
  const items = await pdf.getOutline().catch(() => null);
  if (!items?.length) return [];
  const convert = async (item) => {
    const node = { id: uid(), title: item.title || 'Untitled', open: item.count > 0, children: [] };
    if (item.url) node.url = item.url;
    try {
      const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
      if (Array.isArray(dest) && dest[0] != null) {
        const index = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
        node.pageId = pageIds[index];
        // [page, /XYZ, left, top, zoom] or /FitH top: remember the top of the view.
        const kind = dest[1]?.name;
        const top = kind === 'XYZ' ? dest[3] : kind === 'FitH' || kind === 'FitBH' ? dest[2] : null;
        if (typeof top === 'number') {
          const page = await pdf.getPage(index + 1);
          node.top = Math.max(0, page.getViewport({ scale: 1 }).convertToViewportPoint(0, top)[1]);
        }
      }
    } catch {
      /* unresolvable destination: keep the title */
    }
    for (const child of item.items || []) node.children.push(await convert(child));
    return node;
  };
  return Promise.all(items.map(convert));
}

/**
 * Replace the document's outline with `tree`. viewports[i] converts screen y to
 * PDF space for page i; pageIds maps index -> id. Bookmarks to deleted pages are dropped.
 */
export function writeOutline(doc, tree, pageIds, viewports) {
  const { context } = doc;
  doc.catalog.delete(PDFName.of('Outlines'));
  const pages = doc.getPages();
  const indexOf = new Map(pageIds.map((id, i) => [id, i]));
  const keep = (nodes) => nodes
    .map((n) => ({ ...n, children: keep(n.children || []) }))
    .filter((n) => n.url || indexOf.has(n.pageId) || n.children.length);
  const nodes = keep(tree);
  if (!nodes.length) return;

  const rootRef = context.nextRef();
  const countVisible = (list) => list.reduce((c, n) => c + 1 + (n.open ? countVisible(n.children) : 0), 0);

  // Build one level; returns [firstRef, lastRef].
  const build = (list, parentRef) => {
    const refs = list.map(() => context.nextRef());
    list.forEach((n, k) => {
      const dict = context.obj({ Title: PDFHexString.fromText(n.title), Parent: parentRef });
      if (k > 0) dict.set(PDFName.of('Prev'), refs[k - 1]);
      if (k < list.length - 1) dict.set(PDFName.of('Next'), refs[k + 1]);
      if (n.url) {
        dict.set(PDFName.of('A'), context.obj({ S: 'URI', URI: PDFString.of(n.url) }));
      } else if (indexOf.has(n.pageId)) {
        const i = indexOf.get(n.pageId);
        const top = n.top != null ? viewports[i].convertToPdfPoint(0, n.top)[1] : null;
        dict.set(PDFName.of('Dest'), context.obj([pages[i].ref, PDFName.of('XYZ'), PDFNull, top == null ? PDFNull : PDFNumber.of(top), PDFNull]));
      }
      if (n.children.length) {
        const [first, last] = build(n.children, refs[k]);
        dict.set(PDFName.of('First'), first);
        dict.set(PDFName.of('Last'), last);
        const c = countVisible(n.children);
        dict.set(PDFName.of('Count'), PDFNumber.of(n.open ? c : -c));
      }
      context.assign(refs[k], dict);
    });
    return [refs[0], refs[refs.length - 1]];
  };
  const [first, last] = build(nodes, rootRef);
  context.assign(rootRef, context.obj({ Type: 'Outlines', First: first, Last: last, Count: PDFNumber.of(countVisible(nodes)) }));
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
  if (!doc.catalog.has(PDFName.of('PageMode'))) doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

