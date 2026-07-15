"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v"];
const DEFAULT_VIDEO_MAX_BYTES = 512 * 1024 * 1024 * 1024;
const SOURCE_VIDEO_PATTERN = /^video\.(mp4|mov|m4v)$/i;
const TRANSACTION_PREFIX = ".video-import-";
const TRANSACTION_NAME_PATTERN = /^\.video-import-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const MANIFEST_NAME = "manifest.json";
const MANIFEST_TEMP_NAME_PATTERN = /^manifest\.json\.tmp(?:-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$/i;
const ROLLBACK_MARKER_NAME = "rollback-complete.json";
const ROLLBACK_MARKER_TEMP_NAME_PATTERN = /^rollback-complete\.json\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NEXT_JOB_NAME = "next-job.json";
const REPLACE_RETRY_COUNT = 4;
const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

function samePath(left, right){
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(parentPath, candidatePath){
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function pathsOverlap(left, right){
  return samePath(left, right) || isInside(left, right) || isInside(right, left);
}

function ensureDirectoryNoLink(directoryPath, label){
  const resolved = path.resolve(directoryPath);
  fs.mkdirSync(resolved, { recursive: true });
  const stat = fs.lstatSync(resolved);
  // Junctions are reported as symbolic links by lstat on Windows; never follow either kind.
  if(stat.isSymbolicLink() || !stat.isDirectory()){
    throw new Error(label + " must be a real directory");
  }
  return resolved;
}

function normalizeExtensions(allowedExtensions = DEFAULT_VIDEO_EXTENSIONS){
  const values = allowedExtensions instanceof Set
    ? [...allowedExtensions]
    : Array.isArray(allowedExtensions) ? allowedExtensions : [];
  if(!values.length) throw new Error("At least one allowed video extension is required");
  return new Set(values.map(value => {
    const raw = String(value || "").trim().toLowerCase();
    const normalized = raw.startsWith(".") ? raw : "." + raw;
    if(!/^\.[a-z0-9]{1,12}$/.test(normalized)){
      throw new Error("Invalid allowed video extension");
    }
    return normalized;
  }));
}

function inspectVideoCandidate({ sourcePath, allowedExtensions = DEFAULT_VIDEO_EXTENSIONS, maxBytes = DEFAULT_VIDEO_MAX_BYTES } = {}){
  if(typeof sourcePath !== "string" || !sourcePath.trim()){
    throw new Error("Video input path is required");
  }
  const limit = Number(maxBytes);
  if(!Number.isSafeInteger(limit) || limit <= 0){
    throw new Error("maxBytes must be a positive safe integer");
  }
  const absolutePath = path.resolve(sourcePath);
  const stat = fs.lstatSync(absolutePath);
  if(stat.isSymbolicLink() || !stat.isFile()){
    throw new Error("Video input must be a regular file");
  }
  const extension = path.extname(absolutePath).toLowerCase();
  if(!normalizeExtensions(allowedExtensions).has(extension)){
    throw new Error("Video input extension is not allowed: " + (extension || "(none)"));
  }
  if(stat.size <= 0) throw new Error("Video input file is empty");
  if(stat.size > limit){
    throw new Error("Video input exceeds the " + limit + " byte limit");
  }
  return {
    absolutePath,
    extension,
    name: path.basename(absolutePath),
    size: stat.size,
  };
}

function safeDisplayName(value, extension){
  const fallback = "video" + extension;
  const name = String(value || fallback)
    .replace(/[\x00-\x1f\x7f]/g, "_")
    .replace(/[\\/]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 255);
  return name || fallback;
}

function safeMethod(value){
  return String(value || "unknown")
    .replace(/[\x00-\x1f\x7f]/g, "_")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .slice(0, 40);
}

function hashFile(filePath){
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try{
    let bytesRead = 0;
    do{
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if(bytesRead) hash.update(buffer.subarray(0, bytesRead));
    }while(bytesRead);
  }finally{
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function writeTextDurably(filePath, text, exclusive = false){
  const descriptor = fs.openSync(filePath, exclusive ? "wx" : "w");
  try{
    fs.writeFileSync(descriptor, text, "utf8");
    fs.fsyncSync(descriptor);
  }finally{
    fs.closeSync(descriptor);
  }
}

function waitForReplaceRetry(attempt){
  const delayMs = [4, 12, 24][Math.min(attempt, 2)];
  if(typeof SharedArrayBuffer !== "function" || typeof Atomics?.wait !== "function") return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function isTransientRenameError(error){
  return TRANSIENT_RENAME_CODES.has(String(error?.code || "").toUpperCase());
}

function assertRegularFile(filePath, label){
  const stat = fs.lstatSync(filePath);
  if(stat.isSymbolicLink() || !stat.isFile()) throw new Error(label + " must be a regular file");
  return stat;
}

function fsyncExistingFile(filePath){
  const descriptor = fs.openSync(filePath, "r+");
  try{
    fs.fsyncSync(descriptor);
  }finally{
    fs.closeSync(descriptor);
  }
}

function verifyFileHash(filePath, expectedSha256, label){
  assertRegularFile(filePath, label);
  if(hashFile(filePath) !== expectedSha256){
    throw new Error(label + " hash verification failed");
  }
}

function removeVerifiedStagedFile(stagedPath){
  try{
    if(fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
  }catch(error){
    // The destination is already verified; transaction cleanup can remove a locked staged file later.
    if(!isTransientRenameError(error)) throw error;
  }
}

function replaceFromStagedFile(stagedPath, targetPath, label){
  assertRegularFile(stagedPath, label + " staging file");
  const expectedSha256 = hashFile(stagedPath);
  if(fs.existsSync(targetPath)){
    assertRegularFile(targetPath, label + " destination");
    if(hashFile(targetPath) === expectedSha256){
      removeVerifiedStagedFile(stagedPath);
      return { method: "identical", sha256: expectedSha256 };
    }
  }

  let lastRenameError = null;
  for(let attempt = 0; attempt < REPLACE_RETRY_COUNT; attempt += 1){
    try{
      fs.renameSync(stagedPath, targetPath);
      verifyFileHash(targetPath, expectedSha256, label + " destination");
      return { method: "rename", sha256: expectedSha256 };
    }catch(error){
      if(!fs.existsSync(stagedPath) && fs.existsSync(targetPath)){
        verifyFileHash(targetPath, expectedSha256, label + " destination");
        return { method: "rename", sha256: expectedSha256 };
      }
      if(!isTransientRenameError(error)) throw error;
      lastRenameError = error;
      if(attempt + 1 < REPLACE_RETRY_COUNT) waitForReplaceRetry(attempt);
    }
  }

  // RED ZONE: keep the staged file until the copied destination is durable and hash-verified.
  assertRegularFile(stagedPath, label + " staging file");
  if(fs.existsSync(targetPath)) assertRegularFile(targetPath, label + " destination");
  try{
    fs.copyFileSync(stagedPath, targetPath);
    fsyncExistingFile(targetPath);
    verifyFileHash(targetPath, expectedSha256, label + " destination");
  }catch(error){
    if(lastRenameError && !error.cause) error.cause = lastRenameError;
    throw error;
  }
  removeVerifiedStagedFile(stagedPath);
  return { method: "verified-copy", sha256: expectedSha256 };
}

function baseTransactionPaths(transactionRoot){
  return {
    manifestPath: path.join(transactionRoot, MANIFEST_NAME),
    nextJobPath: path.join(transactionRoot, NEXT_JOB_NAME),
    rollbackMarkerPath: path.join(transactionRoot, ROLLBACK_MARKER_NAME),
    backupRoot: path.join(transactionRoot, "backup"),
    sourceBackupRoot: path.join(transactionRoot, "backup", "source"),
    jobBackupPath: path.join(transactionRoot, "backup", "job.json"),
  };
}

function checkedExtension(value){
  const extension = String(value || "").toLowerCase();
  if(!/^\.[a-z0-9]{1,12}$/.test(extension)){
    throw new Error("Invalid video transaction extension");
  }
  return extension;
}

function transactionPaths(transactionRoot, extension){
  return {
    ...baseTransactionPaths(transactionRoot),
    candidatePath: path.join(transactionRoot, "candidate" + checkedExtension(extension)),
  };
}

function assertTransactionRoot(transactionRoot, logRoot){
  const resolvedLogRoot = ensureDirectoryNoLink(logRoot, "logRoot");
  const resolvedTransactionRoot = path.resolve(transactionRoot);
  const match = path.basename(resolvedTransactionRoot).match(TRANSACTION_NAME_PATTERN);
  if(!match || !samePath(path.dirname(resolvedTransactionRoot), resolvedLogRoot)){
    throw new Error("Unsafe video transaction root");
  }
  if(fs.existsSync(resolvedTransactionRoot)){
    const stat = fs.lstatSync(resolvedTransactionRoot);
    if(stat.isSymbolicLink() || !stat.isDirectory()){
      throw new Error("Video transaction root is not a real directory");
    }
  }
  return {
    logRoot: resolvedLogRoot,
    transactionRoot: resolvedTransactionRoot,
    transactionId: match[1].toLowerCase(),
  };
}

function removeTreeNoFollow(targetPath){
  let stat;
  try{
    stat = fs.lstatSync(targetPath);
  }catch(error){
    if(error.code === "ENOENT") return;
    throw error;
  }
  if(stat.isSymbolicLink() || !stat.isDirectory()){
    fs.unlinkSync(targetPath);
    return;
  }
  for(const name of fs.readdirSync(targetPath)){
    removeTreeNoFollow(path.join(targetPath, name));
  }
  fs.rmdirSync(targetPath);
}

function cleanupTransactionRoot(transactionRoot, logRoot){
  const checked = assertTransactionRoot(transactionRoot, logRoot);
  if(!fs.existsSync(checked.transactionRoot)) return;
  if(hasManifestCandidate(checked.transactionRoot)){
    ensurePrimaryManifestForCleanup(checked.transactionRoot);
  }
  const names = fs.readdirSync(checked.transactionRoot);
  // RED ZONE: remove staging files first and the authoritative manifest last. A partial cleanup must remain recoverable.
  for(const name of names.filter(candidate => MANIFEST_TEMP_NAME_PATTERN.test(candidate))){
    removeTreeNoFollow(path.join(checked.transactionRoot, name));
  }
  for(const name of names){
    if(name === MANIFEST_NAME || MANIFEST_TEMP_NAME_PATTERN.test(name)) continue;
    removeTreeNoFollow(path.join(checked.transactionRoot, name));
  }
  const manifestPath = path.join(checked.transactionRoot, MANIFEST_NAME);
  if(fs.existsSync(manifestPath)) removeTreeNoFollow(manifestPath);
  fs.rmdirSync(checked.transactionRoot);
}

function removeManifestStagingPathWithRetry(stagingPath){
  for(let attempt = 0; attempt < REPLACE_RETRY_COUNT; attempt += 1){
    try{
      if(fs.existsSync(stagingPath)) removeTreeNoFollow(stagingPath);
      return true;
    }catch(error){
      if(!isTransientRenameError(error)) throw error;
      if(attempt + 1 < REPLACE_RETRY_COUNT) waitForReplaceRetry(attempt);
    }
  }
  return !fs.existsSync(stagingPath);
}

function nextManifestStagingPath(manifestPath){
  const preferredPath = manifestPath + ".tmp";
  if(removeManifestStagingPathWithRetry(preferredPath)) return preferredPath;
  return nextUniqueManifestStagingPath(manifestPath);
}

function nextUniqueManifestStagingPath(manifestPath){
  const preferredPath = manifestPath + ".tmp";
  let candidatePath;
  do{
    candidatePath = preferredPath + "-" + crypto.randomUUID();
  }while(fs.existsSync(candidatePath));
  return candidatePath;
}

function writeManifest(transactionRoot, manifest, { preserveExistingTemps = false } = {}){
  const paths = baseTransactionPaths(transactionRoot);
  const next = { ...manifest, updatedAt: new Date().toISOString() };
  const temporaryPath = preserveExistingTemps
    ? nextUniqueManifestStagingPath(paths.manifestPath)
    : nextManifestStagingPath(paths.manifestPath);
  writeTextDurably(temporaryPath, JSON.stringify(next, null, 2) + "\n", true);
  replaceFromStagedFile(temporaryPath, paths.manifestPath, "Video transaction manifest");
  return next;
}

function validateManifest(manifest){
  if(!manifest || manifest.version !== 1 || typeof manifest.transactionId !== "string" ||
      !manifest.input || typeof manifest.input !== "object"){
    throw new Error("Invalid video transaction manifest");
  }
  const extension = checkedExtension(manifest.input.extension);
  const name = String(manifest.input.name || "");
  if(!name || path.isAbsolute(name) || path.basename(name) !== name || /[\\/]/.test(name)){
    throw new Error("Video transaction manifest contains an unsafe input name");
  }
  if(!Number.isSafeInteger(manifest.input.size) || manifest.input.size <= 0 ||
      !/^[0-9a-f]{64}$/i.test(String(manifest.input.sha256 || ""))){
    throw new Error("Video transaction manifest input metadata is invalid");
  }
  return { ...manifest, input: { ...manifest.input, extension } };
}

function readManifestCandidate(filePath){
  let stat;
  try{
    stat = fs.lstatSync(filePath);
  }catch(error){
    if(error.code === "ENOENT") return { status: "missing", error };
    throw error;
  }
  if(stat.isSymbolicLink() || !stat.isFile()){
    return { status: "invalid", error: new Error("Video transaction manifest must be a regular file") };
  }
  let text;
  try{
    text = fs.readFileSync(filePath, "utf8");
  }catch(error){
    if(error.code === "ENOENT") return { status: "missing", error };
    throw error;
  }
  try{
    return { status: "valid", manifest: validateManifest(JSON.parse(text)) };
  }catch(error){
    return { status: "invalid", error };
  }
}

function readManifest(transactionRoot){
  const manifestPath = baseTransactionPaths(transactionRoot).manifestPath;
  const primary = readManifestCandidate(manifestPath);
  if(primary.status === "valid") return primary.manifest;

  const temporaryCandidates = fs.readdirSync(transactionRoot)
    .filter(name => MANIFEST_TEMP_NAME_PATTERN.test(name))
    .map(name => ({ name, result: readManifestCandidate(path.join(transactionRoot, name)) }));
  const validTemporary = temporaryCandidates
    .filter(candidate => candidate.result.status === "valid")
    .sort((left, right) => {
      const leftTime = Date.parse(left.result.manifest.updatedAt || "") || 0;
      const rightTime = Date.parse(right.result.manifest.updatedAt || "") || 0;
      return rightTime - leftTime || right.name.localeCompare(left.name);
    })[0];
  if(validTemporary) return validTemporary.result.manifest;
  if(primary.status === "invalid") throw primary.error;
  const invalidTemporary = temporaryCandidates.find(candidate => candidate.result.status === "invalid");
  if(invalidTemporary) throw invalidTemporary.result.error;
  const error = new Error("Video transaction manifest is missing");
  error.code = "ENOENT";
  throw error;
}

function ensurePrimaryManifestForCleanup(transactionRoot){
  const manifestPath = baseTransactionPaths(transactionRoot).manifestPath;
  const primary = readManifestCandidate(manifestPath);
  if(primary.status === "valid") return primary.manifest;
  // RED ZONE: keep every existing fallback until a repaired primary is durable and validated.
  const authority = readManifest(transactionRoot);
  const repaired = writeManifest(transactionRoot, authority, { preserveExistingTemps: true });
  const verified = readManifestCandidate(manifestPath);
  if(verified.status !== "valid") throw verified.error || new Error("Video primary manifest repair failed");
  return repaired;
}

function hasManifestCandidate(transactionRoot){
  return fs.readdirSync(transactionRoot).some(name =>
    name === MANIFEST_NAME || MANIFEST_TEMP_NAME_PATTERN.test(name));
}

function emit(onEvent, event, detail = {}){
  if(typeof onEvent !== "function") return;
  try{ onEvent(event, detail); }catch{}
}

function preparationFrom(transactionRoot, logRoot, manifest){
  const paths = transactionPaths(transactionRoot, manifest.input.extension);
  return Object.freeze({
    transactionId: manifest.transactionId,
    transactionRoot,
    logRoot,
    candidatePath: paths.candidatePath,
    manifestPath: paths.manifestPath,
    inputName: manifest.input.name,
    inputExtension: manifest.input.extension,
    inputSize: manifest.input.size,
    inputSha256: manifest.input.sha256,
    inputMethod: manifest.input.method,
  });
}

function validatePreparation(preparation){
  if(!preparation || typeof preparation !== "object"){
    throw new Error("Video preparation is required");
  }
  const checked = assertTransactionRoot(preparation.transactionRoot, preparation.logRoot);
  if(!fs.existsSync(checked.transactionRoot)) throw new Error("Video transaction no longer exists");
  const manifest = readManifest(checked.transactionRoot);
  if(manifest.transactionId.toLowerCase() !== checked.transactionId ||
      String(preparation.transactionId || "").toLowerCase() !== checked.transactionId){
    throw new Error("Video transaction identity mismatch");
  }
  return {
    ...checked,
    manifest,
    paths: transactionPaths(checked.transactionRoot, manifest.input.extension),
  };
}

function prepareVideoCandidate({
  sourcePath,
  logRoot,
  inputMethod,
  allowedExtensions = DEFAULT_VIDEO_EXTENSIONS,
  maxBytes = DEFAULT_VIDEO_MAX_BYTES,
} = {}){
  const inspected = inspectVideoCandidate({ sourcePath, allowedExtensions, maxBytes });
  const resolvedLogRoot = ensureDirectoryNoLink(logRoot, "logRoot");
  const transactionId = crypto.randomUUID().toLowerCase();
  const transactionRoot = path.join(resolvedLogRoot, TRANSACTION_PREFIX + transactionId);
  fs.mkdirSync(transactionRoot, { recursive: false });
  const paths = transactionPaths(transactionRoot, inspected.extension);
  try{
    fs.copyFileSync(inspected.absolutePath, paths.candidatePath, fs.constants.COPYFILE_EXCL);
    const candidate = inspectVideoCandidate({
      sourcePath: paths.candidatePath,
      allowedExtensions: [inspected.extension],
      maxBytes,
    });
    const manifest = writeManifest(transactionRoot, {
      version: 1,
      transactionId,
      state: "prepared",
      phase: "prepared",
      createdAt: new Date().toISOString(),
      input: {
        name: safeDisplayName(inspected.name, inspected.extension),
        extension: inspected.extension,
        size: candidate.size,
        sha256: hashFile(paths.candidatePath),
        method: safeMethod(inputMethod),
      },
      hadJob: null,
      nextJobSha256: null,
      installedName: null,
      moved: { sourceVideos: [] },
    });
    return preparationFrom(transactionRoot, resolvedLogRoot, manifest);
  }catch(error){
    try{ cleanupTransactionRoot(transactionRoot, resolvedLogRoot); }catch{}
    throw error;
  }
}

function discardPreparedVideoCandidate(preparation){
  if(!preparation?.transactionRoot || !fs.existsSync(preparation.transactionRoot)) return false;
  const context = validatePreparation(preparation);
  if(["committing", "rolling_back"].includes(context.manifest.state)){
    throw new Error("An active video transaction must be recovered, not discarded");
  }
  cleanupTransactionRoot(context.transactionRoot, context.logRoot);
  return true;
}

function ensureCommitLayout({ logRoot, sourceRoot, jobPath }){
  const resolvedLogRoot = ensureDirectoryNoLink(logRoot, "logRoot");
  const resolvedSourceRoot = ensureDirectoryNoLink(sourceRoot, "sourceRoot");
  const resolvedJobPath = path.resolve(jobPath);
  const resolvedJobParent = ensureDirectoryNoLink(path.dirname(resolvedJobPath), "jobPath parent");
  if(pathsOverlap(resolvedSourceRoot, resolvedLogRoot)){
    throw new Error("Video lifecycle roots must not overlap");
  }
  if(samePath(resolvedJobPath, resolvedSourceRoot) || isInside(resolvedSourceRoot, resolvedJobPath) ||
      isInside(resolvedLogRoot, resolvedJobPath)){
    throw new Error("jobPath must be outside managed source and log roots");
  }
  const devices = [resolvedLogRoot, resolvedSourceRoot, resolvedJobParent]
    .map(directory => fs.statSync(directory).dev);
  if(devices.some(device => device !== devices[0])){
    throw new Error("Video lifecycle roots must be on the same filesystem");
  }
  if(fs.existsSync(resolvedJobPath)){
    const stat = fs.lstatSync(resolvedJobPath);
    if(stat.isSymbolicLink() || !stat.isFile()) throw new Error("jobPath must be a regular file");
  }
  return {
    logRoot: resolvedLogRoot,
    sourceRoot: resolvedSourceRoot,
    jobPath: resolvedJobPath,
  };
}

function sourceVideoEntries(sourceRoot){
  return fs.readdirSync(sourceRoot)
    .filter(name => SOURCE_VIDEO_PATTERN.test(name))
    .sort()
    .map(name => ({ name, absolutePath: path.join(sourceRoot, name) }));
}

function moveSourceVideosToBackup(sourceRoot, backupRoot, manifest, transactionRoot){
  ensureDirectoryNoLink(backupRoot, "video source backup");
  let nextManifest = manifest;
  for(const entry of sourceVideoEntries(sourceRoot)){
    const stat = fs.lstatSync(entry.absolutePath);
    if(stat.isSymbolicLink() || !stat.isFile()){
      throw new Error("Existing source video must be a regular direct child: " + entry.name);
    }
    const destination = path.join(backupRoot, entry.name);
    if(fs.existsSync(destination)) throw new Error("Duplicate video transaction backup: " + entry.name);
    fs.renameSync(entry.absolutePath, destination);
    nextManifest = {
      ...nextManifest,
      moved: {
        ...nextManifest.moved,
        sourceVideos: [...nextManifest.moved.sourceVideos, entry.name],
      },
    };
    nextManifest = writeManifest(transactionRoot, nextManifest);
  }
  return nextManifest;
}

function createVerifiedJobBackup(jobPath, backupPath){
  const partialPath = backupPath + ".partial";
  if(fs.existsSync(partialPath)) removeTreeNoFollow(partialPath);
  fs.copyFileSync(jobPath, partialPath, fs.constants.COPYFILE_EXCL);
  const sourceStat = fs.lstatSync(jobPath);
  const backupStat = fs.lstatSync(partialPath);
  if(sourceStat.isSymbolicLink() || !sourceStat.isFile() ||
      backupStat.isSymbolicLink() || !backupStat.isFile() ||
      sourceStat.size !== backupStat.size || hashFile(jobPath) !== hashFile(partialPath)){
    throw new Error("Video transaction job backup verification failed");
  }
  replaceFromStagedFile(partialPath, backupPath, "Video transaction Job backup");
}

function restoreSourceVideoBackups(backupRoot, sourceRoot){
  if(!fs.existsSync(backupRoot)) return;
  const rootStat = fs.lstatSync(backupRoot);
  if(rootStat.isSymbolicLink() || !rootStat.isDirectory()){
    throw new Error("Invalid video source backup directory");
  }
  for(const name of fs.readdirSync(backupRoot)){
    if(!SOURCE_VIDEO_PATTERN.test(name)){
      throw new Error("Unexpected video source backup entry: " + name);
    }
    const source = path.join(backupRoot, name);
    const sourceStat = fs.lstatSync(source);
    if(sourceStat.isSymbolicLink() || !sourceStat.isFile()){
      throw new Error("Video source backup must be a regular file: " + name);
    }
    const destination = path.join(sourceRoot, name);
    if(fs.existsSync(destination)){
      throw new Error("Video rollback destination already exists: " + name);
    }
    fs.renameSync(source, destination);
  }
}

function replaceJobFromStagedFile(stagedPath, jobPath){
  return replaceFromStagedFile(stagedPath, jobPath, "Staged Job");
}

function restoreJobBackup(context, jobInstallPossible = true){
  const { paths, manifest, jobPath, transactionRoot } = context;
  // hadJob is persisted only after the verified backup is complete; null means the live Job is still untouched.
  if(manifest.hadJob === null) return;
  if(manifest.hadJob === true && fs.existsSync(paths.jobBackupPath)){
    const backupStat = fs.lstatSync(paths.jobBackupPath);
    if(backupStat.isSymbolicLink() || !backupStat.isFile()){
      throw new Error("Invalid video transaction Job backup");
    }
    const restorePath = path.join(transactionRoot, "restore-job.json");
    if(fs.existsSync(restorePath)) removeTreeNoFollow(restorePath);
    fs.copyFileSync(paths.jobBackupPath, restorePath, fs.constants.COPYFILE_EXCL);
    replaceJobFromStagedFile(restorePath, jobPath);
    return;
  }
  if(manifest.hadJob === true){
    throw new Error("Verified previous video Job backup is missing");
  }
  // Commit installs the Job only after moving the candidate. If the candidate is still staged,
  // an interrupted partial backup must not make recovery delete or replace the untouched Job.
  if(!jobInstallPossible) return;
  if(fs.existsSync(jobPath) && manifest.nextJobSha256){
    const stat = fs.lstatSync(jobPath);
    if(stat.isSymbolicLink() || !stat.isFile()){
      throw new Error("Unexpected jobPath during video rollback");
    }
    if(hashFile(jobPath) !== manifest.nextJobSha256){
      throw new Error("Refusing to remove an unrecognized Job during video rollback");
    }
    fs.unlinkSync(jobPath);
  }
}

function installedVideoName(manifest){
  const expected = "video" + checkedExtension(manifest.input.extension);
  const name = manifest.installedName === null || manifest.installedName === undefined
    ? expected
    : String(manifest.installedName);
  if(name !== expected || path.basename(name) !== name){
    throw new Error("Invalid installed video name in transaction manifest");
  }
  return name;
}

function rollbackTransaction(context){
  const { paths, manifest, sourceRoot } = context;
  if(manifest.hadJob === true && !fs.existsSync(paths.jobBackupPath)){
    // Never mutate an interrupted transaction further when its previous Job cannot be restored.
    throw new Error("Verified previous video Job backup is missing");
  }
  const candidateStillStaged = fs.existsSync(paths.candidatePath);
  const installedName = installedVideoName(manifest);
  const installedPath = path.join(sourceRoot, installedName);
  const previousInstalledNameWasMoved = Array.isArray(manifest.moved?.sourceVideos) &&
    manifest.moved.sourceVideos.includes(installedName);
  const previousInstalledNameStillBackedUp = fs.existsSync(path.join(paths.sourceBackupRoot, installedName));
  // A retry after rollback must not delete the restored old video once its backup was consumed.
  const shouldRemoveInstalledCandidate = !candidateStillStaged &&
    (!previousInstalledNameWasMoved || previousInstalledNameStillBackedUp);
  if(shouldRemoveInstalledCandidate && fs.existsSync(installedPath)){
    const stat = fs.lstatSync(installedPath);
    if(stat.isSymbolicLink() || !stat.isFile()){
      throw new Error("Refusing to remove an unexpected installed video entry");
    }
    if(hashFile(installedPath) !== manifest.input.sha256){
      throw new Error("Refusing to remove an unrecognized installed video");
    }
    fs.unlinkSync(installedPath);
  }
  restoreSourceVideoBackups(paths.sourceBackupRoot, sourceRoot);
  restoreJobBackup(context, !candidateStillStaged);
}

function readRollbackMarkerCandidate(filePath, context){
  let stat;
  try{
    stat = fs.lstatSync(filePath);
  }catch(error){
    if(error.code === "ENOENT") return { status: "missing" };
    throw error;
  }
  if(stat.isSymbolicLink() || !stat.isFile()) return { status: "invalid" };
  try{
    const marker = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const valid = marker?.version === 1 && marker.kind === "video" &&
      String(marker.transactionId || "").toLowerCase() === context.transactionId;
    return valid ? { status: "valid", marker } : { status: "invalid" };
  }catch{
    return { status: "invalid" };
  }
}

function rollbackAlreadyComplete(context){
  const markerPath = context.paths.rollbackMarkerPath;
  if(readRollbackMarkerCandidate(markerPath, context).status === "valid") return true;
  const stagedCandidates = fs.readdirSync(context.transactionRoot)
    .filter(name => ROLLBACK_MARKER_TEMP_NAME_PATTERN.test(name))
    .sort()
    .map(name => path.join(context.transactionRoot, name));
  const validStagedPath = stagedCandidates.find(candidatePath =>
    readRollbackMarkerCandidate(candidatePath, context).status === "valid");
  if(!validStagedPath) return false;
  // RED ZONE: a durable valid staged marker is completion proof; promote it before trusting the marker.
  replaceFromStagedFile(validStagedPath, markerPath, "Video rollback completion marker");
  return readRollbackMarkerCandidate(markerPath, context).status === "valid";
}

function nextRollbackMarkerStagingPath(context){
  let candidatePath;
  do{
    candidatePath = context.paths.rollbackMarkerPath + ".tmp-" + crypto.randomUUID();
  }while(fs.existsSync(candidatePath));
  return candidatePath;
}

function writeRollbackCompletionMarker(context){
  if(rollbackAlreadyComplete(context)) return;
  const text = JSON.stringify({
    version: 1,
    kind: "video",
    transactionId: context.transactionId,
    completedAt: new Date().toISOString(),
  }, null, 2) + "\n";
  let lastError = null;
  for(let attempt = 0; attempt < REPLACE_RETRY_COUNT; attempt += 1){
    const stagedPath = nextRollbackMarkerStagingPath(context);
    try{
      writeTextDurably(stagedPath, text, true);
      replaceFromStagedFile(stagedPath, context.paths.rollbackMarkerPath, "Video rollback completion marker");
      if(!rollbackAlreadyComplete(context)) throw new Error("Video rollback completion marker verification failed");
      return;
    }catch(error){
      if(!isTransientRenameError(error)) throw error;
      lastError = error;
      if(attempt + 1 < REPLACE_RETRY_COUNT) waitForReplaceRetry(attempt);
    }
  }
  throw lastError || new Error("Video rollback completion marker could not be written");
}

function markRollbackComplete(context){
  writeRollbackCompletionMarker(context);
  context.manifest = writeManifest(context.transactionRoot, {
    ...context.manifest,
    state: "rolled_back",
    phase: "rolled_back",
    rolledBackAt: new Date().toISOString(),
  });
  return context.manifest;
}

function serializeNextJob(nextJob){
  if(!nextJob || typeof nextJob !== "object" || Array.isArray(nextJob)){
    throw new Error("nextJob must be a JSON object");
  }
  const text = JSON.stringify(nextJob, null, 2) + "\n";
  return {
    text,
    value: JSON.parse(text),
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
  };
}

function commitPreparedVideo({ preparation, sourceRoot, jobPath, nextJob, onEvent } = {}){
  const prepared = validatePreparation(preparation);
  if(prepared.manifest.state !== "prepared"){
    throw new Error("Video transaction is not prepared");
  }
  const layout = ensureCommitLayout({
    logRoot: prepared.logRoot,
    sourceRoot,
    jobPath,
  });
  const context = { ...prepared, ...layout };
  const candidate = inspectVideoCandidate({
    sourcePath: prepared.paths.candidatePath,
    allowedExtensions: [prepared.manifest.input.extension],
    maxBytes: prepared.manifest.input.size,
  });
  if(candidate.size !== prepared.manifest.input.size ||
      hashFile(prepared.paths.candidatePath) !== prepared.manifest.input.sha256){
    throw new Error("Prepared video candidate changed before commit");
  }
  const serializedJob = serializeNextJob(nextJob);
  writeTextDurably(prepared.paths.nextJobPath, serializedJob.text, true);

  let manifest = writeManifest(prepared.transactionRoot, {
    ...prepared.manifest,
    state: "committing",
    phase: "backing_up_job",
    nextJobSha256: serializedJob.sha256,
  });
  context.manifest = manifest;
  emit(onEvent, "job_video_commit_started", {
    transactionId: prepared.transactionId,
    inputName: manifest.input.name,
  });

  try{
    ensureDirectoryNoLink(prepared.paths.backupRoot, "video transaction backup");
    const hadJob = fs.existsSync(layout.jobPath);
    if(hadJob) createVerifiedJobBackup(layout.jobPath, prepared.paths.jobBackupPath);
    manifest = writeManifest(prepared.transactionRoot, {
      ...manifest,
      hadJob,
      phase: "moving_source_videos",
    });
    context.manifest = manifest;

    manifest = moveSourceVideosToBackup(
      layout.sourceRoot,
      prepared.paths.sourceBackupRoot,
      manifest,
      prepared.transactionRoot,
    );
    const installedName = "video" + manifest.input.extension;
    manifest = writeManifest(prepared.transactionRoot, {
      ...manifest,
      phase: "installing_candidate",
      installedName,
    });
    context.manifest = manifest;

    const installedPath = path.join(layout.sourceRoot, installedName);
    if(fs.existsSync(installedPath)) throw new Error("Installed video target still exists after backup");
    fs.renameSync(prepared.paths.candidatePath, installedPath);
    manifest = writeManifest(prepared.transactionRoot, { ...manifest, phase: "installing_job" });
    context.manifest = manifest;

    replaceJobFromStagedFile(prepared.paths.nextJobPath, layout.jobPath);
    manifest = writeManifest(prepared.transactionRoot, {
      ...manifest,
      state: "committed",
      phase: "committed",
      committedAt: new Date().toISOString(),
    });
    context.manifest = manifest;
    emit(onEvent, "job_video_commit_committed", {
      transactionId: prepared.transactionId,
      inputName: manifest.input.name,
      installedName,
      replacedVideoCount: manifest.moved.sourceVideos.length,
    });

    let cleanupDeferred = false;
    try{
      cleanupTransactionRoot(prepared.transactionRoot, prepared.logRoot);
    }catch(error){
      cleanupDeferred = true;
      emit(onEvent, "job_video_commit_cleanup_deferred", {
        transactionId: prepared.transactionId,
        code: error.code || "CLEANUP_FAILED",
      });
    }
    return {
      transactionId: prepared.transactionId,
      job: serializedJob.value,
      inputName: manifest.input.name,
      installedName,
      replacedVideoCount: manifest.moved.sourceVideos.length,
      cleanupDeferred,
    };
  }catch(error){
    emit(onEvent, "job_video_commit_rollback_started", {
      transactionId: prepared.transactionId,
      code: error.code || "COMMIT_FAILED",
    });
    let rollbackError = null;
    try{
      context.manifest = writeManifest(prepared.transactionRoot, {
        ...context.manifest,
        state: "rolling_back",
        phase: "rolling_back",
      });
      rollbackTransaction(context);
      markRollbackComplete(context);
      emit(onEvent, "job_video_commit_rollback_completed", {
        transactionId: prepared.transactionId,
      });
      try{
        cleanupTransactionRoot(prepared.transactionRoot, prepared.logRoot);
      }catch(cleanupError){
        emit(onEvent, "job_video_commit_rollback_cleanup_deferred", {
          transactionId: prepared.transactionId,
          code: cleanupError.code || "CLEANUP_DEFERRED",
        });
      }
    }catch(candidateError){
      rollbackError = candidateError;
      emit(onEvent, "job_video_commit_rollback_failed", {
        transactionId: prepared.transactionId,
        code: candidateError.code || "ROLLBACK_FAILED",
      });
    }
    if(rollbackError){
      const combined = new Error(error.message + "; rollback failed: " + rollbackError.message);
      combined.cause = error;
      combined.rollbackError = rollbackError;
      throw combined;
    }
    throw error;
  }
}

function hasTransactionBackup(transactionRoot){
  return fs.existsSync(baseTransactionPaths(transactionRoot).backupRoot);
}

function recoverVideoTransactions({ logRoot, sourceRoot, jobPath, onEvent } = {}){
  const layout = ensureCommitLayout({ logRoot, sourceRoot, jobPath });
  const result = { recovered: 0, cleaned: 0, deferred: 0, failed: 0, failures: [] };
  for(const name of fs.readdirSync(layout.logRoot)){
    const match = name.match(TRANSACTION_NAME_PATTERN);
    if(!match) continue;
    const transactionRoot = path.join(layout.logRoot, name);
    const lstat = fs.lstatSync(transactionRoot);
    if(lstat.isSymbolicLink()){
      fs.unlinkSync(transactionRoot);
      result.cleaned += 1;
      emit(onEvent, "job_video_recovery_link_removed", { transactionId: match[1].toLowerCase() });
      continue;
    }
    if(!lstat.isDirectory()) continue;
    const checked = assertTransactionRoot(transactionRoot, layout.logRoot);
    emit(onEvent, "job_video_recovery_started", { transactionId: checked.transactionId });
    try{
      if(!hasManifestCandidate(transactionRoot)){
        if(hasTransactionBackup(transactionRoot)){
          throw new Error("Video transaction backup exists without a manifest");
        }
        try{
          cleanupTransactionRoot(transactionRoot, layout.logRoot);
          result.cleaned += 1;
        }catch(error){
          if(!isTransientRenameError(error)) throw error;
          result.deferred += 1;
          emit(onEvent, "job_video_recovery_cleanup_deferred", {
            transactionId: checked.transactionId,
            code: error.code || "CLEANUP_DEFERRED",
          });
        }
        continue;
      }
      const manifest = readManifest(transactionRoot);
      if(manifest.transactionId.toLowerCase() !== checked.transactionId){
        throw new Error("Video transaction directory and manifest do not match");
      }
      if(manifest.state === "prepared" || manifest.state === "committed" || manifest.state === "rolled_back"){
        try{
          cleanupTransactionRoot(transactionRoot, layout.logRoot);
          result.cleaned += 1;
          emit(onEvent, "job_video_recovery_orphan_cleaned", {
            transactionId: checked.transactionId,
            state: manifest.state,
          });
        }catch(error){
          if(!isTransientRenameError(error)) throw error;
          result.deferred += 1;
          emit(onEvent, "job_video_recovery_cleanup_deferred", {
            transactionId: checked.transactionId,
            state: manifest.state,
            code: error.code || "CLEANUP_DEFERRED",
          });
        }
        continue;
      }
      if(manifest.state !== "committing" && manifest.state !== "rolling_back"){
        throw new Error("Unknown video transaction state: " + manifest.state);
      }
      const context = {
        ...checked,
        ...layout,
        manifest,
        paths: transactionPaths(transactionRoot, manifest.input.extension),
      };
      const alreadyComplete = rollbackAlreadyComplete(context);
      if(!alreadyComplete) rollbackTransaction(context);
      markRollbackComplete(context);
      result.recovered += 1;
      try{
        cleanupTransactionRoot(transactionRoot, layout.logRoot);
      }catch(error){
        if(!isTransientRenameError(error)) throw error;
        result.deferred += 1;
        emit(onEvent, "job_video_recovery_cleanup_deferred", {
          transactionId: checked.transactionId,
          state: "rolled_back",
          code: error.code || "CLEANUP_DEFERRED",
        });
      }
      emit(onEvent, "job_video_recovery_rolled_back", {
        transactionId: checked.transactionId,
        alreadyComplete,
      });
    }catch(error){
      result.failed += 1;
      result.failures.push({ transactionId: checked.transactionId, code: error.code || "RECOVERY_FAILED" });
      emit(onEvent, "job_video_recovery_failed", {
        transactionId: checked.transactionId,
        code: error.code || "RECOVERY_FAILED",
      });
    }
  }
  return result;
}

module.exports = {
  inspectVideoCandidate,
  prepareVideoCandidate,
  discardPreparedVideoCandidate,
  commitPreparedVideo,
  recoverVideoTransactions,
};
