// Agility — Electron main process.
// Owns windows, native menus, file dialogs and disk access. The renderer never
// touches the filesystem directly; it goes through the IPC handlers below.

const { app, BrowserWindow, ipcMain, dialog, Menu, protocol, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const APP_NAME = 'Agility';
const ROOT = __dirname;
const SERVED_DIRS = ['src', 'node_modules/pdfjs-dist', 'node_modules/pdf-lib/dist', 'node_modules/@fontsource'].map((d) =>
  path.join(ROOT, d)
);
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

function createWindow(filePath) {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#1b1c1f',
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.docState = { dirty: false };
  win.once('ready-to-show', () => win.show());
  win.webContents.once('did-finish-load', () => {
    if (filePath) win.webContents.send('open-path', filePath);
  });
  // Links inside PDFs or the UI open in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('close', (e) => {
    if (!win.docState.dirty || win.forceClose) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'Do you want to save the changes you made?',
      detail: "Your changes will be lost if you don't save them.",
    });
    if (choice === 1) return;
    e.preventDefault();
    if (choice === 0) win.webContents.send('menu', 'save-and-close');
  });

  win.loadURL('app://bundle/src/index.html');
  return win;
}

function openInWindow(filePath) {
  const target = BrowserWindow.getAllWindows().find((w) => !w.docState.hasDocument);
  if (target) {
    target.webContents.send('open-path', filePath);
    target.focus();
  } else {
    createWindow(filePath);
  }
}

function send(action) {
  return () => BrowserWindow.getFocusedWindow()?.webContents.send('menu', action);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('save-as') },
        { type: 'separator' },
        { label: 'Combine with PDF…', click: send('merge') },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: send('print') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: 'Redo', accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y', click: send('redo') },
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
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Page',
      submenu: [
        { label: 'Rotate Clockwise', accelerator: 'CmdOrCtrl+R', click: send('rotate-cw') },
        { label: 'Rotate Counterclockwise', accelerator: 'CmdOrCtrl+Shift+R', click: send('rotate-ccw') },
        { type: 'separator' },
        { label: 'Insert Blank Page', click: send('insert-blank') },
        { label: 'Delete Page', click: send('delete-page') },
        { label: 'Extract Page as PDF…', click: send('extract-page') },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        { label: 'Edit PDF Text', accelerator: 'CmdOrCtrl+E', click: send('tool-edittext') },
        { label: 'Recognize Text (OCR)…', accelerator: 'CmdOrCtrl+Shift+O', click: send('ocr') },
        { label: 'Sign…', click: send('tool-signature') },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC ----------------------------------------------------------------

async function readPdf(filePath) {
  const data = await fs.readFile(filePath);
  writablePaths.add(filePath);
  return { path: filePath, name: path.basename(filePath), data: new Uint8Array(data) };
}

ipcMain.handle('pdf:open-dialog', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
  });
  return canceled ? null : readPdf(filePaths[0]);
});

ipcMain.handle('pdf:read', async (_e, filePath) => {
  if (typeof filePath !== 'string' || !/\.pdf$/i.test(filePath)) throw new Error('Not a PDF file');
  return readPdf(filePath);
});

ipcMain.handle('pdf:save-as', async (e, data, suggestedName) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: suggestedName || 'Untitled.pdf',
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, data);
  writablePaths.add(filePath);
  return { path: filePath, name: path.basename(filePath) };
});

ipcMain.handle('pdf:write', async (_e, filePath, data) => {
  if (!writablePaths.has(filePath)) throw new Error('Path was not opened by the user');
  await fs.writeFile(filePath, data);
  return { path: filePath, name: path.basename(filePath) };
});

// ---- OCR ------------------------------------------------------------------
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

ipcMain.on('doc:state', (e, { dirty, title, filePath, hasDocument }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  win.docState = { dirty, hasDocument };
  win.setTitle(title ? `${title}${dirty ? ' •' : ''} — ${APP_NAME}` : APP_NAME);
  if (process.platform === 'darwin') {
    win.setDocumentEdited(dirty);
    win.setRepresentedFilename(filePath || '');
  }
});

ipcMain.on('win:force-close', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  win.forceClose = true;
  win.close();
});

// ---- App lifecycle --------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const files = pdfArgs(argv);
    if (files.length) files.forEach(openInWindow);
    else createWindow();
  });

  // macOS delivers "Open With…" / double-click as an event, possibly before ready.
  app.on('open-file', (e, filePath) => {
    e.preventDefault();
    if (app.isReady()) openInWindow(filePath);
    else pendingFiles.push(filePath);
  });

  app.whenReady().then(() => {
    app.setName(APP_NAME);
    registerAppProtocol();
    buildMenu();
    const files = [...pendingFiles, ...pdfArgs(process.argv)];
    if (files.length) files.forEach((f) => createWindow(f));
    else createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('will-quit', () => {
    ocrWorker?.then((w) => w.terminate()).catch(() => {});
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
