// Agility — Electron main process.
// Owns windows, tabs, native menus, file dialogs and disk access. The renderer
// never touches the filesystem directly; it goes through the IPC handlers below.
//
// Each window is a BaseWindow holding a tab strip (its own small page) and one
// WebContentsView per open document. Every tab runs its own copy of the editor,
// so documents never share state.

const { app, BaseWindow, WebContentsView, ipcMain, dialog, Menu, protocol, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

const APP_NAME = 'Agility';
const ROOT = __dirname;
const IS_MAC = process.platform === 'darwin';
const TAB_STRIP_HEIGHT = IS_MAC ? 38 : 34;
const SERVED_DIRS = [
  'src', 'node_modules/pdfjs-dist', 'node_modules/pdf-lib/dist', 'node_modules/@fontsource',
  'node_modules/@pdf-lib/fontkit/dist', 'node_modules/dejavu-fonts-ttf/ttf',
].map((d) => path.join(ROOT, d));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.icc': 'application/octet-stream',
};

// A privileged custom scheme gives the renderer a real origin, so ES modules,
// the pdf.js module worker and fetch() all work without a dev server.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Paths the renderer may write to: files the user opened or picked in a save dialog.
const writablePaths = new Set();
// Files requested before the app was ready (macOS open-file, argv on Windows/Linux).
const pendingFiles = [];

const userFile = (name) => path.join(app.getPath('userData'), name);

function pdfArgs(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).filter((a) => /\.pdf$/i.test(a) && !a.startsWith('-'));
}

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url);
    const full = path.normalize(path.join(ROOT, decodeURIComponent(pathname)));
    if (!SERVED_DIRS.some((dir) => full.startsWith(dir + path.sep))) {
      return new Response('Not found', { status: 404 });
    }
    try {
      const body = await fs.readFile(full);
      const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
      return new Response(body, { headers: { 'content-type': type, 'cache-control': 'no-store' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

async function readJson(name, fallback) {
  try {
    return JSON.parse(await fs.readFile(userFile(name), 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(name, value) {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(userFile(name), JSON.stringify(value, null, 2));
}

// ---- Windows and tabs ---------------------------------------------------------

const windows = new Set();
let quitting = false;
let nextTabId = 1;

const webPreferences = (preload) => ({
  preload: path.join(ROOT, preload),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
});

function lockDown(contents) {
  // Links inside PDFs or the UI open in the system browser, never in-app.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e) => e.preventDefault());
}

class DocWindow {
  constructor() {
    this.tabs = [];
    this.active = null;
    this.closingAll = false;
    this.win = new BaseWindow({
      width: 1440,
      height: 920,
      minWidth: 960,
      minHeight: 600,
      title: APP_NAME,
      backgroundColor: '#1b1c1f',
      ...(IS_MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 12 } } : {}),
    });
    this.strip = new WebContentsView({ webPreferences: webPreferences('tabs-preload.js') });
    this.strip.setBackgroundColor('#141518');
    lockDown(this.strip.webContents);
    this.strip.webContents.loadURL(`app://bundle/src/tabs.html?platform=${process.platform}`);
    this.strip.webContents.once('did-finish-load', () => this.updateStrip());
    this.win.contentView.addChildView(this.strip);
    this.win.on('resize', () => this.layout());
    this.win.on('close', (e) => {
      if (this.tabs.length) {
        e.preventDefault();
        this.requestClose();
      }
    });
    this.win.on('closed', () => {
      windows.delete(this);
      if (quitting && !windows.size) app.quit();
    });
    windows.add(this);
    this.layout();
  }

  layout() {
    const { width, height } = this.win.getContentBounds();
    this.strip.setBounds({ x: 0, y: 0, width, height: TAB_STRIP_HEIGHT });
    for (const t of this.tabs) t.view.setBounds({ x: 0, y: TAB_STRIP_HEIGHT, width, height: height - TAB_STRIP_HEIGHT });
  }

  addTab({ filePath = null, restore = null } = {}) {
    const view = new WebContentsView({ webPreferences: webPreferences('preload.js') });
    view.setBackgroundColor('#1b1c1f');
    const tab = { id: nextTabId++, view, owner: this, doc: { dirty: false, title: null, hasDocument: false, filePath: null } };
    lockDown(view.webContents);
    view.webContents.once('did-finish-load', () => {
      if (restore) view.webContents.send('recovery:restore', restore);
      else if (filePath) view.webContents.send('open-path', filePath);
    });
    view.webContents.on('render-process-gone', () => this.closeTab(tab, { force: true }));
    view.webContents.loadURL('app://bundle/src/index.html');
    this.win.contentView.addChildView(view);
    this.tabs.push(tab);
    this.layout();
    this.activate(tab);
    return tab;
  }

  activate(tab) {
    this.active = tab;
    for (const t of this.tabs) t.view.setVisible(t === tab);
    tab.view.webContents.focus();
    this.updateStrip();
    this.updateTitle();
  }

  cycle(dir) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length]);
  }

  updateStrip() {
    if (this.strip.webContents.isDestroyed()) return;
    this.strip.webContents.send('tabs:update', this.tabs.map((t) => ({
      id: t.id,
      title: t.doc.title || 'New Tab',
      dirty: t.doc.dirty,
      active: t === this.active,
    })));
  }

  updateTitle() {
    const doc = this.active?.doc;
    this.win.setTitle(doc?.title ? `${doc.title}${doc.dirty ? ' •' : ''} — ${APP_NAME}` : APP_NAME);
    if (IS_MAC) {
      this.win.setDocumentEdited(this.tabs.some((t) => t.doc.dirty));
      this.win.setRepresentedFilename(doc?.filePath || '');
    }
  }

  // Ask about unsaved changes; returns false if the user cancelled.
  confirmClose(tab) {
    if (!tab.doc.dirty) return 'discard';
    this.activate(tab);
    const choice = dialog.showMessageBoxSync(this.win, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: `Do you want to save the changes you made to “${tab.doc.title || 'this document'}”?`,
      detail: "Your changes will be lost if you don't save them.",
    });
    return ['save', 'discard', 'cancel'][choice];
  }

  // Returns 'closed', 'cancel', or 'saving' (the tab saves itself, then asks to be
  // closed via win:force-close, or reports win:close-cancelled).
  closeTab(tab, { force = false } = {}) {
    if (!this.tabs.includes(tab)) return 'closed';
    if (!force) {
      const answer = this.confirmClose(tab);
      if (answer === 'cancel') return 'cancel';
      if (answer === 'save') {
        tab.view.webContents.send('menu', 'save-and-close');
        return 'saving';
      }
    }
    clearRecovery(tab.id);
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    this.win.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (!this.tabs.length) {
      this.win.destroy();
      return 'closed';
    }
    if (this.active === tab) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)]);
    else this.updateStrip();
    this.updateTitle();
    return 'closed';
  }

  // Close every tab, asking about unsaved ones. Resumes after a save finishes.
  requestClose() {
    this.closingAll = true;
    for (const tab of [...this.tabs]) {
      const result = this.closeTab(tab);
      if (result === 'saving') return;
      if (result === 'cancel') return this.cancelClose();
    }
  }

  cancelClose() {
    this.closingAll = false;
    quitting = false;
  }
}

