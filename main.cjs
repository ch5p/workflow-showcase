"use strict";

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createExportController } = require("./exporter.cjs");
const { CLASSIC_RENDER_SPEC, resolveRenderSpec, publicRenderSpec } = require("./render-spec.cjs");
const { cleanupSiblingStagingFiles, fsyncExistingFile, replaceByRenameWithRetry, writeTextAtomically } = require("./durable-file.cjs");
const { ensureDirectoryNoLink, resolveOwnedRelativeFile } = require("./owned-path.cjs");
const { resolvePreferredLanguage, mainText } = require("./strings.cjs");
const { createJobBackup } = require("./job-backup.cjs");
const {
  inspectInputFile,
  prepareXmlCandidate,
  discardPreparedCandidate,
  commitPreparedXml,
  commitPreparedXmlUpdate,
  recoverXmlTransactions,
} = require("./job-lifecycle.cjs");
const { reconcileTimelineMappings } = require("./timeline-reconcile.cjs");
const {
  prepareVideoCandidate,
  discardPreparedVideoCandidate,
  commitPreparedVideo,
  recoverVideoTransactions,
} = require("./video-lifecycle.cjs");

const APP_ROOT = __dirname;
const SMOKE_TEST = process.argv.includes("--smoke-test");
const EXPORT_SMOKE = process.argv.includes("--export-smoke");
const TEST_JOB_ROOT = process.env.PORTABLE_TEST_JOB_ROOT;
if((SMOKE_TEST||EXPORT_SMOKE)&&!TEST_JOB_ROOT){
  throw new Error("Smoke tests require an isolated PORTABLE_TEST_JOB_ROOT. Use npm run smoke.");
}
if(TEST_JOB_ROOT&&!(SMOKE_TEST||EXPORT_SMOKE)){
  throw new Error("PORTABLE_TEST_JOB_ROOT is test-only.");
}
const JOB_ROOT = TEST_JOB_ROOT ? path.resolve(TEST_JOB_ROOT) : path.join(APP_ROOT, "current-job");
if(TEST_JOB_ROOT){
  const relativeToApp=path.relative(APP_ROOT,JOB_ROOT);
  if(!path.isAbsolute(JOB_ROOT)||!relativeToApp||(!relativeToApp.startsWith("..")&&!path.isAbsolute(relativeToApp))){
    throw new Error("Smoke Job root must be an absolute directory outside the app root.");
  }
  const testStateRoot=path.join(path.dirname(JOB_ROOT),"electron-state");
  app.setPath("userData",path.join(testStateRoot,"user-data"));
  app.setPath("sessionData",path.join(testStateRoot,"session-data"));
  app.disableHardwareAcceleration();
}
const SINGLE_INSTANCE_LOCK = app.requestSingleInstanceLock();
if(!SINGLE_INSTANCE_LOCK) app.quit();
const SOURCE_ROOT = path.join(JOB_ROOT, "source");
const REFERENCES_ROOT = path.join(JOB_ROOT, "references");
const OUTPUT_ROOT = path.join(JOB_ROOT, "output");
const LOG_ROOT = path.join(JOB_ROOT, "logs");
const JOB_PATH = path.join(JOB_ROOT, "job.json");
const BUNDLED_DEMO_ROOT = path.join(APP_ROOT, "fixtures", "premiere-export-kit", "public-fixture");
const BUNDLED_DEMO_XML = path.join(BUNDLED_DEMO_ROOT, "premiere-synthetic.xml");
const BUNDLED_DEMO_VIDEO = path.join(BUNDLED_DEMO_ROOT, "premiere-synthetic-final.mp4");
const DEFAULT_CALLOUT = {
  enabled: true,
  position: "left",
  style: "line",
  startSeconds: 0.08,
  durationSeconds: 3.5,
  subtitle: "WORKFLOW SHOWCASE · EDIT WORKFLOW",
};
const DEFAULT_PROJECT_TITLE = "UNTITLED PROJECT";
const LOG_PATH = path.join(LOG_ROOT, "app.log");
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v"];
const VIDEO_MAX_BYTES = 512 * 1024 * 1024 * 1024;
const REFERENCE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".mp4", ".mov", ".m4v", ".webm"];
const REFERENCE_MAX_BYTES = 64 * 1024 * 1024 * 1024;
const PREPARED_XML_TTL_MS = 10 * 60 * 1000;
const PREPARED_VIDEO_TTL_MS = 10 * 60 * 1000;
const preparedXmlImports = new Map();
const preparedVideoImports = new Map();
let recoveryRequired = false;
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function ensureJobFolders(){
  ensureDirectoryNoLink(JOB_ROOT, "Current Job");
  ensureDirectoryNoLink(SOURCE_ROOT, "Current Job source");
  ensureDirectoryNoLink(REFERENCES_ROOT, "Current Job references");
  ensureDirectoryNoLink(OUTPUT_ROOT, "Current Job output");
  ensureDirectoryNoLink(LOG_ROOT, "Current Job logs");
}

function logEvent(event, detail = {}){
  try{
    ensureJobFolders();
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...detail });
    fs.appendFileSync(LOG_PATH, line + "\n", "utf8");
    return true;
  }catch(error){
    console.error("APP_LOG_FAILED " + String(event) + " " + (error.code || "WRITE_FAILED"));
    return false;
  }
}

function emptyJob(){
  const now = new Date().toISOString();
  return {
    version: 1,
    jobId: randomUUID(),
    revision: 0,
    createdAt: now,
    updatedAt: now,
    xml: null,
    video: null,
    references: [],
    globalReferenceIds: [],
    shotMappings: {},
    timelineShots: [],
    orphanedShotMappings: [],
    projectTitle: DEFAULT_PROJECT_TITLE,
    callout: { ...DEFAULT_CALLOUT },
    ui: { scale: 1.25 },
    output: { codec: CLASSIC_RENDER_SPEC.codec, bitrateMbps: CLASSIC_RENDER_SPEC.bitrateMbps, fps: CLASSIC_RENDER_SPEC.fps },
  };
}

function installBundledDemoFile(sourcePath, destinationPath, label){
  const inspected = inspectInputFile(
    sourcePath,
    path.extname(sourcePath).toLowerCase() === ".xml" ? [".xml"] : VIDEO_EXTENSIONS,
    path.extname(sourcePath).toLowerCase() === ".xml" ? 64 * 1024 * 1024 : VIDEO_MAX_BYTES,
  );
  if(fs.existsSync(destinationPath)){
    const existing = fs.lstatSync(destinationPath);
    if(existing.isSymbolicLink() || !existing.isFile()) throw new Error(label + " destination is unsafe");
    fs.unlinkSync(destinationPath);
  }
  const stagedPath = path.join(SOURCE_ROOT, ".bundled-demo-" + randomUUID() + ".tmp");
  fs.copyFileSync(inspected.absolutePath, stagedPath, fs.constants.COPYFILE_EXCL);
  fsyncExistingFile(stagedPath);
  replaceByRenameWithRetry(stagedPath, destinationPath, { label });
  return inspected;
}

