'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const on = (ch) => (cb) => ipcRenderer.on(ch, (_e, p) => cb(p));
contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('init'),
  command: (name) => ipcRenderer.invoke('command', name),
  askReply: (id, value) => ipcRenderer.send('ask-reply', { id, value }),
  onStatus: on('status'), onStatusText: on('status-text'), onLog: on('log'),
  onAsk: on('ask'), onAskCancel: on('ask-cancel'), onBusy: on('busy'),
});