function allTabs() {
  return [...windows].flatMap((w) => w.tabs);
}

function tabFor(contents) {
  return allTabs().find((t) => t.view.webContents === contents);
}

function focusedWindow() {
  const focused = BaseWindow.getFocusedWindow();
  return [...windows].find((w) => w.win === focused) || [...windows].pop() || null;
}

// Open files in tabs: reuse an empty active tab, otherwise add new tabs.
function openFiles(files, target = focusedWindow()) {
  const dw = target || new DocWindow();
  for (const file of files) {
    const active = dw.active;
    if (active && !active.doc.hasDocument && !active.opening) {
      active.opening = true;
      active.view.webContents.send('open-path', file);
    } else {
      dw.addTab({ filePath: file });
    }
  }
  dw.win.focus();
}

function newWindow() {
  const dw = new DocWindow();
  dw.addTab();
  return dw;
}

function send(action) {
  return () => focusedWindow()?.active?.view.webContents.send('menu', action);
}

async function showOpenDialog(win) {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
  });
  return canceled ? [] : filePaths;
}

// ---- Recent files -------------------------------------------------------------

let recent = [];

async function addRecent(filePath) {
  recent = [filePath, ...recent.filter((p) => p !== filePath)].slice(0, 12);
  app.addRecentDocument(filePath);
  await writeJson('recent.json', recent);
  buildMenu();
  for (const t of allTabs()) t.view.webContents.send('recent:changed', recent);
}

async function clearRecent() {
  recent = [];
  app.clearRecentDocuments();
  await writeJson('recent.json', recent);
  buildMenu();
  for (const t of allTabs()) t.view.webContents.send('recent:changed', recent);
}

