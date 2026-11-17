// Bridge for the tab strip page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabsApi', {
  onUpdate: (cb) => ipcRenderer.on('tabs:update', (_e, tabs) => cb(tabs)),
  onFocus: (cb) => ipcRenderer.on('tabs:focus', () => cb()),
  // focus: false leaves the keyboard in the strip instead of moving it to the document.
  activate: (id, opts) => ipcRenderer.send('tabs:activate', id, opts),
  close: (id) => ipcRenderer.send('tabs:close', id),
  move: (id, index) => ipcRenderer.send('tabs:move', id, index),
  detach: (id) => ipcRenderer.send('tabs:detach', id),
  contextMenu: (id) => ipcRenderer.send('tabs:context', id),
  listTabs: () => ipcRenderer.send('tabs:list'),
  newTab: () => ipcRenderer.send('tabs:new'),
});
