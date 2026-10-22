// Narrow, explicit bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  openPdfDialog: () => ipcRenderer.invoke('pdf:open-dialog'),
  readPdf: (filePath) => ipcRenderer.invoke('pdf:read', filePath),
  saveAs: (data, suggestedName) => ipcRenderer.invoke('pdf:save-as', data, suggestedName),
  write: (filePath, data) => ipcRenderer.invoke('pdf:write', filePath, data),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  setDocState: (state) => ipcRenderer.send('doc:state', state),
  forceClose: () => ipcRenderer.send('win:force-close'),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
  onOpenPath: (cb) => ipcRenderer.on('open-path', (_e, filePath) => cb(filePath)),
});