// ---- Crash recovery -------------------------------------------------------------
// Each tab with unsaved changes periodically sends a snapshot. Snapshots are
// removed when the tab saves, discards or closes, so anything left over at the
// next launch means Agility didn't shut down cleanly.

const recoveryDir = () => userFile('Recovery');

async function writeRecovery(tabId, meta, bytes) {
  await fs.mkdir(recoveryDir(), { recursive: true });
  await fs.writeFile(path.join(recoveryDir(), `${tabId}.pdf`), bytes);
  await fs.writeFile(path.join(recoveryDir(), `${tabId}.json`), JSON.stringify(meta));
}

function clearRecovery(tabId) {
  for (const ext of ['pdf', 'json']) fs.rm(path.join(recoveryDir(), `${tabId}.${ext}`), { force: true }).catch(() => {});
}

async function takeRecoveredDocuments() {
  let names;
  try {
    names = (await fs.readdir(recoveryDir())).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const docs = [];
  for (const name of names) {
    const base = path.join(recoveryDir(), name.slice(0, -5));
    try {
      const meta = JSON.parse(await fs.readFile(`${base}.json`, 'utf8'));
      const bytes = new Uint8Array(await fs.readFile(`${base}.pdf`));
      docs.push({ meta, bytes });
    } catch {
      /* partial snapshot: skip */
    }
  }
  await fs.rm(recoveryDir(), { recursive: true, force: true });
  return docs;
}

// ---- Menu --------------------------------------------------------------------------

function buildMenu() {
  const recentItems = recent.length
    ? [
      ...recent.map((p) => ({ label: path.basename(p), sublabel: path.dirname(p), click: () => openRecent(p) })),
      { type: 'separator' },
      { label: 'Clear Menu', click: clearRecent },
    ]
    : [{ label: 'No Recent Files', enabled: false }];
  const template = [
    ...(IS_MAC ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => (focusedWindow() || newWindow()).addTab() },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: newWindow },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: menuOpen },
        { label: 'Open Recent', submenu: recentItems },
        { label: 'Create PDF from Images…', click: send('from-images') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('save-as') },
        { label: 'Save Flattened Copy…', click: send('save-flattened') },
        { label: 'Save with Password…', click: send('save-password') },
        { label: 'Reduce File Size…', click: send('compress') },
        { type: 'separator' },
        {
          label: 'Export',
          submenu: [
            { label: 'Pages as Images…', click: send('export-images') },
            { label: 'Text…', click: send('export-text') },
          ],
        },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: send('print') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => { const w = focusedWindow(); if (w?.active) w.closeTab(w.active); } },
        ...(IS_MAC ? [] : [{ role: 'quit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: 'Redo', accelerator: IS_MAC ? 'Cmd+Shift+Z' : 'Ctrl+Y', click: send('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: send('find') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: send('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: send('zoom-out') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: send('zoom-actual') },
        { label: 'Fit Width', accelerator: 'CmdOrCtrl+1', click: send('zoom-fit-width') },
        { label: 'Fit Page', accelerator: 'CmdOrCtrl+2', click: send('zoom-fit-page') },
        { type: 'separator' },
        { label: 'Toggle Page Thumbnails', accelerator: 'CmdOrCtrl+B', click: send('toggle-sidebar') },
        { label: 'Toggle Comments', accelerator: 'CmdOrCtrl+Shift+C', click: send('toggle-comments') },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: IS_MAC ? 'Cmd+Shift+]' : 'Ctrl+Tab', click: () => focusedWindow()?.cycle(1) },
        { label: 'Previous Tab', accelerator: IS_MAC ? 'Cmd+Shift+[' : 'Ctrl+Shift+Tab', click: () => focusedWindow()?.cycle(-1) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Toggle Developer Tools', accelerator: IS_MAC ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: () => focusedWindow()?.active?.view.webContents.toggleDevTools() },
      ],
    },
    {
      label: 'Page',
      submenu: [
        { label: 'Rotate Clockwise', accelerator: 'CmdOrCtrl+R', click: send('rotate-cw') },
        { label: 'Rotate Counterclockwise', accelerator: 'CmdOrCtrl+Shift+R', click: send('rotate-ccw') },
        { label: 'Crop Page…', click: send('tool-crop') },
        { type: 'separator' },
        { label: 'Insert Blank Page', click: send('insert-blank') },
        { label: 'Delete Page', click: send('delete-page') },
        { label: 'Combine with PDF…', click: send('merge') },
        { type: 'separator' },
        { label: 'Extract Pages…', click: send('extract-pages') },
        { label: 'Split Document…', click: send('split') },
        { type: 'separator' },
        { label: 'Page Numbers…', click: send('page-numbers') },
        { label: 'Header & Footer…', click: send('header-footer') },
        { label: 'Watermark…', click: send('watermark') },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        { label: 'Edit PDF Text', accelerator: 'CmdOrCtrl+E', click: send('tool-edittext') },
        { label: 'Recognize Text (OCR)…', accelerator: 'CmdOrCtrl+Shift+O', click: send('ocr') },
        { type: 'separator' },
        { label: 'Add Comment', click: send('tool-note') },
        { label: 'Sign…', click: send('tool-signature') },
        { label: 'Insert Date', click: send('insert-date') },
        { label: 'Add Form Field', click: send('tool-field') },
        { type: 'separator' },
        { label: 'Mark for Redaction', click: send('tool-redact') },
        { label: 'Apply Redactions…', click: send('apply-redactions') },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function menuOpen() {
  const dw = focusedWindow() || newWindow();
  const files = await showOpenDialog(dw.win);
  if (files.length) openFiles(files, dw);
}

async function openRecent(filePath) {
  try {
    await fs.access(filePath);
    openFiles([filePath]);
  } catch {
    dialog.showMessageBox({ type: 'warning', message: `“${path.basename(filePath)}” can't be found.`, detail: 'It may have been moved or deleted.' });
    recent = recent.filter((p) => p !== filePath);
    await writeJson('recent.json', recent);
    buildMenu();
  }
}

// ---- IPC: documents ---------------------------------------------------------------

async function readPdf(filePath) {
  const data = await fs.readFile(filePath);
  writablePaths.add(filePath);
  addRecent(filePath);
  return { path: filePath, name: path.basename(filePath), data: new Uint8Array(data) };
}

const ownerWindow = (e) => tabFor(e.sender)?.owner.win;

ipcMain.handle('pdf:open-dialog', async (e) => {
  const files = await showOpenDialog(ownerWindow(e));
  return files.length ? readPdf(files[0]) : null;
});

// Open via the toolbar: into this tab if it's empty, otherwise in new tabs.
ipcMain.handle('pdf:open-files', async (e, files) => {
  const tab = tabFor(e.sender);
  if (!files) files = await showOpenDialog(tab?.owner.win);
  if (files.length) openFiles(files, tab?.owner);
  return files.length;
});

ipcMain.handle('pdf:read', async (_e, filePath) => {
  if (typeof filePath !== 'string' || !/\.pdf$/i.test(filePath)) throw new Error('Not a PDF file');
  return readPdf(filePath);
});

ipcMain.handle('pdf:save-as', async (e, data, suggestedName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(ownerWindow(e), {
    defaultPath: suggestedName || 'Untitled.pdf',
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, data);
  writablePaths.add(filePath);
  addRecent(filePath);
  return { path: filePath, name: path.basename(filePath) };
});

ipcMain.handle('pdf:write', async (_e, filePath, data) => {
  if (!writablePaths.has(filePath)) throw new Error('Path was not opened by the user');
  await fs.writeFile(filePath, data);
  addRecent(filePath);
  return { path: filePath, name: path.basename(filePath) };
});

// Save any other file type (text export and the like).
ipcMain.handle('file:save', async (e, data, suggestedName, filter) => {
  const { canceled, filePath } = await dialog.showSaveDialog(ownerWindow(e), {
    defaultPath: suggestedName,
    filters: filter ? [filter] : [],
  });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, typeof data === 'string' ? data : Buffer.from(data));
  return { path: filePath, name: path.basename(filePath) };
});

// Save several files into a folder the user picks (split, image export).
ipcMain.handle('files:save-many', async (e, files, title) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(ownerWindow(e), {
    title: title || 'Choose a folder',
    buttonLabel: 'Save Here',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths.length) return null;
  const dir = filePaths[0];
  const written = [];
  for (const f of files) {
    const ext = path.extname(f.name);
    const stem = f.name.slice(0, f.name.length - ext.length);
    let target = path.join(dir, f.name);
    for (let n = 2; await fs.access(target).then(() => true, () => false); n++) target = path.join(dir, `${stem} (${n})${ext}`);
    await fs.writeFile(target, Buffer.from(f.data));
    written.push(target);
  }
  if (written.length) shell.showItemInFolder(written[0]);
  return { dir, count: written.length };
});

ipcMain.handle('images:open-dialog', async (e) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(ownerWindow(e), {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
  });
  if (canceled) return [];
  return Promise.all(filePaths.map(async (p) => ({ name: path.basename(p), data: new Uint8Array(await fs.readFile(p)) })));
});

// A PDF built in the renderer (e.g. from images) opens in a new tab.
ipcMain.handle('pdf:open-bytes', (e, data, name) => {
  const owner = tabFor(e.sender)?.owner || focusedWindow() || new DocWindow();
  owner.addTab({ restore: { meta: { fileName: name, filePath: null, fresh: true }, bytes: data } });
});

ipcMain.handle('app:info', () => ({
  userName: os.userInfo().username,
  platform: process.platform,
}));

ipcMain.handle('recent:list', () => recent);
ipcMain.handle('recent:open', (_e, filePath) => openRecent(filePath));

// Saved signatures live in the user's app data folder, not in documents.
ipcMain.handle('sig:list', () => readJson('signatures.json', []));
ipcMain.handle('sig:save', async (_e, sig) => {
  const list = await readJson('signatures.json', []);
  const next = [sig, ...list.filter((s) => s.id !== sig.id)].slice(0, 8);
  await writeJson('signatures.json', next);
  return next;
});
ipcMain.handle('sig:delete', async (_e, id) => {
  const next = (await readJson('signatures.json', [])).filter((s) => s.id !== id);
  await writeJson('signatures.json', next);
  return next;
});

ipcMain.on('recovery:save', (e, meta, bytes) => {
  const tab = tabFor(e.sender);
  if (tab) writeRecovery(tab.id, meta, bytes).catch(() => {});
});
ipcMain.on('recovery:clear', (e) => {
  const tab = tabFor(e.sender);
  if (tab) clearRecovery(tab.id);
});
ipcMain.on('recovery:allow-write', (e, filePath) => {
  if (filePath && tabFor(e.sender)) writablePaths.add(filePath);
});

// ---- IPC: installed fonts -----------------------------------------------------------
// Edited text can reuse the document's font. When the PDF only embeds a subset,
// the full font is looked up among the fonts installed on this computer.

const FONT_DIRS = {
  darwin: ['/System/Library/Fonts', '/Library/Fonts', path.join(os.homedir(), 'Library/Fonts')],
  win32: [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'), path.join(os.homedir(), 'AppData/Local/Microsoft/Windows/Fonts')],
  linux: ['/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.fonts'), path.join(os.homedir(), '.local/share/fonts')],
}[process.platform] || [];

// "ABCDEF+Arial,Bold" / "Arial-BoldMT" / "Arial Bold" all become "arialbold".
const normFontName = (n) => String(n || '').replace(/^[A-Z]{6}\+/, '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(psmt|mt|ps)$/, '');

let fontIndex = null;
function getFontIndex() {
  fontIndex ||= (async () => {
    const cached = await readJson('font-index.json', null);
    if (cached?.version === 1 && Date.now() - cached.built < 7 * 864e5) return cached.fonts;
    const fontkit = require('@pdf-lib/fontkit');
    const fonts = {};
    const walk = async (dir, depth) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && depth < 4) await walk(full, depth + 1);
        else if (/\.(ttf|otf)$/i.test(e.name)) {
          try {
            const f = fontkit.create(await fs.readFile(full));
            for (const name of [f.postscriptName, f.fullName]) {
              const key = normFontName(name);
              if (key && !fonts[key]) fonts[key] = full;
            }
          } catch {
            /* unreadable font file */
          }
        }
      }
    };
    for (const dir of FONT_DIRS) await walk(dir, 0);
    await writeJson('font-index.json', { version: 1, built: Date.now(), fonts });
    return fonts;
  })();
  return fontIndex;
}

ipcMain.handle('fonts:find', async (_e, names) => {
  const index = await getFontIndex();
  for (const name of names) {
    const file = index[normFontName(name)];
    if (file) return { path: file, data: new Uint8Array(await fs.readFile(file)) };
  }
  return null;
});

// ---- IPC: OCR ------------------------------------------------------------------
// Tesseract runs here (Node build, worker thread) with the bundled English model,
// so recognition works offline and never touches the renderer's CSP.

let ocrWorker = null;
let ocrClient = null;

function getOcrWorker() {
  if (!ocrWorker) {
    const { createWorker } = require('tesseract.js');
    const langPath = path.join(ROOT, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int');
    ocrWorker = createWorker('eng', 1, {
      langPath,
      gzip: true,
      cacheMethod: 'none',
      logger: (m) => {
        if (ocrClient && !ocrClient.isDestroyed()) ocrClient.send('ocr:progress', m);
      },
    }).catch((err) => {
      ocrWorker = null;
      throw err;
    });
  }
  return ocrWorker;
}

ipcMain.handle('ocr:recognize', async (e, png) => {
  const worker = await getOcrWorker();
  ocrClient = e.sender;
  const { data } = await worker.recognize(Buffer.from(png), {}, { blocks: true });
  const lines = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        lines.push({
          bbox: line.bbox,
          baseline: line.baseline,
          words: line.words
            .filter((w) => w.text.trim())
            .map((w) => ({ text: w.text, bbox: w.bbox, confidence: w.confidence })),
        });
      }
    }
  }
  return lines.filter((l) => l.words.length);
});

