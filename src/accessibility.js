// Document properties, an accessibility check, and PDF/A-2b output.

import { srgbProfile } from './icc.js';

const { PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFBool, PDFNumber } = window.PDFLib;

// ---- Properties ----------------------------------------------------------------------

export function readProperties(doc) {
  const lang = doc.catalog.get(PDFName.of('Lang'));
  const prefs = doc.catalog.lookupMaybe(PDFName.of('ViewerPreferences'), PDFDict);
  return {
    title: doc.getTitle() || '',
    author: doc.getAuthor() || '',
    subject: doc.getSubject() || '',
    keywords: doc.getKeywords() || '',
    lang: lang?.decodeText?.() ?? '',
    displayTitle: prefs?.get(PDFName.of('DisplayDocTitle'))?.asBoolean?.() ?? false,
  };
}

export function applyProperties(doc, p) {
  doc.setTitle(p.title || '', { showInWindowTitleBar: !!p.displayTitle });
  doc.setAuthor(p.author || '');
  doc.setSubject(p.subject || '');
  doc.setKeywords((p.keywords || '').split(/[,;]\s*/).filter(Boolean));
  if (p.lang) doc.catalog.set(PDFName.of('Lang'), PDFString.of(p.lang));
  else doc.catalog.delete(PDFName.of('Lang'));
}

// ---- Accessibility check --------------------------------------------------------------

const fontDicts = (doc) => [...doc.context.enumerateIndirectObjects()]
  .map(([, o]) => o)
  .filter((o) => o instanceof PDFDict && o.get(PDFName.of('Type'))?.toString() === '/Font');

// Fonts whose glyphs aren't embedded (Type 3 fonts draw their own glyphs).
export function unembeddedFonts(doc) {
  const out = new Set();
  for (const f of fontDicts(doc)) {
    const sub = f.get(PDFName.of('Subtype'))?.toString();
    if (sub === '/Type3' || sub === '/Type0') continue; // Type0: checked through its descendant
    const fd = f.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
    const embedded = fd && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => fd.has(PDFName.of(k)));
    if (!embedded) out.add(f.get(PDFName.of('BaseFont'))?.toString().slice(1) || 'unnamed');
  }
  return [...out];
}

/**
 * Check a document. pdf is the pdf.js document (for text and structure),
 * protection the active password protection, if any.
 * Returns [{ id, label, status: 'pass' | 'warn' | 'fail', detail, fix? }].
 */
