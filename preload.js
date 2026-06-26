const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('logsAPI', {
  onUpdate(callback) {
    ipcRenderer.on('logs:update', (_event, payload) => callback(payload));
  },
});
