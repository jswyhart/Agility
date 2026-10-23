// Export to Word: one .docx paragraph per PDF paragraph, keeping size, bold and
// italic, with a page break between pages.

import { zip } from './zip.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  // Characters XML 1.0 can't carry.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

const run = (p) => {
  const props = [
    p.bold ? '<w:b/>' : '',
    p.italic ? '<w:i/>' : '',
    p.font === 'serif' ? '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>' : p.font === 'mono' ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>' : '',
    `<w:sz w:val="${Math.max(2, Math.round(p.size * 2))}"/>`,
  ].join('');
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${esc(p.text)}</w:t></w:r>`;
};

/** pages: [[{ text, size, bold, italic, font }]] → .docx bytes */
export function buildDocx(pages, title = 'Document') {
  const body = pages.map((paras, k) => {
    const ps = paras.map((p) => `<w:p><w:pPr><w:spacing w:after="${Math.round(p.size * 6)}"/></w:pPr>${run(p)}</w:p>`).join('');
    const brk = k < pages.length - 1 ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : '';
    return ps + brk;
  }).join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return zip([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title)}</dc:title><dc:creator>Agility</dc:creator></cp:coreProperties>` },
    { name: 'word/document.xml', data: document },
  ]);
}
