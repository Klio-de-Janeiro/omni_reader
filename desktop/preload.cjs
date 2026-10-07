const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) contextBridge.exposeInMainWorld('omniDesktop', {
  save: input => ipcRenderer.invoke('omni-save', input),
  openFile: input => ipcRenderer.invoke('omni-open-file', input),
  document: name => ipcRenderer.invoke('omni-document', name),
  fullscreen: enabled => ipcRenderer.invoke('omni-fullscreen', enabled),
  onFiles: callback => {
    const listener = (_event, files) => callback(files);
    ipcRenderer.on('omni-files', listener);
    void ipcRenderer.invoke('omni-ready');
    return () => ipcRenderer.removeListener('omni-files', listener);
  },
});
