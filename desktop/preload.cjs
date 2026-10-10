const { contextBridge, ipcRenderer, webUtils } = require('electron');
if (process.isMainFrame) contextBridge.exposeInMainWorld('omniDesktop', {
  save: input => ipcRenderer.invoke('omni-save', input),
  saveStart: name => ipcRenderer.invoke('omni-save-start', name),
  saveChunk: bytes => ipcRenderer.invoke('omni-save-chunk', bytes),
  saveFinish: cancel => ipcRenderer.invoke('omni-save-finish', cancel),
  pdf: html => ipcRenderer.invoke('omni-pdf', html),
  speechSettings: () => ipcRenderer.invoke('omni-speech-settings'),
  speechChoose: kind => ipcRenderer.invoke('omni-speech-choose', kind),
  speechRun: input => ipcRenderer.invoke('omni-speech-run', input),
  speechCancel: id => ipcRenderer.invoke('omni-speech-cancel', id),
  onSpeechProgress: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('omni-speech-progress', listener);
    return () => ipcRenderer.removeListener('omni-speech-progress', listener);
  },
  openFile: async (file, resources = {}) => {
    const sourcePath = webUtils.getPathForFile(file);
    return ipcRenderer.invoke('omni-open-file', { name: file.name, sourcePath, bytes: sourcePath ? undefined : await file.arrayBuffer(), imageSource: resources.imageSource, images: resources.images });
  },
  readImage: (source, relative) => ipcRenderer.invoke('omni-read-image', source, relative),
  document: name => ipcRenderer.invoke('omni-document', name),
  fullscreen: enabled => ipcRenderer.invoke('omni-fullscreen', enabled),
  onFiles: callback => {
    const listener = (_event, files) => callback(files);
    ipcRenderer.on('omni-files', listener);
    void ipcRenderer.invoke('omni-ready');
    return () => ipcRenderer.removeListener('omni-files', listener);
  },
});
