"use strict";

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createExportController } = require("./exporter.cjs");

const APP_ROOT = __dirname;
const JOB_ROOT = path.join(APP_ROOT, "current-job");
const SOURCE_ROOT = path.join(JOB_ROOT, "source");
const REFERENCES_ROOT = path.join(JOB_ROOT, "references");
const OUTPUT_ROOT = path.join(JOB_ROOT, "output");
const LOG_ROOT = path.join(JOB_ROOT, "logs");
const JOB_PATH = path.join(JOB_ROOT, "job.json");
const DEFAULT_CALLOUT = {
  enabled: true,
  position: "left",
  style: "line",
  startSeconds: 0.08,
  durationSeconds: 3.5,
  subtitle: "REFERENCE MAP · EDIT WORKFLOW",
};
const LOG_PATH = path.join(LOG_ROOT, "app.log");
const SMOKE_TEST = process.argv.includes("--smoke-test");
const EXPORT_SMOKE = process.argv.includes("--export-smoke");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function ensureJobFolders(){
  for(const directory of [JOB_ROOT, SOURCE_ROOT, REFERENCES_ROOT, OUTPUT_ROOT, LOG_ROOT]){
    fs.mkdirSync(directory, { recursive: true });
  }
}

function logEvent(event, detail = {}){
  ensureJobFolders();
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...detail });
  fs.appendFileSync(LOG_PATH, line + "\n", "utf8");
}

function emptyJob(){
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    xml: null,
    video: null,
    references: [],
    globalReferenceIds: [],
    shotMappings: {},
    projectTitle: "SEEDANCE 2.0",
    callout: { ...DEFAULT_CALLOUT },
    ui: { scale: 1.25 },
    output: { codec: "h264", bitrateMbps: 12, fps: 60 },
  };
}

function loadJob(){
  ensureJobFolders();
  if(!fs.existsSync(JOB_PATH)){
    const job = emptyJob();
    writeJob(job);
    return job;
  }
  try{
    return JSON.parse(fs.readFileSync(JOB_PATH, "utf8"));
  }catch(error){
    logEvent("job_read_failed", { message: error.message });
    const job = emptyJob();
    writeJob(job);
    return job;
  }
}

function writeJob(job){
  ensureJobFolders();
  const next = { ...job, version: 1, updatedAt: new Date().toISOString() };
  const temporary = JOB_PATH + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(temporary, JOB_PATH);
  return next;
}

function safeName(name){
  const normalized = path.basename(name).normalize("NFKC");
  return normalized.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim() || "file";
}

function normalizeProjectTitle(value){
  if(value === undefined || value === null) return "SEEDANCE 2.0";
  return String(value).replace(/\s+/g, " ").trim().slice(0, 40);
}

function normalizeCallout(value){
  const source = value && typeof value === "object" ? value : {};
  const position = source.position === "right" ? "right" : "left";
  const style = ["line", "label", "minimal"].includes(source.style) ? source.style : "line";
  const startValue = source.startSeconds === undefined ? DEFAULT_CALLOUT.startSeconds : Number(source.startSeconds);
  const startSeconds = Math.max(0, Math.min(60, Number.isFinite(startValue) ? startValue : DEFAULT_CALLOUT.startSeconds));
  const durationSeconds = Math.max(0.5, Math.min(30, Number(source.durationSeconds) || DEFAULT_CALLOUT.durationSeconds));
  return {
    enabled: source.enabled === undefined ? DEFAULT_CALLOUT.enabled : Boolean(source.enabled),
    position,
    style,
    startSeconds,
    durationSeconds,
    subtitle: source.subtitle === undefined
      ? DEFAULT_CALLOUT.subtitle
      : String(source.subtitle).replace(/\s+/g, " ").trim().slice(0, 60),
  };
}

function copyInto(sourcePath, destinationPath){
  if(path.resolve(sourcePath).toLowerCase() !== path.resolve(destinationPath).toLowerCase()){
    fs.copyFileSync(sourcePath, destinationPath);
  }
}

