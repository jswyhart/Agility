// Bridge for the tab strip page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabsApi', {
  onUpdate: (cb) => ipcRenderer.on('tabs:update', (_e, tabs) => cb(tabs)),
  activate: (id) => ipcRenderer.send('tabs:activate', id),
  close: (id) => ipcRenderer.send('tabs:close', id),
  newTab: () => ipcRenderer.send('tabs:new'),
});
