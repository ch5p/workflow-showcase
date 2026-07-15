"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("exportDialogApi", {
  getSummary: () => ipcRenderer.invoke("export:get-summary"),
  startExport: projectTitle => ipcRenderer.invoke("export:start", { projectTitle }),
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
