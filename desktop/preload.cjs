'use strict';
// Exposes a minimal, fixed API to the editor page. The page never gets Node
// or file-system access; the main process owns all file I/O.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mveDesktop', {
  codeChanged: (code) => {
    if (typeof code === 'string') ipcRenderer.send('mve:code-changed', code);
  },
  onLoadDocument: (callback) => {
    ipcRenderer.on('mve:load-document', (_event, doc) => callback(doc));
  },
  ready: () => ipcRenderer.invoke('mve:ready')
});