// ---- IPC: tab state ----------------------------------------------------------------

ipcMain.on('doc:state', (e, { dirty, title, filePath, hasDocument }) => {
  const tab = tabFor(e.sender);
  if (!tab) return;
  tab.doc = { dirty, title, filePath, hasDocument };
  tab.opening = false;
  tab.owner.updateStrip();
  if (tab === tab.owner.active) tab.owner.updateTitle();
});

ipcMain.on('win:force-close', (e) => {
  const tab = tabFor(e.sender);
  if (!tab) return;
  const dw = tab.owner;
  dw.closeTab(tab, { force: true });
  if (dw.closingAll && dw.tabs.length) dw.requestClose();
});

ipcMain.on('win:close-cancelled', (e) => {
  tabFor(e.sender)?.owner.cancelClose();
});

ipcMain.on('tabs:activate', (e, id) => {
  const dw = [...windows].find((w) => w.strip.webContents === e.sender);
  const tab = dw?.tabs.find((t) => t.id === id);
  if (tab) dw.activate(tab);
});
ipcMain.on('tabs:close', (e, id) => {
  const dw = [...windows].find((w) => w.strip.webContents === e.sender);
  const tab = dw?.tabs.find((t) => t.id === id);
  if (tab) dw.closeTab(tab);
});
ipcMain.on('tabs:new', (e) => {
  [...windows].find((w) => w.strip.webContents === e.sender)?.addTab();
});