function createBundledDemoJob(){
  ensureJobFolders();
  const xml = installBundledDemoFile(BUNDLED_DEMO_XML, path.join(SOURCE_ROOT, "timeline.xml"), "Bundled demo XML");
  const video = installBundledDemoFile(BUNDLED_DEMO_VIDEO, path.join(SOURCE_ROOT, "video.mp4"), "Bundled demo video");
  const next = writeJob({
    ...emptyJob(),
    demo: true,
    xml: { name: xml.name, relativePath: "source/timeline.xml" },
    video: { name: video.name, relativePath: "source/video.mp4" },
    projectTitle: "SYNTHETIC TIMELINE",
  }, { preserveDemo: true });
  logEvent("starter_demo_seeded", { jobId: next.jobId, xmlName: xml.name, videoName: video.name });
  return next;
}

function isPlainObject(value){
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateStoredRelativePath(relativePath, ownedRoot, label){
  return resolveOwnedRelativeFile({ jobRoot: JOB_ROOT, ownedRoot, relativePath, label });
}

function validateJobShape(job){
  if(!isPlainObject(job) || job.version !== 1) throw new Error("Unsupported or invalid Job schema version");
  for(const [label, value, ownedRoot] of [
    ["xml", job.xml, SOURCE_ROOT],
    ["video", job.video, SOURCE_ROOT],
  ]){
    if(value === null) continue;
    if(!isPlainObject(value) || typeof value.name !== "string") throw new Error(label + " record is invalid");
    validateStoredRelativePath(value.relativePath, ownedRoot, label);
  }
  if(!Array.isArray(job.references)) throw new Error("references must be an array");
  const referenceIds = new Set();
  for(const reference of job.references){
    if(!isPlainObject(reference) || typeof reference.id !== "string" || !reference.id ||
        !["image", "video"].includes(reference.type) || referenceIds.has(reference.id)){
      throw new Error("reference record is invalid");
    }
    validateStoredRelativePath(reference.relativePath, REFERENCES_ROOT, "reference");
    referenceIds.add(reference.id);
  }
  if(!Array.isArray(job.globalReferenceIds) || job.globalReferenceIds.some(id => typeof id !== "string")){
    throw new Error("globalReferenceIds must be a string array");
  }
  if(!isPlainObject(job.shotMappings)) throw new Error("shotMappings must be an object");
  for(const mapping of Object.values(job.shotMappings)){
    if(!isPlainObject(mapping) || !Array.isArray(mapping.refs) || mapping.refs.some(id => typeof id !== "string")){
      throw new Error("shotMappings record is invalid");
    }
  }
  if(job.timelineShots !== undefined && !Array.isArray(job.timelineShots)) throw new Error("timelineShots must be an array");
  if(job.orphanedShotMappings !== undefined && !Array.isArray(job.orphanedShotMappings)){
    throw new Error("orphanedShotMappings must be an array");
  }
  if((job.timelineShots?.length || 0) > 0 || (job.orphanedShotMappings?.length || 0) > 0){
    // RED ZONE: persisted reconcile metadata must stay anonymous and exhaustive.
    reconcileTimelineMappings({
      previousShots: job.timelineShots || [],
      nextShots: job.timelineShots || [],
      shotMappings: job.shotMappings,
      orphanedShotMappings: job.orphanedShotMappings || [],
    });
  }
  if(job.projectTitle !== undefined && typeof job.projectTitle !== "string") throw new Error("projectTitle must be a string");
  if(job.callout !== undefined && !isPlainObject(job.callout)) throw new Error("callout must be an object");
  if(job.demo !== undefined && typeof job.demo !== "boolean") throw new Error("demo must be a boolean");
  if(!isPlainObject(job.ui) || !isPlainObject(job.output)) throw new Error("ui and output must be objects");
  if(job.ui.language !== undefined && !["en", "ko"].includes(job.ui.language)) throw new Error("ui.language must be en or ko");
  return job;
}

function loadJob(){
  ensureJobFolders();
  if(!fs.existsSync(JOB_PATH)){
    try{
      return createBundledDemoJob();
    }catch(error){
      logEvent("starter_demo_seed_failed", { code: error.code || "DEMO_SEED_FAILED", message: error.message });
      return writeJob(emptyJob());
    }
  }
  try{
    const parsed = validateJobShape(JSON.parse(fs.readFileSync(JOB_PATH, "utf8")));
    if(typeof parsed.jobId !== "string" || !parsed.jobId || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0){
      if(typeof parsed.jobId !== "string" || !parsed.jobId) parsed.jobId = randomUUID();
      parsed.revision = Number.isSafeInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0;
      return writeJob(parsed);
    }
    return parsed;
  }catch(error){
    try{logEvent("job_read_failed", { message: error.message })}catch{}
    const blocked = new Error("current-job/job.json is unreadable. The original file was kept.");
    blocked.code = "JOB_READ_FAILED";
    blocked.cause = error;
    throw blocked;
  }
}

function currentLanguageState(){
  let storedLanguage = null;
  try{ storedLanguage = loadJob().ui?.language ?? null; }catch{}
  let preferredSystemLanguages = [];
  try{
    const detected = app.getPreferredSystemLanguages();
    if(Array.isArray(detected)) preferredSystemLanguages = detected.filter(value => typeof value === "string" && value.trim());
  }catch{}
  let systemLocale = "";
  try{ systemLocale = app.getSystemLocale(); }catch{}
  let appLocale = "";
  try{ appLocale = app.getLocale(); }catch{}
  return {
    storedLanguage,
    preferredSystemLanguages,
    systemLocale,
    appLocale,
    resolved: resolvePreferredLanguage(storedLanguage, preferredSystemLanguages, systemLocale, appLocale),
  };
}
function currentLanguage(){ return currentLanguageState().resolved; }
const T = key => mainText(currentLanguage(), key);

function writeJob(job, { preserveDemo = false } = {}){
  ensureJobFolders();
  const jobToWrite = { ...job };
  if(!preserveDemo) delete jobToWrite.demo;
  const next = {
    ...jobToWrite,
    version: 1,
    jobId: typeof jobToWrite.jobId === "string" && jobToWrite.jobId ? jobToWrite.jobId : randomUUID(),
    revision: (Number.isSafeInteger(jobToWrite.revision) && jobToWrite.revision >= 0 ? jobToWrite.revision : 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  validateJobShape(next);
  try{
    writeTextAtomically(JOB_PATH, JSON.stringify(next, null, 2), { label: "Current Job" });
  }catch(error){
    try{logEvent("job_write_failed", {
      code: error.code || "WRITE_FAILED",
      staged: error.stagedPath ? path.basename(error.stagedPath) : null,
    })}catch{}
    const failure = new Error(T("job_save_failed"));
    failure.code = "JOB_WRITE_FAILED";
    failure.cause = error;
    throw failure;
  }
  try{
    const removed = cleanupSiblingStagingFiles(JOB_PATH);
    if(removed) logEvent("job_write_staging_cleaned", { count: removed });
  }catch(error){
    try{logEvent("job_write_cleanup_deferred", { code: error.code || "CLEANUP_FAILED" })}catch{}
  }
  return next;
}

function safeName(name){
  const normalized = path.basename(name).normalize("NFKC");
  return normalized.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim() || "file";
}

function normalizeProjectTitle(value){
  if(value === undefined || value === null) return DEFAULT_PROJECT_TITLE;
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

function staleJobError(operation){
  const error = new Error("Current Job changed. Please try the action again.");
  error.code = "JOB_STALE";
  error.operation = operation;
  return error;
}

function requireRuntimeReady(operation){
  if(!recoveryRequired) return;
  const error = new Error("JOB_RECOVERY_REQUIRED: restart the app and inspect current-job/logs/app.log.");
  error.code = "JOB_RECOVERY_REQUIRED";
  error.operation = operation;
  throw error;
}

function requireExpectedJob(expectedJobId, expectedRevision, operation){
  requireRuntimeReady(operation);
  const current = loadJob();
  if(typeof expectedJobId === "string" && expectedJobId === current.jobId &&
      Number.isSafeInteger(expectedRevision) && expectedRevision === current.revision) return current;
  logEvent("job_mutation_rejected_stale", {
    operation,
    expectedJobId: typeof expectedJobId === "string" ? expectedJobId : null,
    currentJobId: current.jobId,
    expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
    currentRevision: current.revision,
  });
  throw staleJobError(operation);
}

function discardPreparedXmlEntry(entry, reason){
  if(!entry) return false;
  preparedXmlImports.delete(entry.token);
  try{
    const discarded = discardPreparedCandidate(entry.preparation);
    logEvent(reason === "validation-failed" ? "job_xml_validation_failed" : "job_xml_discarded", {
      transactionId: entry.token,
      xmlName: entry.name,
      reason: String(reason || "discarded").slice(0, 60),
    });
    return discarded;
  }catch(error){
    logEvent("job_xml_cleanup_deferred", {
      transactionId: entry.token,
      code: error.code || "DISCARD_FAILED",
    });
    return false;
  }
}

function prunePreparedXmlImports(){
  const now = Date.now();
  for(const entry of preparedXmlImports.values()){
    if(entry.expiresAt <= now) discardPreparedXmlEntry(entry, "expired");
  }
}

function discardPreparedXmlForOwner(ownerId){
  for(const entry of [...preparedXmlImports.values()]){
    if(entry.ownerId === ownerId) discardPreparedXmlEntry(entry, "superseded");
  }
}

function prepareXmlImport(event, sourcePath, inputMethod){
  requireRuntimeReady("xml_prepare");
  if(exportController.isRunning()) throw new Error(T("export_block_xml"));
  prunePreparedXmlImports();
  discardPreparedXmlForOwner(event.sender.id);
  const preparation = prepareXmlCandidate({ sourcePath, logRoot: LOG_ROOT, inputMethod });
  const text = fs.readFileSync(preparation.candidatePath, "utf8");
  const entry = {
    token: preparation.transactionId,
    preparation,
    ownerId: event.sender.id,
    name: preparation.inputName,
    text,
    mode: null,
    expiresAt: Date.now() + PREPARED_XML_TTL_MS,
  };
  preparedXmlImports.set(entry.token, entry);
  logEvent("job_xml_prepared", {
    transactionId: entry.token,
    xmlName: entry.name,
    inputMethod,
    size: preparation.inputSize,
  });
  return { token: entry.token, name: entry.name, text: entry.text };
}

function preparedXmlEntry(event, token){
  prunePreparedXmlImports();
  if(typeof token !== "string" || !token) throw new Error("Prepared XML token is required.");
  const entry = preparedXmlImports.get(token);
  if(!entry || entry.ownerId !== event.sender.id) throw new Error("Prepared XML is unavailable or expired.");
  return entry;
}

function newJobForXml(current, xmlName, timelineShots=[]){
  const base = emptyJob();
  return {
    ...base,
    revision: 1,
    xml: { name: xmlName, relativePath: "source/timeline.xml" },
    video: null,
    references: [],
    globalReferenceIds: [],
    shotMappings: {},
    timelineShots,
    orphanedShotMappings: [],
    projectTitle: "",
    callout: { ...DEFAULT_CALLOUT },
    ui: current.ui && typeof current.ui === "object" ? { ...base.ui, ...current.ui } : base.ui,
    output: current.output && typeof current.output === "object" ? { ...base.output, ...current.output } : base.output,
  };
}

function normalizeTimelineShots(value){
  if(!Array.isArray(value) || value.length > 10000) throw new Error("Timeline SHOT metadata is invalid.");
  const ids = new Set();
  return value.map((shot, index) => {
    if(!isPlainObject(shot)) throw new Error("Timeline SHOT metadata is invalid.");
    const id = String(shot.id ?? "");
    const identityKey = String(shot.identityKey || "");
    const nameKey = String(shot.nameKey || "");
    const startFrame = Number(shot.startFrame);
    const endFrame = Number(shot.endFrame);
    if(!id || ids.has(id) || !/^src-[0-9a-f]{16}$/i.test(identityKey) ||
        !/^name-[0-9a-f]{16}$/i.test(nameKey) || !Number.isSafeInteger(startFrame) ||
        !Number.isSafeInteger(endFrame) || startFrame < 0 || endFrame <= startFrame){
      throw new Error("Timeline SHOT metadata is invalid.");
    }
    ids.add(id);
    const occurrences = (Array.isArray(shot.occurrences) ? shot.occurrences : []).map(occurrence => {
      const next = {
        startFrame: Number(occurrence?.startFrame),
        endFrame: Number(occurrence?.endFrame),
        inFrame: Number(occurrence?.inFrame),
        outFrame: Number(occurrence?.outFrame),
      };
      if(Object.values(next).some(frame => !Number.isSafeInteger(frame) || frame < 0) ||
          next.endFrame <= next.startFrame || next.outFrame <= next.inFrame ||
          next.startFrame < startFrame || next.endFrame > endFrame){
        throw new Error("Timeline SHOT occurrence metadata is invalid.");
      }
      return next;
    });
    return { id, identityKey, nameKey, startFrame, endFrame, occurrences };
  });
}

function updatedJobForXml(current, xmlName, timelineShots, reconciliation){
  return {
    ...current,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
    xml: { name: xmlName, relativePath: "source/timeline.xml" },
    shotMappings: reconciliation.shotMappings,
    timelineShots,
    orphanedShotMappings: reconciliation.orphanedShotMappings,
  };
}

function discardPreparedVideoEntry(entry, reason){
  if(!entry) return false;
  preparedVideoImports.delete(entry.token);
  try{
    const discarded = discardPreparedVideoCandidate(entry.preparation);
    logEvent("video_import_discarded", {
      transactionId: entry.token,
      videoName: entry.name,
      reason: String(reason || "discarded").slice(0, 60),
    });
    return discarded;
  }catch(error){
    logEvent("video_import_cleanup_deferred", {
      transactionId: entry.token,
      code: error.code || "DISCARD_FAILED",
    });
    return false;
  }
}

function prunePreparedVideoImports(){
  const now = Date.now();
  for(const entry of preparedVideoImports.values()){
    if(entry.expiresAt <= now) discardPreparedVideoEntry(entry, "expired");
  }
}

function discardPreparedVideoForOwner(ownerId){
  for(const entry of [...preparedVideoImports.values()]){
    if(entry.ownerId === ownerId) discardPreparedVideoEntry(entry, "superseded");
  }
}

function prepareVideoImport(event, sourcePath, inputMethod){
  requireRuntimeReady("video_prepare");
  if(exportController.isRunning()) throw new Error(T("export_block_video"));
  prunePreparedVideoImports();
  discardPreparedVideoForOwner(event.sender.id);
  const preparation = prepareVideoCandidate({
    sourcePath,
    logRoot: LOG_ROOT,
    inputMethod,
    allowedExtensions: VIDEO_EXTENSIONS,
    maxBytes: VIDEO_MAX_BYTES,
  });
  const entry = {
    token: preparation.transactionId,
    preparation,
    ownerId: event.sender.id,
    name: preparation.inputName,
    extension: preparation.inputExtension,
    expiresAt: Date.now() + PREPARED_VIDEO_TTL_MS,
  };
  preparedVideoImports.set(entry.token, entry);
  logEvent("video_import_prepared", {
    transactionId: entry.token,
    videoName: entry.name,
    inputMethod,
    size: preparation.inputSize,
  });
  return {
    token: entry.token,
    name: entry.name,
    extension: entry.extension,
    candidateUrl: pathToFileURL(preparation.candidatePath).href,
  };
}

function preparedVideoEntry(event, token){
  prunePreparedVideoImports();
  if(typeof token !== "string" || !token) throw new Error("Prepared video token is required.");
  const entry = preparedVideoImports.get(token);
  if(!entry || entry.ownerId !== event.sender.id) throw new Error("Prepared video is unavailable or expired.");
  return entry;
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

function publicFile(relativePath, ownedRoot, label){
  if(!relativePath) return null;
  const absolutePath = resolveOwnedRelativeFile({
    jobRoot: JOB_ROOT,
    ownedRoot,
    relativePath,
    label,
  });
  return { relativePath, url: pathToFileURL(absolutePath).href, absolutePath };
}

function hydrateJob(job){
  return {
    ...job,
    projectTitle: normalizeProjectTitle(job.projectTitle),
    callout: normalizeCallout(job.callout),
    xml: job.xml ? { ...job.xml, ...publicFile(job.xml.relativePath, SOURCE_ROOT, "xml") } : null,
    video: job.video ? { ...job.video, ...publicFile(job.video.relativePath, SOURCE_ROOT, "video") } : null,
    references: normalizeReferenceLabels(job.references).map(reference => ({
      ...reference,
      ...publicFile(reference.relativePath, REFERENCES_ROOT, "reference"),
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

function exportReadiness(job){
  if(recoveryRequired){
    return { ready: false, message: T("ready_recovery") };
  }
  const requiredSources = [
    { entry: job.xml, label: "Export XML", message: T("ready_xml_missing") },
    { entry: job.video, label: "Export video", message: T("ready_video_missing") },
  ];
  for(const item of requiredSources){
    if(!item.entry?.relativePath) return { ready: false, message: item.message };
    try{
      resolveOwnedRelativeFile({
        jobRoot: JOB_ROOT,
        ownedRoot: SOURCE_ROOT,
        relativePath: item.entry.relativePath,
        label: item.label,
        mustExist: true,
      });
    }catch{
      return { ready: false, message: item.message };
    }
  }
  for(const reference of job.references || []){
    try{
      resolveOwnedRelativeFile({
        jobRoot: JOB_ROOT,
        ownedRoot: REFERENCES_ROOT,
        relativePath: reference.relativePath,
        label: "Export reference",
        mustExist: true,
      });
    }catch{
      return {
        ready: false,
        message: T("ready_reference_missing"),
      };
    }
  }
  return { ready: true, message: "" };
}

function exportSummary(){
  const job = loadJob();
  const readiness = exportReadiness(job);
  const durationSeconds = Math.max(0, Number(exportDialogContext.durationSeconds) || 0);
  const spec = resolveRenderSpec(job.output);
  return {
    jobId: job.jobId,
    revision: job.revision,
    projectTitle: normalizeProjectTitle(job.projectTitle),
    format: "H.264",
    width: spec.width,
    height: spec.height,
    outputFps: spec.fps,
    sourceFps: Math.max(0, Number(exportDialogContext.sourceFps) || 0),
    bitrateMbps: spec.bitrateMbps,
    language: currentLanguage(),
    durationSeconds,
    totalFrames: durationSeconds ? Math.ceil(durationSeconds * spec.fps) : 0,
    editCount: Math.max(0, Number(exportDialogContext.editCount) || 0),
    outputFolder: OUTPUT_ROOT,
    videoName: job.video?.name || "NO VIDEO",
    xmlName: job.xml?.name || "NO XML",
    ready: readiness.ready,
    readyMessage: readiness.message,
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

function runSecondarySmoke(){
  return new Promise(resolve => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    let killGraceTimer = null;
    let timeoutError = null;
    let child = null;
    const appendTail = (current, chunk) => (current + String(chunk || "")).slice(-4000);
    const finish = result => {
      if(settled) return;
      settled = true;
      if(timer) clearTimeout(timer);
      if(killGraceTimer) clearTimeout(killGraceTimer);
      resolve({ ...result, stdout, stderr });
    };
    try{
      // RED ZONE: keep the primary event loop alive so Electron can reject the secondary instance.
      child = spawn(process.execPath, [APP_ROOT, "--smoke-test"], {
        cwd: APP_ROOT,
        env: process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }catch(error){
      finish({ status: null, error });
      return;
    }
    child.stdout?.on("data", chunk => { stdout = appendTail(stdout, chunk); });
    child.stderr?.on("data", chunk => { stderr = appendTail(stderr, chunk); });
    child.once("error", error => finish({ status: null, error }));
    child.once("close", status => finish({ status, error: timeoutError }));
    timer = setTimeout(() => {
      timeoutError = new Error("Secondary instance timed out after 10000ms");
      try{
        if(child.exitCode == null && !child.killed) child.kill();
      }catch{}
      // Let Windows release the child handles before the outer smoke runner removes its temp root.
      killGraceTimer = setTimeout(() => finish({ status: null, error: timeoutError }), 1500);
    }, 10000);
  });
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
  const ownerId = window.webContents.id;
  window.webContents.once("destroyed", () => {
    discardPreparedXmlForOwner(ownerId);
    discardPreparedVideoForOwner(ownerId);
  });
  if(SMOKE_TEST){
    window.webContents.once("did-finish-load", async () => {
      try{
        const secondary = await runSecondarySmoke();
        if(secondary.error || secondary.status !== 0 || !String(secondary.stdout || "").includes("SINGLE_INSTANCE_REJECTED")){
          throw new Error("Single-instance smoke failed: " + JSON.stringify({
            status: secondary.status,
            error: secondary.error?.message || null,
            stdout: String(secondary.stdout || "").slice(-500),
            stderr: String(secondary.stderr || "").slice(-500),
          }));
        }
        await new Promise(resolve => setTimeout(resolve, 1200));
        const starterJob = loadJob();
        const starterDemo = {
          enabled: starterJob.demo === true,
          hasXml: starterJob.xml?.relativePath === "source/timeline.xml",
          hasVideo: starterJob.video?.relativePath === "source/video.mp4",
          title: starterJob.projectTitle,
        };
        if(!starterDemo.enabled || !starterDemo.hasXml || !starterDemo.hasVideo || starterDemo.title !== "SYNTHETIC TIMELINE"){
          throw new Error("Bundled starter demo contract failed: " + JSON.stringify(starterDemo));
        }
        const smokeXmlPath = process.env.PORTABLE_SMOKE_XML;
        if(smokeXmlPath && fs.existsSync(smokeXmlPath)){
          const xmlText = fs.readFileSync(smokeXmlPath, "utf8");
          const parsed = await window.webContents.executeJavaScript(
            `window.portableMvp.loadXmlText(${JSON.stringify(xmlText)})`
          );
          if(parsed?.fps!==24||parsed?.durationFrames!==288||parsed?.edits!==5||parsed?.shots!==4){
            throw new Error("Public fixture contract changed: "+JSON.stringify(parsed));
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
          editStatus: document.getElementById("editCountStatus")?.textContent,
          jobName: document.getElementById("jobName")?.textContent
        })`);
        if(!result.hasApi || !result.hasWireframe || !result.hasPreview || !result.shotRail || !result.editOverlay || !result.calloutSettingsOpen){
          throw new Error("Smoke contract failed: " + JSON.stringify(result));
        }
        if(!String(result.jobName || "").startsWith("SAMPLE JOB / ")){
          throw new Error("Starter demo label is missing: " + JSON.stringify(result));
        }
        result.starterDemo = starterDemo;
        if(process.env.PORTABLE_SMOKE_XML && (!result.shotItems || result.editStatus==="0 EDITS")){
          throw new Error("XML did not reach the parent SHOT rail: " + JSON.stringify(result));
        }
        const smokeVideoPath = process.env.PORTABLE_SMOKE_VIDEO;
        const smokeInvalidVideoPath = process.env.PORTABLE_SMOKE_INVALID_VIDEO;
        if(smokeVideoPath && smokeInvalidVideoPath){
          const videoPreflight = await window.webContents.executeJavaScript(`(async()=>{
            const api=window.portableApi;
            const preview=document.getElementById("renderPreview").contentWindow.portablePreview;
            const before=await api.getJob();
            const good=await api.prepareDroppedVideo(${JSON.stringify(smokeVideoPath)});
            const metadata=await preview.preflightVideo(good.candidateUrl,10000);
            await api.discardPreparedVideo(good.token,"smoke-preflight-passed");
            const bad=await api.prepareDroppedVideo(${JSON.stringify(smokeInvalidVideoPath)});
            let rejected=false;
            try{await preview.preflightVideo(bad.candidateUrl,5000)}catch(error){rejected=true}
            await api.discardPreparedVideo(bad.token,"smoke-preflight-failed");
            const after=await api.getJob();
            return {
              valid:metadata.readyState>=2&&metadata.width>0&&metadata.height>0,
              invalidRejected:rejected,
              jobUnchanged:before.jobId===after.jobId&&before.revision===after.revision,
            };
          })()`);
          if(!videoPreflight.valid || !videoPreflight.invalidRejected || !videoPreflight.jobUnchanged){
            throw new Error("Video preflight smoke failed: "+JSON.stringify(videoPreflight));
          }
          result.videoPreflight=videoPreflight;
        }
        result.singleInstance=true;
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
             document.activeElement?.blur?.();
             document.body.dispatchEvent(new KeyboardEvent("keydown",{key:" ",code:"Space",bubbles:true,cancelable:true}));
             await new Promise(resolve=>setTimeout(resolve,500));
             const shortcutPlaying=bridge.getState();
             const syncedShot=document.querySelector("#shotRailList .shotRailItem.selected")?.dataset.shot||null;
             document.body.dispatchEvent(new KeyboardEvent("keyup",{key:" ",code:"Space",bubbles:true,cancelable:true}));
             document.body.dispatchEvent(new KeyboardEvent("keydown",{key:" ",code:"Space",bubbles:true,cancelable:true}));
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
          bridge.setCalloutConfig({enabled:true,position:"left",style:"line",startSeconds:.08,durationSeconds:30,subtitle:"WORKFLOW SHOWCASE · EDIT WORKFLOW"});
          bridge.seekFrame(2*bridge.getState().fps);
        })()`);
        await new Promise(resolve => setTimeout(resolve, 180));
        const image = await window.webContents.capturePage();
        fs.writeFileSync(path.join(OUTPUT_ROOT, "mvp-smoke.png"), image.toPNG());
        if(smokeXmlPath && fs.existsSync(smokeXmlPath)){
          const demoReplacement = await window.webContents.executeJavaScript(`(async()=>{
            const api=window.portableApi;
            const preview=document.getElementById("renderPreview").contentWindow.portablePreview;
            const before=await api.getJob();
            const prepared=await api.prepareDroppedXml(${JSON.stringify(smokeXmlPath)});
            const candidate=preview.inspectXml(prepared.text);
            const mode=await api.chooseXmlImportMode(prepared.token);
            await preview.releaseMedia({references:true});
            const result=await api.commitXmlImport({
              token:prepared.token,
              expectedJobId:before.jobId,
              expectedRevision:before.revision,
              previousTimelineShots:[],
              nextTimelineShots:candidate.shots,
            });
            return {
              mode,
              previousJobId:before.jobId,
              nextJobId:result.job.jobId,
              demo:result.job.demo===true,
              video:result.job.video,
            };
          })()`);
          if(demoReplacement.mode!=="new" || demoReplacement.demo || demoReplacement.video!==null ||
              demoReplacement.previousJobId===demoReplacement.nextJobId){
            throw new Error("Starter demo replacement contract failed: "+JSON.stringify(demoReplacement));
          }
          result.demoReplacement=demoReplacement;
        }
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

if(SINGLE_INSTANCE_LOCK){
  app.on("second-instance", () => {
    logEvent("second_instance_rejected");
    const primaryWindow = BrowserWindow.getAllWindows().find(window => !window.getParentWindow());
    if(!primaryWindow || primaryWindow.isDestroyed()) return;
    if(primaryWindow.isMinimized()) primaryWindow.restore();
    primaryWindow.show();
    primaryWindow.focus();
  });
  app.whenReady().then(() => {
  try{
    ensureJobFolders();
  }catch(error){
    dialog.showErrorBox(T("boot_unsafe_title"), T("boot_unsafe"));
    app.quit();
    return;
  }
  let recovery = null;
  try{
    recovery = recoverXmlTransactions({
      logRoot: LOG_ROOT,
      sourceRoot: SOURCE_ROOT,
      referencesRoot: REFERENCES_ROOT,
      jobPath: JOB_PATH,
      onEvent: (event, detail) => logEvent(event, detail),
    });
  }catch(error){
    try{logEvent("job_xml_recovery_boot_failed", { code: error.code || "RECOVERY_BOOT_FAILED" })}catch{}
    dialog.showErrorBox(T("boot_recovery_title"), T("boot_recovery_xml_check"));
    app.quit();
    return;
  }
  if(recovery.recovered || recovery.cleaned || recovery.deferred || recovery.failed){
    logEvent("job_xml_recovery_summary", recovery);
  }
  if(recovery.failed){
    dialog.showErrorBox(T("boot_recovery_title"), T("boot_recovery_xml"));
    app.quit();
    return;
  }
  let videoRecovery = null;
  try{
    videoRecovery = recoverVideoTransactions({
      logRoot: LOG_ROOT,
      sourceRoot: SOURCE_ROOT,
      jobPath: JOB_PATH,
      onEvent: (event, detail) => logEvent(event, detail),
    });
  }catch(error){
    try{logEvent("job_video_recovery_boot_failed", { code: error.code || "RECOVERY_BOOT_FAILED" })}catch{}
    dialog.showErrorBox(T("boot_recovery_title"), T("boot_recovery_video_check"));
    app.quit();
    return;
  }
  if(videoRecovery.recovered || videoRecovery.cleaned || videoRecovery.deferred || videoRecovery.failed){
    logEvent("job_video_recovery_summary", videoRecovery);
  }
  if(videoRecovery.failed){
    dialog.showErrorBox(T("boot_recovery_title"), T("boot_recovery_video"));
    app.quit();
    return;
  }
  try{
    loadJob();
  }catch(error){
    dialog.showErrorBox(T("boot_unreadable_title"), T("boot_unreadable"));
    app.quit();
    return;
  }
  logEvent("app_started", { appRoot: APP_ROOT });
  const languageState = currentLanguageState();
  logEvent("ui_language_resolved", {
    storedLanguage: languageState.storedLanguage,
    preferredSystemLanguage: languageState.preferredSystemLanguages[0] || null,
    systemLocale: languageState.systemLocale || null,
    appLocale: languageState.appLocale || null,
    resolved: languageState.resolved,
  });
  createWindow();
  app.on("activate", () => {
    if(BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  });
}else{
  console.log("SINGLE_INSTANCE_REJECTED");
}

app.on("window-all-closed", () => {
  if(process.platform !== "darwin") app.quit();
});

ipcMain.handle("job:get", () => hydrateJob(loadJob()));
ipcMain.handle("app:get-render-spec", () => publicRenderSpec(loadJob().output));
ipcMain.handle("app:get-language", () => currentLanguage());
ipcMain.handle("app:reload-current-job", event => {
  if(exportController.isRunning()) throw new Error(T("export_block_reload"));
  const ownerId = event.sender.id;
  discardPreparedXmlForOwner(ownerId);
  discardPreparedVideoForOwner(ownerId);
  logEvent("current_job_reload_requested");
  setImmediate(() => {
    if(!event.sender.isDestroyed()) event.sender.reloadIgnoringCache();
  });
  return true;
});

ipcMain.handle("job:save", (_event, payload) => {
  requireRuntimeReady("job_save");
  const current = loadJob();
  if(typeof payload?.expectedJobId !== "string" || payload.expectedJobId !== current.jobId ||
      !Number.isSafeInteger(payload?.expectedRevision) || payload.expectedRevision !== current.revision){
    logEvent("job_save_rejected_stale", {
      expectedJobId: typeof payload?.expectedJobId === "string" ? payload.expectedJobId : null,
      currentJobId: current.jobId,
      expectedRevision: Number.isSafeInteger(payload?.expectedRevision) ? payload.expectedRevision : null,
      currentRevision: current.revision,
    });
    return { ...hydrateJob(current), saveRejected: "JOB_STALE" };
  }
  const validReferenceIds = new Set((current.references || []).map(reference => reference.id));
  const requestedMappings = payload?.shotMappings && typeof payload.shotMappings === "object"
    ? payload.shotMappings
    : current.shotMappings;
  const safeMappings = {};
  for(const [shotId, mapping] of Object.entries(requestedMappings || {})){
    if(!mapping || typeof mapping !== "object") continue;
    const refs = Array.isArray(mapping.refs) ? mapping.refs.filter(id => validReferenceIds.has(id)) : [];
    if((mapping.mode === "ADD" || mapping.mode === "REPLACE") && !refs.length) continue;
    safeMappings[shotId] = { ...mapping, refs };
  }
  const next = writeJob({
    ...current,
    globalReferenceIds: Array.isArray(payload?.globalReferenceIds)
      ? payload.globalReferenceIds.filter(id => validReferenceIds.has(id))
      : current.globalReferenceIds,
    shotMappings: safeMappings,
    projectTitle: payload?.projectTitle === undefined ? current.projectTitle : normalizeProjectTitle(payload.projectTitle),
    callout: payload?.callout === undefined ? current.callout : normalizeCallout(payload.callout),
    ui: payload?.ui && typeof payload.ui === "object" ? { ...current.ui, ...payload.ui } : current.ui,
  });
  logEvent("job_saved", {
    globalCount: next.globalReferenceIds.length,
    shotMappingCount: Object.keys(next.shotMappings || {}).length,
    uiLanguage: next.ui?.language || null,
  });
  return hydrateJob(next);
});

ipcMain.handle("job:select-xml", async event => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: "Load timeline XML",
    properties: ["openFile"],
    filters: [{ name: "Timeline XML", extensions: ["xml"] }],
  };
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  if(result.canceled || !result.filePaths[0]) return null;
  return prepareXmlImport(event, result.filePaths[0], "picker");
});

ipcMain.handle("job:prepare-xml-path", (event, sourcePath) => prepareXmlImport(event, sourcePath, "drop"));

ipcMain.handle("job:choose-xml-mode", async (event, token) => {
  requireRuntimeReady("xml_choose_mode");
  const entry = preparedXmlEntry(event, token);
  if(exportController.isRunning()) throw new Error(T("export_block_xml"));
  const current = loadJob();
  if(current.demo === true){
    entry.mode = "new";
    entry.expiresAt = Date.now() + PREPARED_XML_TTL_MS;
    logEvent("starter_demo_replacement_selected", { transactionId: entry.token, xmlName: entry.name });
    logEvent("job_xml_mode_selected", { transactionId: entry.token, mode: entry.mode, replacedDemo: true });
    return entry.mode;
  }
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options = {
    type: "warning",
    title: "Load timeline XML",
    message: T("xml_dialog_message"),
    detail: T("xml_dialog_detail"),
    buttons: ["UPDATE XML", "NEW JOB", "CANCEL"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
  const result = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options);
  if(result.response === 2){
    logEvent("job_xml_cancelled", { transactionId: entry.token, xmlName: entry.name });
    discardPreparedXmlEntry(entry, "cancelled");
    return null;
  }
  entry.mode = result.response === 1 ? "new" : "update";
  entry.expiresAt = Date.now() + PREPARED_XML_TTL_MS;
  logEvent("job_xml_mode_selected", { transactionId: entry.token, mode: entry.mode });
  return entry.mode;
});

ipcMain.handle("job:commit-xml", (event, payload) => {
  const entry = preparedXmlEntry(event, payload?.token);
  if(!["update", "new"].includes(entry.mode)) throw new Error(T("xml_mode_required"));
  if(exportController.isRunning()) throw new Error(T("export_block_xml"));
  const current = requireExpectedJob(payload?.expectedJobId, payload?.expectedRevision, "job_xml_commit");
  const nextTimelineShots = normalizeTimelineShots(payload?.nextTimelineShots);
  let reconciliation = {
    shotMappings: {},
    orphanedShotMappings: [],
    summary: { preserved: 0, newShots: nextTimelineShots.length, orphaned: 0, ambiguous: 0, reattached: 0 },
  };
  let nextJob = null;
  let commitXml = commitPreparedXml;
  if(entry.mode === "update"){
    const storedTimelineShots = Array.isArray(current.timelineShots) && current.timelineShots.length
      ? current.timelineShots
      : payload?.previousTimelineShots;
    const previousTimelineShots = normalizeTimelineShots(storedTimelineShots || []);
    reconciliation = reconcileTimelineMappings({
      previousShots: previousTimelineShots,
      nextShots: nextTimelineShots,
      shotMappings: current.shotMappings || {},
      orphanedShotMappings: current.orphanedShotMappings || [],
    });
    nextJob = updatedJobForXml(current, entry.name, nextTimelineShots, reconciliation);
    commitXml = commitPreparedXmlUpdate;
  }else{
    nextJob = newJobForXml(current, entry.name, nextTimelineShots);
  }
  logEvent(entry.mode === "update" ? "job_xml_update_started" : "job_reset_started", {
    transactionId: entry.token,
    mode: entry.mode,
    previousJobId: current.jobId,
    nextJobId: nextJob.jobId,
    previousReferenceCount: current.references?.length || 0,
    previousMappingCount: Object.keys(current.shotMappings || {}).length,
    ...reconciliation.summary,
  });
  try{
    const committed = commitXml({
      preparation: entry.preparation,
      sourceRoot: SOURCE_ROOT,
      referencesRoot: REFERENCES_ROOT,
      jobPath: JOB_PATH,
      nextJob,
      onEvent: (eventName, detail) => logEvent(eventName, detail),
    });
    preparedXmlImports.delete(entry.token);
    try{
      logEvent(entry.mode === "update" ? "job_xml_update_committed" : "job_reset_committed", {
        transactionId: entry.token,
        mode: entry.mode,
        previousJobId: current.jobId,
        nextJobId: committed.job.jobId,
        xmlName: entry.name,
        removedSourceCount: committed.removedSourceCount,
        removedReferenceCount: committed.removedReferenceCount,
        ...reconciliation.summary,
      });
    }catch{}
    return { job: hydrateJob(committed.job), mode: entry.mode, summary: reconciliation.summary };
  }catch(error){
    preparedXmlImports.delete(entry.token);
    try{logEvent("job_xml_commit_failed", { transactionId: entry.token, mode: entry.mode, code: error.code || "COMMIT_FAILED" })}catch{}
    if(error.rollbackError){
      recoveryRequired = true;
      logEvent("job_runtime_recovery_required", { transactionId: entry.token, code: "ROLLBACK_FAILED" });
      dialog.showErrorBox(T("rollback_block_title"), T("rollback_block_xml"));
      const fatal = new Error("JOB_RECOVERY_REQUIRED: XML commit rollback failed.");
      fatal.code = "JOB_RECOVERY_REQUIRED";
      throw fatal;
    }
    throw error;
  }
});

ipcMain.handle("job:discard-prepared-xml", (event, payload) => {
  const entry = preparedXmlEntry(event, payload?.token);
  return discardPreparedXmlEntry(entry, payload?.reason);
});

ipcMain.handle("job:select-video", async event => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: "Load H.264 source video",
    properties: ["openFile"],
    filters: [{ name: "Video", extensions: ["mp4", "mov", "m4v"] }],
  };
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  if(result.canceled || !result.filePaths[0]) return null;
  return prepareVideoImport(event, result.filePaths[0], "picker");
});

ipcMain.handle("job:prepare-video-path", (event, sourcePath) => prepareVideoImport(event, sourcePath, "drop"));

ipcMain.handle("job:commit-video", (event, payload) => {
  const entry = preparedVideoEntry(event, payload?.token);
  if(exportController.isRunning()) throw new Error(T("export_block_video"));
  const current = requireExpectedJob(payload?.expectedJobId, payload?.expectedRevision, "video_import_commit");
  const { demo: _discardDemoMarker, ...currentUserJob } = current;
  const nextJob = {
    ...currentUserJob,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
    video: {
      name: entry.name,
      relativePath: "source/video" + entry.extension,
    },
  };
  try{
    const committed = commitPreparedVideo({
      preparation: entry.preparation,
      sourceRoot: SOURCE_ROOT,
      jobPath: JOB_PATH,
      nextJob,
      onEvent: (eventName, detail) => logEvent(eventName, detail),
    });
    preparedVideoImports.delete(entry.token);
    try{
      logEvent("video_imported", {
        transactionId: entry.token,
        name: entry.name,
        replacedVideoCount: committed.replacedVideoCount,
      });
    }catch{}
    return hydrateJob(committed.job);
  }catch(error){
    preparedVideoImports.delete(entry.token);
    try{logEvent("video_import_failed", { transactionId: entry.token, code: error.code || "COMMIT_FAILED" })}catch{}
    if(error.rollbackError){
      recoveryRequired = true;
      logEvent("job_runtime_recovery_required", { transactionId: entry.token, code: "VIDEO_ROLLBACK_FAILED" });
      dialog.showErrorBox(T("rollback_block_title"), T("rollback_block_video"));
      const fatal = new Error("JOB_RECOVERY_REQUIRED: video commit rollback failed.");
      fatal.code = "JOB_RECOVERY_REQUIRED";
      throw fatal;
    }
    throw error;
  }
});

ipcMain.handle("job:discard-prepared-video", (event, payload) => {
  const entry = preparedVideoEntry(event, payload?.token);
  return discardPreparedVideoEntry(entry, payload?.reason);
});

function importReferencePaths(sourcePaths, expectedJobId, expectedRevision){
  const current = requireExpectedJob(expectedJobId, expectedRevision, "reference_import");
  const added = [];
  const createdPaths = [];
  let next = null;
  try{
    for(const candidate of sourcePaths || []){
      if(typeof candidate !== "string") continue;
      let inspected = null;
      try{
        inspected = inspectInputFile(candidate, REFERENCE_EXTENSIONS, REFERENCE_MAX_BYTES);
      }catch(error){
        logEvent("reference_import_skipped", { code: error.code || "INVALID_INPUT" });
        continue;
      }
      const sourcePath = inspected.absolutePath;
      const type = referenceType(sourcePath);
      if(!type) continue;
      const nextNumber = current.references.filter(reference => reference.type === type).length + 1;
      const id = type + "-" + String(nextNumber).padStart(2, "0") + "-" + Date.now().toString(36);
      const destinationName = id + "_" + safeName(path.basename(sourcePath));
      const destinationPath = path.join(REFERENCES_ROOT, destinationName);
      copyInto(sourcePath, destinationPath);
      createdPaths.push(destinationPath);
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
    next = added.length ? writeJob(current) : current;
  }catch(error){
    for(const createdPath of createdPaths){
      try{if(fs.existsSync(createdPath)) fs.unlinkSync(createdPath)}catch(cleanupError){
        logEvent("reference_import_cleanup_failed", { code: cleanupError.code || "CLEANUP_FAILED" });
      }
    }
    throw error;
  }
  logEvent("references_imported", { count: added.length });
  return hydrateJob(next);
}

ipcMain.handle("job:add-references", async (event, payload) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: "Add image or video references",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "References", extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif", "mp4", "mov", "m4v", "webm"] },
    ],
  };
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  if(result.canceled || !result.filePaths.length) return null;
  return importReferencePaths(result.filePaths, payload?.expectedJobId, payload?.expectedRevision);
});

ipcMain.handle("job:add-reference-paths", (_event, payload) => (
  importReferencePaths(payload?.paths, payload?.expectedJobId, payload?.expectedRevision)
));

ipcMain.handle("job:delete-reference", (_event, payload) => {
  const referenceId = payload?.id;
  if(typeof referenceId !== "string" || !referenceId) throw new Error("Invalid reference id");
  const current = requireExpectedJob(payload?.expectedJobId, payload?.expectedRevision, "reference_delete");
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
  current.orphanedShotMappings = (current.orphanedShotMappings || []).flatMap(record => {
    const refs = (record?.mapping?.refs || []).filter(id => id !== referenceId);
    if(!refs.length && (record?.mapping?.mode === "ADD" || record?.mapping?.mode === "REPLACE")) return [];
    return [{ ...record, mapping: { ...record.mapping, refs } }];
  });

  const next = writeJob(current);
  let fileDeleted = false;
  let warning = null;
  try{
    const absolutePath = resolveOwnedRelativeFile({
      jobRoot: JOB_ROOT,
      ownedRoot: REFERENCES_ROOT,
      relativePath: reference.relativePath,
      label: "reference",
    });
    if(fs.existsSync(absolutePath)){
      resolveOwnedRelativeFile({
        jobRoot: JOB_ROOT,
        ownedRoot: REFERENCES_ROOT,
        relativePath: reference.relativePath,
        label: "reference",
        mustExist: true,
      });
      fs.unlinkSync(absolutePath);
      fileDeleted = true;
    }
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
  const xmlPath = resolveOwnedRelativeFile({
    jobRoot: JOB_ROOT,
    ownedRoot: SOURCE_ROOT,
    relativePath: job.xml.relativePath,
    label: "xml",
  });
  if(!fs.existsSync(xmlPath)) return null;
  resolveOwnedRelativeFile({
    jobRoot: JOB_ROOT,
    ownedRoot: SOURCE_ROOT,
    relativePath: job.xml.relativePath,
    label: "xml",
    mustExist: true,
  });
  return fs.readFileSync(xmlPath, "utf8");
});

ipcMain.handle("job:backup-current", (_event, payload) => {
  try{
    const job=requireExpectedJob(payload?.expectedJobId,payload?.expectedRevision,"job_backup");
    const result=createJobBackup({
      appRoot:APP_ROOT,jobRoot:JOB_ROOT,sourceRoot:SOURCE_ROOT,referencesRoot:REFERENCES_ROOT,jobPath:JOB_PATH,job,
    });
    logEvent("job_backup_created",{...result,jobId:job.jobId,revision:job.revision});
    return result;
  }catch(error){
    logEvent("job_backup_failed",{code:error.code||"BACKUP_FAILED",message:error.message});
    throw error;
  }
});

ipcMain.handle("app:log", (_event, event, detail) => {
  logEvent(String(event || "renderer_event"), detail && typeof detail === "object" ? detail : {});
  return true;
});

ipcMain.handle("export:open-dialog", (event, context) => openExportWindow(event.sender, context));
ipcMain.handle("export:get-summary", () => exportSummary());
ipcMain.handle("export:set-bitrate", (_event, payload) => {
  // Export popup may change only output.bitrateMbps. The bumped revision is safe:
  // the editor's stale-save path adopts the new revision and retries when jobId is unchanged.
  if(exportController.isRunning()) throw new Error(T("bitrate_running"));
  const bitrateMbps = Number(payload?.bitrateMbps);
  if(bitrateMbps !== 12 && bitrateMbps !== 24) throw new Error(T("bitrate_invalid"));
  const job = requireExpectedJob(payload?.expectedJobId, payload?.expectedRevision, "export_set_bitrate");
  writeJob({ ...job, output: { ...(job.output || {}), bitrateMbps } });
  logEvent("export_bitrate_updated", { bitrateMbps });
  return exportSummary();
});
ipcMain.handle("export:start", async (event, payload) => {
  const job = requireExpectedJob(payload?.expectedJobId, payload?.expectedRevision, "export_start");
  const window = BrowserWindow.fromWebContents(event.sender);
  if(window && !window.isDestroyed()) window.setClosable(false);
  try{
    return await exportController.start(event.sender, job, currentLanguage());
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
ipcMain.handle("export:open-output", () => {
  ensureJobFolders();
  return shell.openPath(OUTPUT_ROOT);
});