export async function checkAccessibility(doc, pdf, { protection } = {}) {
  const props = readProperties(doc);
  const results = [];
  const add = (id, label, ok, detail, { warn = false, fix } = {}) => results.push({ id, label, status: ok ? 'pass' : warn ? 'warn' : 'fail', detail, fix: ok ? undefined : fix });

  add('title', 'Document title', !!props.title, props.title ? `“${props.title}”` : 'Screen readers announce the title; set one in Document Properties.', { fix: 'properties' });
  add('lang', 'Document language', !!props.lang, props.lang || 'Tells screen readers which language to speak.', { fix: 'properties' });
  add('display', 'Title shown in window', props.displayTitle, props.displayTitle ? 'Viewers show the title instead of the file name.' : 'Viewers show the file name instead of the title.', { warn: true, fix: 'display-title' });

  const markInfo = doc.catalog.lookupMaybe(PDFName.of('MarkInfo'), PDFDict);
  const tagged = !!markInfo?.get(PDFName.of('Marked'))?.asBoolean?.() && doc.catalog.has(PDFName.of('StructTreeRoot'));
  add('tagged', 'Tagged structure', tagged, tagged ? 'Headings, paragraphs and reading order are tagged.'
    : "Untagged: screen readers can't tell headings, lists and reading order apart. Re-export from the source document with tags (accessible PDF) to fix.", { warn: true });

  const noText = [];
  let figures = 0;
  let figuresWithoutAlt = 0;
  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    const text = (await page.getTextContent()).items.map((t) => t.str).join('').trim();
    if (!text) noText.push(i + 1);
    if (tagged) {
      const walk = (node) => {
        if (!node) return;
        if (node.role === 'Figure') {
          figures++;
          if (!node.alt) figuresWithoutAlt++;
        }
        (node.children || []).forEach(walk);
      };
      walk(await page.getStructTree().catch(() => null));
    }
  }
  add('text', 'Text on every page', !noText.length, noText.length ? `Page${noText.length > 1 ? 's' : ''} ${noText.slice(0, 10).join(', ')}${noText.length > 10 ? '…' : ''} ${noText.length > 1 ? 'are' : 'is'} only images. Recognize the text (OCR).` : 'Every page has real text.', { fix: 'ocr' });
  if (tagged) add('alt', 'Alternate text for figures', !figuresWithoutAlt, figures ? `${figures - figuresWithoutAlt} of ${figures} figures have alternate text.` : 'No tagged figures.', { warn: true });

  const fields = doc.getForm().getFields();
  const noTip = fields.filter((f) => !f.acroField.dict.has(PDFName.of('TU')));
  if (fields.length) add('tooltips', 'Form field descriptions', !noTip.length, noTip.length ? `${noTip.length} of ${fields.length} fields have no description (tooltip) for screen readers.` : 'Every field has a description.', { fix: 'tooltips' });

  let links = 0;
  let undescribed = 0;
  for (const page of doc.getPages()) {
    for (const ref of page.node.Annots()?.asArray() || []) {
      const a = doc.context.lookup(ref);
      if (a instanceof PDFDict && a.get(PDFName.of('Subtype'))?.toString() === '/Link') {
        links++;
        if (!a.has(PDFName.of('Contents'))) undescribed++;
      }
    }
  }
  if (links) add('links', 'Link descriptions', !undescribed, undescribed ? `${undescribed} of ${links} links have no description.` : 'Every link has a description.', { warn: true, fix: 'links' });

  if (protection) add('security', 'Security allows assistive technology', protection.permissions.copy !== false, 'Copying is restricted, which some screen readers depend on.', { warn: true });
  const missing = unembeddedFonts(doc);
  add('fonts', 'Fonts embedded', !missing.length, missing.length ? `Not embedded: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}. Text may look different elsewhere; required for PDF/A.` : 'All fonts are embedded.', { warn: true });
  return results;
}

/** Fixes that work directly on the document. */
export function applyFix(doc, id) {
  if (id === 'display-title') {
    const prefs = doc.catalog.lookupMaybe(PDFName.of('ViewerPreferences'), PDFDict) || doc.context.obj({});
    prefs.set(PDFName.of('DisplayDocTitle'), PDFBool.True);
    doc.catalog.set(PDFName.of('ViewerPreferences'), prefs);
  }
  if (id === 'tooltips') {
    for (const f of doc.getForm().getFields()) {
      const dict = f.acroField.dict;
      // A readable description from the field name: "fullName" → "Full name".
      const name = f.getName().split('.').pop().replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
      if (!dict.has(PDFName.of('TU'))) dict.set(PDFName.of('TU'), PDFHexString.fromText(name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()));
    }
  }
  if (id === 'links') {
    doc.getPages().forEach((page) => {
      for (const ref of page.node.Annots()?.asArray() || []) {
        const a = doc.context.lookup(ref);
        if (!(a instanceof PDFDict) || a.get(PDFName.of('Subtype'))?.toString() !== '/Link' || a.has(PDFName.of('Contents'))) continue;
        const uri = a.lookupMaybe(PDFName.of('A'), PDFDict)?.get(PDFName.of('URI'));
        const dest = a.get(PDFName.of('Dest'));
        let label = uri ? `Link to ${uri.decodeText?.() ?? ''}` : 'Link';
        if (!uri && dest instanceof PDFArray) {
          const k = doc.getPages().findIndex((p) => p.ref === dest.get(0));
          if (k >= 0) label = `Go to page ${k + 1}`;
        }
        a.set(PDFName.of('Contents'), PDFHexString.fromText(label));
      }
    });
  }
}

