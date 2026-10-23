// Narrow, explicit bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args));

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  info: () => ipcRenderer.invoke('app:info'),

  // Files
  openPdfDialog: () => ipcRenderer.invoke('pdf:open-dialog'),
  openFiles: (paths) => ipcRenderer.invoke('pdf:open-files', paths || null),
  openBytes: (data, name) => ipcRenderer.invoke('pdf:open-bytes', data, name),
  readPdf: (filePath) => ipcRenderer.invoke('pdf:read', filePath),
  saveAs: (data, suggestedName) => ipcRenderer.invoke('pdf:save-as', data, suggestedName),
  write: (filePath, data) => ipcRenderer.invoke('pdf:write', filePath, data),
  saveFile: (data, suggestedName, filter) => ipcRenderer.invoke('file:save', data, suggestedName, filter),
  saveMany: (files, title) => ipcRenderer.invoke('files:save-many', files, title),
  openImages: () => ipcRenderer.invoke('images:open-dialog'),
  openOffice: (paths) => ipcRenderer.invoke('office:open', paths || null),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },

  // Recent files and saved signatures
  recent: () => ipcRenderer.invoke('recent:list'),
  openRecent: (filePath) => ipcRenderer.invoke('recent:open', filePath),
  onRecentChanged: on('recent:changed'),
  signatures: () => ipcRenderer.invoke('sig:list'),
  saveSignature: (sig) => ipcRenderer.invoke('sig:save', sig),
  deleteSignature: (id) => ipcRenderer.invoke('sig:delete', id),

  // Crash recovery
  saveRecovery: (meta, bytes) => ipcRenderer.send('recovery:save', meta, bytes),
  clearRecovery: () => ipcRenderer.send('recovery:clear'),
  allowWrite: (filePath) => ipcRenderer.send('recovery:allow-write', filePath),
  onRestore: on('recovery:restore'),

  // Preferences
  prefs: () => ipcRenderer.invoke('prefs:get'),
  setPrefs: (next) => ipcRenderer.invoke('prefs:set', next),
  onPrefsChanged: on('prefs:changed'),

  // Installed fonts
  findFont: (names) => ipcRenderer.invoke('fonts:find', names),

  // OCR
  ocr: (png) => ipcRenderer.invoke('ocr:recognize', png),
  onOcrProgress: on('ocr:progress'),

  // Tab / window state
  setDocState: (state) => ipcRenderer.send('doc:state', state),
  forceClose: () => ipcRenderer.send('win:force-close'),
  closeCancelled: () => ipcRenderer.send('win:close-cancelled'),
  onMenu: on('menu'),
  onOpenPath: on('open-path'),
});
