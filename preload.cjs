"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("portableApi", {
  getJob: () => ipcRenderer.invoke("job:get"),
  getRenderSpec: () => ipcRenderer.invoke("app:get-render-spec"),
  getLanguage: () => ipcRenderer.invoke("app:get-language"),
  reloadCurrentJob: () => ipcRenderer.invoke("app:reload-current-job"),
  saveJob: payload => ipcRenderer.invoke("job:save", payload),
  selectXml: () => ipcRenderer.invoke("job:select-xml"),
  prepareDroppedXml: sourcePath => ipcRenderer.invoke("job:prepare-xml-path", sourcePath),
  chooseXmlImportMode: token => ipcRenderer.invoke("job:choose-xml-mode", token),
  commitXmlImport: payload => ipcRenderer.invoke("job:commit-xml", payload),
  discardPreparedXml: (token, reason) => ipcRenderer.invoke("job:discard-prepared-xml", { token, reason }),
  selectVideo: () => ipcRenderer.invoke("job:select-video"),
  prepareDroppedVideo: sourcePath => ipcRenderer.invoke("job:prepare-video-path", sourcePath),
  commitVideo: payload => ipcRenderer.invoke("job:commit-video", payload),
  discardPreparedVideo: (token, reason) => ipcRenderer.invoke("job:discard-prepared-video", { token, reason }),
  addReferences: (expectedJobId, expectedRevision) => ipcRenderer.invoke("job:add-references", { expectedJobId, expectedRevision }),
  getPathForFile: file => webUtils.getPathForFile(file),
  addDroppedReferences: (paths, expectedJobId, expectedRevision) => ipcRenderer.invoke("job:add-reference-paths", { paths, expectedJobId, expectedRevision }),
  deleteReference: (id, expectedJobId, expectedRevision) => ipcRenderer.invoke("job:delete-reference", { id, expectedJobId, expectedRevision }),
  backupCurrentJob: (expectedJobId, expectedRevision) => ipcRenderer.invoke("job:backup-current", { expectedJobId, expectedRevision }),
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
