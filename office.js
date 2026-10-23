// Office documents to PDF. Uses LibreOffice when it's installed (best fidelity,
// every format); otherwise converts Word (.docx) with mammoth and spreadsheets
// (.xlsx, .csv) with ExcelJS to HTML and prints that to PDF in a hidden window.

const { BrowserWindow } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OFFICE_EXTENSIONS = ['docx', 'doc', 'odt', 'rtf', 'xlsx', 'xlsm', 'xls', 'ods', 'csv', 'pptx', 'ppt', 'odp'];

function findLibreOffice() {
  const candidates = {
    darwin: ['/Applications/LibreOffice.app/Contents/MacOS/soffice'],
    win32: ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'],
    linux: ['/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice', '/snap/bin/libreoffice'],
  }[process.platform] || [];
  const onPath = (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, process.platform === 'win32' ? 'soffice.exe' : 'soffice'));
  return [...candidates, ...onPath].find((p) => fss.existsSync(p)) || null;
}

function libreOfficeToPdf(soffice, file) {
  return new Promise((resolve, reject) => {
    const outDir = fss.mkdtempSync(path.join(os.tmpdir(), 'agility-office-'));
    // A private profile keeps this from clashing with a LibreOffice window the user has open.
    const profile = `-env:UserInstallation=file://${outDir.replace(/\\/g, '/')}/profile`;
    execFile(soffice, [profile, '--headless', '--convert-to', 'pdf', '--outdir', outDir, file], { timeout: 120000 }, async (err) => {
      if (err) return reject(new Error(`LibreOffice couldn't convert the file: ${err.message}`));
      const pdf = path.join(outDir, `${path.parse(file).name}.pdf`);
      try {
        resolve(new Uint8Array(await fs.readFile(pdf)));
      } catch {
        reject(new Error("LibreOffice didn't produce a PDF."));
      } finally {
        fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const PAGE_CSS = `
  body { font: 11pt Calibri, Carlito, Arial, sans-serif; color: #111; margin: 0; }
  img { max-width: 100%; }
  table { border-collapse: collapse; margin: 0 0 18pt; font-size: 9pt; }
  td, th { border: 1px solid #bbb; padding: 3pt 5pt; vertical-align: top; }
  th { background: #eef1f5; text-align: left; }
  td.n { text-align: right; font-variant-numeric: tabular-nums; }
  h1.sheet { font-size: 13pt; margin: 0 0 8pt; page-break-before: always; }
  h1.sheet:first-child { page-break-before: auto; }`;

async function docxToHtml(file) {
  const mammoth = require('mammoth');
  const { value } = await mammoth.convertToHtml({ path: file });
  return value;
}

function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toLocaleDateString();
  if (typeof v === 'object') return v.text ?? v.result ?? (v.richText ? v.richText.map((r) => r.text).join('') : v.hyperlink ?? '');
  return v;
}

async function sheetToHtml(file) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(file)) await wb.csv.readFile(file);
  else await wb.xlsx.readFile(file);
  return wb.worksheets.map((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      const cells = [];
      for (let c = 1; c <= ws.actualColumnCount; c++) {
        const v = cellText(row.getCell(c).value);
        const tag = n === 1 ? 'th' : 'td';
        cells.push(`<${tag}${typeof v === 'number' ? ' class="n"' : ''}>${esc(v)}</${tag}>`);
      }
      rows.push(`<tr>${cells.join('')}</tr>`);
    });
    return `<h1 class="sheet">${esc(ws.name)}</h1><table>${rows.join('')}</table>`;
  }).join('');
}

async function htmlToPdf(html, { landscape = false } = {}) {
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), 'agility-html-'));
  const file = path.join(dir, 'doc.html');
  await fs.writeFile(file, `<!doctype html><meta charset="utf-8"><style>${PAGE_CSS}</style>${html}`);
  // The content comes from the document being converted: no scripts, no network.
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true }));
  try {
    await win.loadFile(file);
    return new Uint8Array(await win.webContents.printToPDF({ pageSize: 'Letter', landscape, printBackground: true, margins: { marginType: 'default' } }));
  } finally {
    win.destroy();
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Convert an Office file to PDF. Returns { name, data } or throws with a helpful message. */
async function officeToPdf(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const name = `${path.parse(file).name}.pdf`;
  const soffice = process.env.AGILITY_NO_LIBREOFFICE ? null : findLibreOffice();
  if (soffice) return { name, data: await libreOfficeToPdf(soffice, file) };
  if (ext === 'docx') return { name, data: await htmlToPdf(await docxToHtml(file)) };
  if (['xlsx', 'xlsm', 'csv'].includes(ext)) return { name, data: await htmlToPdf(await sheetToHtml(file), { landscape: true }) };
  throw new Error(`Converting .${ext} files needs LibreOffice (free, libreoffice.org). Word .docx and Excel .xlsx/.csv files work without it.`);
}

module.exports = { officeToPdf, OFFICE_EXTENSIONS, findLibreOffice };
