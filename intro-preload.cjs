"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("introBuilderApi", {
  getSummary: () => ipcRenderer.invoke("intro:get-summary"),
  selectExport: () => ipcRenderer.invoke("intro:select-export"),
  saveSettings: (settings, jobId, revision) => ipcRenderer.invoke("intro:save-settings", {
    settings,
    expectedJobId: jobId,
    expectedRevision: revision,
  }),
  startBuild: (settings, jobId, revision) => ipcRenderer.invoke("intro:start", {
    settings,
    expectedJobId: jobId,
    expectedRevision: revision,
  }),
  cancel: () => ipcRenderer.invoke("intro:cancel"),
  openOutput: () => ipcRenderer.invoke("intro:open-output"),
  closeWindow: () => ipcRenderer.invoke("intro:close-window"),
  onSummaryUpdated: callback => {
    const listener = (_event, summary) => callback(summary);
    ipcRenderer.on("intro:summary-updated", listener);
    return () => ipcRenderer.removeListener("intro:summary-updated", listener);
  },
  onProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("intro:progress", listener);
    return () => ipcRenderer.removeListener("intro:progress", listener);
  },
  onCloseRequested: callback => {
    const listener = () => callback();
    ipcRenderer.on("intro:close-requested", listener);
    return () => ipcRenderer.removeListener("intro:close-requested", listener);
  },
});
