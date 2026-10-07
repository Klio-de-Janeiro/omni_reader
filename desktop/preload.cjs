const { contextBridge, ipcRenderer, webUtils } = require('electron');
if (process.isMainFrame) contextBridge.exposeInMainWorld('omniDesktop', {
  save: input => ipcRenderer.invoke('omni-save', input),
  openFile: async (file, resources = {}) => ipcRenderer.invoke('omni-open-file', {
    name: file.name, bytes: await file.arrayBuffer(), sourcePath: webUtils.getPathForFile(file),
    imageSource: resources.imageSource, images: resources.images
  }),
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