// ---- App lifecycle ---------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const files = pdfArgs(argv);
    if (files.length) openFiles(files);
    else newWindow();
  });

  // macOS delivers "Open With…" / double-click as an event, possibly before ready.
  app.on('open-file', (e, filePath) => {
    e.preventDefault();
    if (app.isReady()) openFiles([filePath]);
    else pendingFiles.push(filePath);
  });

  app.whenReady().then(async () => {
    app.setName(APP_NAME);
    registerAppProtocol();
    recent = await readJson('recent.json', []);
    buildMenu();

    const recovered = await takeRecoveredDocuments();
    let restore = false;
    if (recovered.length && process.env.AGILITY_RESTORE) {
      restore = process.env.AGILITY_RESTORE === 'restore'; // automated tests skip the prompt
    } else if (recovered.length) {
      const choice = dialog.showMessageBoxSync({
        type: 'question',
        buttons: ['Restore', 'Discard'],
        defaultId: 0,
        cancelId: 1,
        message: `Agility didn't close properly. Restore ${recovered.length === 1 ? 'the unsaved document' : `${recovered.length} unsaved documents`}?`,
        detail: recovered.map((d) => d.meta.fileName || 'Untitled').join('\n'),
      });
      restore = choice === 0;
    }
    const files = [...pendingFiles, ...pdfArgs(process.argv)];
    const dw = new DocWindow();
    if (restore) {
      for (const doc of recovered) {
        if (doc.meta.filePath) writablePaths.add(doc.meta.filePath);
        dw.addTab({ restore: doc });
      }
    }
    for (const f of files) dw.addTab({ filePath: f });
    if (!dw.tabs.length) dw.addTab();

    app.on('activate', () => {
      if (!windows.size) newWindow();
    });
  });

  app.on('before-quit', (e) => {
    // Give every window a chance to ask about unsaved tabs; the last window to
    // close finishes the quit (see the 'closed' handler).
    if (!windows.size) return;
    e.preventDefault();
    quitting = true;
    for (const w of [...windows]) {
      if (!quitting) break;
      w.requestClose();
    }
  });

  app.on('will-quit', () => {
    ocrWorker?.then((w) => w.terminate()).catch(() => {});
  });

  app.on('window-all-closed', () => {
    if (!IS_MAC) app.quit();
  });
}
