"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("exportDialogApi", {
  getSummary: () => ipcRenderer.invoke("export:get-summary"),
  setBitrate: (bitrateMbps, expectedJobId, expectedRevision) => ipcRenderer.invoke("export:set-bitrate", { bitrateMbps, expectedJobId, expectedRevision }),
  startExport: (projectTitle, expectedJobId, expectedRevision) => ipcRenderer.invoke("export:start", { projectTitle, expectedJobId, expectedRevision }),
  cancelExport: () => ipcRenderer.invoke("export:cancel"),
  closeDialog: () => ipcRenderer.invoke("export:close-dialog"),
  openOutput: () => ipcRenderer.invoke("export:open-output"),
  onProgress: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("export:progress", listener);
    return () => ipcRenderer.removeListener("export:progress", listener);
  },
  onSummaryUpdated: callback => {
    const listener = (_event, summary) => callback(summary);
    ipcRenderer.on("export:summary-updated", listener);
    return () => ipcRenderer.removeListener("export:summary-updated", listener);
  },
});