function referenceType(filePath){
  const extension = path.extname(filePath).toLowerCase();
  if([".mp4", ".mov", ".m4v", ".webm"].includes(extension)) return "video";
  if([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"].includes(extension)) return "image";
  return null;
}

function normalizeReferenceLabels(references){
  const counts = { image: 0, video: 0 };
  return (references || []).map(reference => {
    const type = reference.type === "video" ? "video" : "image";
    counts[type] += 1;
    return {
      ...reference,
      label: type.toUpperCase() + " " + String(counts[type]).padStart(2, "0"),
    };
  });
}

function publicFile(relativePath){
  if(!relativePath) return null;
  const absolutePath = path.join(JOB_ROOT, relativePath);
  return { relativePath, url: pathToFileURL(absolutePath).href, absolutePath };
}

function hydrateJob(job){
  return {
    ...job,
    projectTitle: normalizeProjectTitle(job.projectTitle),
    callout: normalizeCallout(job.callout),
    xml: job.xml ? { ...job.xml, ...publicFile(job.xml.relativePath) } : null,
    video: job.video ? { ...job.video, ...publicFile(job.video.relativePath) } : null,
    references: normalizeReferenceLabels(job.references).map(reference => ({
      ...reference,
      ...publicFile(reference.relativePath),
    })),
    paths: {
      jobRoot: JOB_ROOT,
      outputRoot: OUTPUT_ROOT,
      logPath: LOG_PATH,
    },
  };
}

const exportController = createExportController({
  BrowserWindow,
  appRoot: APP_ROOT,
  jobRoot: JOB_ROOT,
  outputRoot: OUTPUT_ROOT,
  logEvent,
});

let exportWindow = null;
let exportDialogContext = {};

function exportSummary(){
  const job = hydrateJob(loadJob());
  const durationSeconds = Math.max(0, Number(exportDialogContext.durationSeconds) || 0);
  const outputFps = Math.max(1, Number(job.output?.fps) || 60);
  return {
    projectTitle: job.projectTitle,
    format: "H.264",
    width: 1280,
    height: 1080,
    outputFps,
    sourceFps: Math.max(0, Number(exportDialogContext.sourceFps) || 0),
    bitrateMbps: Math.max(1, Number(job.output?.bitrateMbps) || 12),
    durationSeconds,
    totalFrames: durationSeconds ? Math.ceil(durationSeconds * outputFps) : 0,
    editCount: Math.max(0, Number(exportDialogContext.editCount) || 0),
    outputFolder: OUTPUT_ROOT,
    videoName: job.video?.name || "NO VIDEO",
    xmlName: job.xml?.name || "NO XML",
    ready: Boolean(job.xml?.relativePath && job.video?.relativePath),
  };
}

function notifyProjectTitle(projectTitle){
  for(const window of BrowserWindow.getAllWindows()){
    if(!window.isDestroyed()) window.webContents.send("project:title-updated", projectTitle);
  }
}

function openExportWindow(sender, context = {}){
  exportDialogContext = {
    durationSeconds: Math.max(0, Number(context.durationSeconds) || 0),
    sourceFps: Math.max(0, Number(context.sourceFps) || 0),
    editCount: Math.max(0, Number(context.editCount) || 0),
  };
  if(exportWindow && !exportWindow.isDestroyed()){
    exportWindow.webContents.send("export:summary-updated", exportSummary());
    exportWindow.focus();
    return true;
  }
  const parent = BrowserWindow.fromWebContents(sender) || undefined;
  exportWindow = new BrowserWindow({
    width: 520,
    height: 620,
    useContentSize: true,
    parent,
    modal: Boolean(parent),
    show: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    autoHideMenuBar: true,
    backgroundColor: "#f4f6f5",
    title: "Export H.264",
    webPreferences: {
      preload: path.join(APP_ROOT, "export-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      minimumFontSize: 0,
    },
  });
  exportWindow.loadFile(path.join(APP_ROOT, "src", "export-dialog.html"));
  logEvent("export_dialog_opened", { durationSeconds: exportDialogContext.durationSeconds });
  exportWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  exportWindow.webContents.on("will-navigate", event => event.preventDefault());
  exportWindow.once("ready-to-show", () => exportWindow?.show());
  exportWindow.on("closed", () => {
    if(exportController.isRunning()) exportController.cancel();
    logEvent("export_dialog_closed");
    exportWindow = null;
  });
  return true;
}

function createWindow(){
  const window = new BrowserWindow({
    width: 1360,
    height: 1040,
    minWidth: 1320,
    minHeight: 720,
    backgroundColor: "#d9dddb",
    autoHideMenuBar: true,
    show: !SMOKE_TEST && !EXPORT_SMOKE,
    webPreferences: {
      preload: path.join(APP_ROOT, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      minimumFontSize: 0,
      zoomFactor: 1,
    },
  });
  window.loadFile(path.join(APP_ROOT, "src", "index.html"));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  if(SMOKE_TEST){
    window.webContents.once("did-finish-load", async () => {
      try{
        await new Promise(resolve => setTimeout(resolve, 1200));
        const smokeXmlPath = process.env.PORTABLE_SMOKE_XML;
        if(smokeXmlPath && fs.existsSync(smokeXmlPath)){
          const xmlText = fs.readFileSync(smokeXmlPath, "utf8");
          const parsed = await window.webContents.executeJavaScript(
            `window.portableMvp.loadXmlText(${JSON.stringify(xmlText)})`
          );
          if(!parsed?.edits || !parsed?.shots){
            throw new Error("Real XML parser returned no edits or shots");
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        await window.webContents.executeJavaScript('document.getElementById("calloutSettings").setAttribute("open", "")');
        const result = await window.webContents.executeJavaScript(`({
          title: document.title,
          hasApi: Boolean(window.portableApi),
          hasWireframe: Boolean(window.wireframeApi),
          hasPreview: Boolean(document.getElementById("renderPreview")?.contentWindow?.portablePreview),
          shotRail: Boolean(document.getElementById("shotRail")),
          editOverlay: Boolean(document.getElementById("editOverlay")),
          calloutSettingsOpen: document.getElementById("calloutSettings")?.open,
          previewState: document.getElementById("renderPreview")?.contentWindow?.portablePreview?.getState(),
          shotItems: document.querySelectorAll("#shotRailList .shotRailItem").length,
          editStatus: document.getElementById("editCountStatus")?.textContent
        })`);
        if(!result.hasApi || !result.hasWireframe || !result.hasPreview || !result.shotRail || !result.editOverlay || !result.calloutSettingsOpen){
          throw new Error("Smoke contract failed: " + JSON.stringify(result));
        }
        if(process.env.PORTABLE_SMOKE_XML && (!result.shotItems || result.editStatus==="0 EDITS")){
          throw new Error("XML did not reach the parent SHOT rail: " + JSON.stringify(result));
        }
        const job = loadJob();
        if(job.xml?.relativePath && job.video?.relativePath){
          const playback = await window.webContents.executeJavaScript(`(async()=>{
            const bridge=document.getElementById("renderPreview").contentWindow.portablePreview;
            for(let attempt=0;attempt<30&&bridge.getState().readyState<1;attempt+=1){
              await new Promise(resolve=>setTimeout(resolve,100));
            }
            const items=document.querySelectorAll("#shotRailList .shotRailItem");
            (items[1]||items[0])?.click();
            await new Promise(resolve=>setTimeout(resolve,150));
            const sought=bridge.getState();
             bridge.playPause();
             await new Promise(resolve=>setTimeout(resolve,600));
             const playing=bridge.getState();
             const expectedPlayingSeek=window.wireframeApi.snapshot().shots[2]?.start||0;
             (items[2]||items[1]||items[0])?.click();
             await new Promise(resolve=>setTimeout(resolve,500));
             const playingSeek=bridge.getState();
             bridge.playPause();
             const shots=window.wireframeApi.snapshot().shots;
             const crossingStart=Math.max(0,(shots[1]?.end||0)-.1);
             bridge.seekFrame(crossingStart*bridge.getState().fps);
             const focusedButton=document.getElementById("loadXml");
             focusedButton.focus();
             focusedButton.dispatchEvent(new KeyboardEvent("keydown",{key:" ",code:"Space",bubbles:true,cancelable:true}));
             await new Promise(resolve=>setTimeout(resolve,500));
             const shortcutPlaying=bridge.getState();
             const syncedShot=document.querySelector("#shotRailList .shotRailItem.selected")?.dataset.shot||null;
             focusedButton.dispatchEvent(new KeyboardEvent("keyup",{key:" ",code:"Space",bubbles:true,cancelable:true}));
             focusedButton.dispatchEvent(new KeyboardEvent("keydown",{key:" ",code:"Space",bubbles:true,cancelable:true}));
             return {sought,playing,playingSeek,expectedPlayingSeek,shortcutPlaying,syncedShot,expectedSyncedShot:String(shots[2]?.id||"")};
          })()`);
          if(playback.sought.readyState<1 || playback.sought.currentTime<.5){
            throw new Error("SHOT seek failed: " + JSON.stringify(playback));
          }
           if(playback.playing.paused || playback.playing.currentTime<=playback.sought.currentTime+.1){
             throw new Error("Video playback failed: " + JSON.stringify(playback));
           }
           if(playback.playingSeek.paused || Math.abs(playback.playingSeek.currentTime-playback.expectedPlayingSeek)>.9){
             throw new Error("Playing SHOT seek drifted: " + JSON.stringify(playback));
           }
           if(playback.shortcutPlaying.paused || playback.syncedShot!==playback.expectedSyncedShot){
             throw new Error("Space shortcut or SHOT follow failed: " + JSON.stringify(playback));
           }
          result.playback=playback;
        }
        await window.webContents.executeJavaScript(`(()=>{
          const bridge=document.getElementById("renderPreview").contentWindow.portablePreview;
          bridge.setCalloutConfig({enabled:true,position:"left",style:"line",startSeconds:.08,durationSeconds:30,subtitle:"REFERENCE MAP · EDIT WORKFLOW"});
          bridge.seekFrame(2*bridge.getState().fps);
        })()`);
        await new Promise(resolve => setTimeout(resolve, 180));
        const image = await window.webContents.capturePage();
        fs.writeFileSync(path.join(OUTPUT_ROOT, "mvp-smoke.png"), image.toPNG());
        logEvent("smoke_passed", result);
        console.log("SMOKE_OK " + JSON.stringify(result));
        app.exit(0);
      }catch(error){
        logEvent("smoke_failed", { message: error.message });
        console.error("SMOKE_FAILED " + error.stack);
        app.exit(1);
      }
    });
  }
  if(EXPORT_SMOKE){
    window.webContents.once("did-finish-load", async () => {
      try{
        const result = await exportController.start(window.webContents, loadJob());
        console.log("EXPORT_SMOKE_OK " + JSON.stringify(result));
        app.exit(0);
      }catch(error){
        console.error("EXPORT_SMOKE_FAILED " + error.stack);
        app.exit(1);
      }
    });
  }
}

app.whenReady().then(() => {
  ensureJobFolders();
  logEvent("app_started", { appRoot: APP_ROOT });
  createWindow();
  app.on("activate", () => {
    if(BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if(process.platform !== "darwin") app.quit();
});

ipcMain.handle("job:get", () => hydrateJob(loadJob()));

ipcMain.handle("job:save", (_event, payload) => {
  const current = loadJob();
  const next = writeJob({
    ...current,
    globalReferenceIds: Array.isArray(payload?.globalReferenceIds) ? payload.globalReferenceIds : current.globalReferenceIds,
    shotMappings: payload?.shotMappings && typeof payload.shotMappings === "object" ? payload.shotMappings : current.shotMappings,
    projectTitle: payload?.projectTitle === undefined ? current.projectTitle : normalizeProjectTitle(payload.projectTitle),
    callout: payload?.callout === undefined ? current.callout : normalizeCallout(payload.callout),
    ui: payload?.ui && typeof payload.ui === "object" ? { ...current.ui, ...payload.ui } : current.ui,
  });
  logEvent("job_saved", {
    globalCount: next.globalReferenceIds.length,
    shotMappingCount: Object.keys(next.shotMappings || {}).length,
  });
  return hydrateJob(next);
});

ipcMain.handle("job:select-xml", async () => {
  const result = await dialog.showOpenDialog({
    title: "Load timeline XML",
    properties: ["openFile"],
    filters: [{ name: "Timeline XML", extensions: ["xml"] }],
  });
  if(result.canceled || !result.filePaths[0]) return null;
  const sourcePath = result.filePaths[0];
  const destinationPath = path.join(SOURCE_ROOT, "timeline.xml");
  copyInto(sourcePath, destinationPath);
  const current = loadJob();
  current.xml = {
    name: path.basename(sourcePath),
    relativePath: path.relative(JOB_ROOT, destinationPath).replaceAll("\\", "/"),
  };
  const next = writeJob(current);
  logEvent("xml_imported", { name: current.xml.name });
  return {
    job: hydrateJob(next),
    text: fs.readFileSync(destinationPath, "utf8"),
  };
});

ipcMain.handle("job:select-video", async () => {
  const result = await dialog.showOpenDialog({
    title: "Load H.264 source video",
    properties: ["openFile"],
    filters: [{ name: "Video", extensions: ["mp4", "mov", "m4v"] }],
  });
  if(result.canceled || !result.filePaths[0]) return null;
  const sourcePath = result.filePaths[0];
  const extension = path.extname(sourcePath).toLowerCase() || ".mp4";
  const destinationPath = path.join(SOURCE_ROOT, "video" + extension);
  copyInto(sourcePath, destinationPath);
  const current = loadJob();
  current.video = {
    name: path.basename(sourcePath),
    relativePath: path.relative(JOB_ROOT, destinationPath).replaceAll("\\", "/"),
  };
  const next = writeJob(current);
  logEvent("video_imported", { name: current.video.name });
  return hydrateJob(next);
});

function importReferencePaths(sourcePaths){
  const current = loadJob();
  const added = [];
  for(const candidate of sourcePaths || []){
    if(typeof candidate !== "string") continue;
    const sourcePath = path.resolve(candidate);
    if(!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) continue;
    const type = referenceType(sourcePath);
    if(!type) continue;
    const nextNumber = current.references.filter(reference => reference.type === type).length + 1;
    const id = type + "-" + String(nextNumber).padStart(2, "0") + "-" + Date.now().toString(36);
    const destinationName = id + "_" + safeName(path.basename(sourcePath));
    const destinationPath = path.join(REFERENCES_ROOT, destinationName);
    copyInto(sourcePath, destinationPath);
    const reference = {
      id,
      type,
      label: type.toUpperCase() + " " + String(nextNumber).padStart(2, "0"),
      originalName: path.basename(sourcePath),
      relativePath: path.relative(JOB_ROOT, destinationPath).replaceAll("\\", "/"),
    };
    current.references.push(reference);
    added.push(reference);
  }
  current.references = normalizeReferenceLabels(current.references);
  const next = writeJob(current);
  logEvent("references_imported", { count: added.length });
  return hydrateJob(next);
}

ipcMain.handle("job:add-references", async () => {
  const result = await dialog.showOpenDialog({
    title: "Add image or video references",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "References", extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif", "mp4", "mov", "m4v", "webm"] },
    ],
  });
  if(result.canceled || !result.filePaths.length) return null;
  return importReferencePaths(result.filePaths);
});

ipcMain.handle("job:add-reference-paths", (_event, sourcePaths) => importReferencePaths(sourcePaths));

ipcMain.handle("job:delete-reference", (_event, referenceId) => {
  if(typeof referenceId !== "string" || !referenceId) throw new Error("Invalid reference id");
  const current = loadJob();
  const reference = (current.references || []).find(item => item.id === referenceId);
  if(!reference) return { job: hydrateJob(current), fileDeleted: false, missing: true };

  current.references = normalizeReferenceLabels(current.references.filter(item => item.id !== referenceId));
  current.globalReferenceIds = (current.globalReferenceIds || []).filter(id => id !== referenceId);
  for(const [shotId, mapping] of Object.entries(current.shotMappings || {})){
    const refs = (mapping?.refs || []).filter(id => id !== referenceId);
    if(!refs.length && (mapping?.mode === "ADD" || mapping?.mode === "REPLACE")){
      delete current.shotMappings[shotId];
    }else{
      current.shotMappings[shotId] = { ...mapping, refs };
    }
  }

  const next = writeJob(current);
  let fileDeleted = false;
  let warning = null;
  try{
    const absolutePath = path.resolve(JOB_ROOT, reference.relativePath || "");
    const relativeToReferences = path.relative(path.resolve(REFERENCES_ROOT), absolutePath);
    const insideReferences = relativeToReferences && !relativeToReferences.startsWith("..") && !path.isAbsolute(relativeToReferences);
    if(!insideReferences) throw new Error("Reference path is outside current-job/references");
    if(fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
    fileDeleted = true;
  }catch(error){
    warning = error.message;
    logEvent("reference_file_delete_failed", { id: referenceId, message: warning });
  }
  logEvent("reference_deleted", { id: referenceId, fileDeleted });
  return { job: hydrateJob(next), fileDeleted, warning };
});

ipcMain.handle("job:read-xml", () => {
  const job = loadJob();
  if(!job.xml?.relativePath) return null;
  const xmlPath = path.join(JOB_ROOT, job.xml.relativePath);
  if(!fs.existsSync(xmlPath)) return null;
  return fs.readFileSync(xmlPath, "utf8");
});

ipcMain.handle("app:log", (_event, event, detail) => {
  logEvent(String(event || "renderer_event"), detail && typeof detail === "object" ? detail : {});
  return true;
});

ipcMain.handle("export:open-dialog", (event, context) => openExportWindow(event.sender, context));
ipcMain.handle("export:get-summary", () => exportSummary());
ipcMain.handle("export:start", async (event, payload) => {
  const projectTitle = normalizeProjectTitle(payload?.projectTitle);
  const job = writeJob({ ...loadJob(), projectTitle });
  logEvent("project_title_updated", { projectTitle });
  notifyProjectTitle(projectTitle);
  const window = BrowserWindow.fromWebContents(event.sender);
  if(window && !window.isDestroyed()) window.setClosable(false);
  try{
    return await exportController.start(event.sender, job);
  }finally{
    if(window && !window.isDestroyed()) window.setClosable(true);
  }
});
ipcMain.handle("export:cancel", () => exportController.cancel());
ipcMain.handle("export:close-dialog", () => {
  if(exportController.isRunning()) return false;
  if(exportWindow && !exportWindow.isDestroyed()) exportWindow.close();
  return true;
});
ipcMain.handle("export:open-output", () => shell.openPath(OUTPUT_ROOT));
