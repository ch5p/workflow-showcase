"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("portableApi", {
  getJob: () => ipcRenderer.invoke("job:get"),
  saveJob: payload => ipcRenderer.invoke("job:save", payload),
  selectXml: () => ipcRenderer.invoke("job:select-xml"),
  selectVideo: () => ipcRenderer.invoke("job:select-video"),
  addReferences: () => ipcRenderer.invoke("job:add-references"),
  getPathForFile: file => webUtils.getPathForFile(file),
  addDroppedReferences: paths => ipcRenderer.invoke("job:add-reference-paths", paths),
  deleteReference: id => ipcRenderer.invoke("job:delete-reference", id),
  readXml: () => ipcRenderer.invoke("job:read-xml"),
  openOutput: () => ipcRenderer.invoke("export:open-output"),
  openExportDialog: context => ipcRenderer.invoke("export:open-dialog", context),
  onProjectTitleUpdated: callback => {
    const listener = (_event, projectTitle) => callback(projectTitle);
    ipcRenderer.on("project:title-updated", listener);
    return () => ipcRenderer.removeListener("project:title-updated", listener);
  },
  log: (event, detail = {}) => ipcRenderer.invoke("app:log", event, detail),
});