// ---- PDF/A-2b ------------------------------------------------------------------------------

const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * Turn a document into PDF/A-2b: XMP metadata matching the document info, an
 * sRGB output intent, no JavaScript, printable annotations. Returns the list of
 * things that still don't conform (e.g. fonts the original didn't embed).
 */
export function toPdfA(doc, props) {
  const problems = [];
  const { context, catalog } = doc;
  const now = new Date();
  const iso = now.toISOString().replace(/\.\d+Z$/, 'Z');
  const title = props.title || '';
  const author = props.author || '';

  doc.setTitle(title, { showInWindowTitleBar: !!props.displayTitle });
  if (author) doc.setAuthor(author);
  doc.setProducer('Agility');
  doc.setCreator('Agility');
  doc.setCreationDate(now);
  doc.setModificationDate(now);

  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description>
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:format>application/pdf</dc:format>${title ? `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(title)}</rdf:li></rdf:Alt></dc:title>` : ''}${author ? `<dc:creator><rdf:Seq><rdf:li>${xmlEsc(author)}</rdf:li></rdf:Seq></dc:creator>` : ''}</rdf:Description>
<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><xmp:CreateDate>${iso}</xmp:CreateDate><xmp:ModifyDate>${iso}</xmp:ModifyDate><xmp:MetadataDate>${iso}</xmp:MetadataDate><xmp:CreatorTool>Agility</xmp:CreatorTool></rdf:Description>
<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"><pdf:Producer>Agility</pdf:Producer></rdf:Description>
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
  const metadata = context.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' });
  catalog.set(PDFName.of('Metadata'), context.register(metadata));

  const icc = context.flateStream(srgbProfile(), { N: 3 });
  catalog.set(PDFName.of('OutputIntents'), context.obj([{
    Type: 'OutputIntent', S: 'GTS_PDFA1',
    OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'), Info: PDFString.of('sRGB IEC61966-2.1'),
    DestOutputProfile: context.register(icc),
  }]));

  // No scripts or automatic actions.
  catalog.delete(PDFName.of('OpenAction'));
  catalog.delete(PDFName.of('AA'));
  catalog.lookupMaybe(PDFName.of('Names'), PDFDict)?.delete(PDFName.of('JavaScript'));
  catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)?.delete(PDFName.of('NeedAppearances'));

  for (const page of doc.getPages()) {
    page.node.delete(PDFName.of('AA'));
    for (const ref of page.node.Annots()?.asArray() || []) {
      const a = context.lookup(ref);
      if (!(a instanceof PDFDict)) continue;
      a.delete(PDFName.of('AA'));
      const action = a.lookupMaybe(PDFName.of('A'), PDFDict);
      if (action?.get(PDFName.of('S'))?.toString() === '/JavaScript') a.delete(PDFName.of('A'));
      const sub = a.get(PDFName.of('Subtype'))?.toString();
      if (sub === '/Popup' || sub === '/Link') continue;
      // Annotations must print and must have an appearance.
      const flags = a.get(PDFName.of('F'))?.asNumber?.() ?? 0;
      a.set(PDFName.of('F'), PDFNumber.of((flags | 4) & ~(1 | 2 | 32)));
      if (!a.has(PDFName.of('AP'))) problems.push(`A ${sub?.slice(1) || 'markup'} annotation has no appearance.`);
    }
  }

  const missing = unembeddedFonts(doc);
  if (missing.length) problems.push(`Fonts not embedded in the original document: ${missing.join(', ')}.`);
  // Plain uncompressed metadata and a document ID are expected by validators.
  if (!context.trailerInfo.ID) {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    context.trailerInfo.ID = context.obj([PDFHexString.of(id), PDFHexString.of(id)]);
  }
  return problems;
}
