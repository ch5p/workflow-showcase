"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const XML_MAX_BYTES = 64 * 1024 * 1024;
const TRANSACTION_PREFIX = ".job-import-";
const TRANSACTION_NAME_PATTERN = /^\.job-import-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const MANIFEST_NAME = "manifest.json";
const MANIFEST_TEMP_NAME_PATTERN = /^manifest\.json\.tmp(?:-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$/i;
const ROLLBACK_MARKER_NAME = "rollback-complete.json";
const ROLLBACK_MARKER_TEMP_NAME_PATTERN = /^rollback-complete\.json\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANDIDATE_NAME = "candidate.xml";
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
  if(stat.isSymbolicLink() || !stat.isDirectory()){
    throw new Error(label + " must be a real directory");
  }
  return resolved;
}

function normalizeExtensions(allowedExtensions){
  const values = allowedExtensions instanceof Set
    ? [...allowedExtensions]
    : Array.isArray(allowedExtensions) ? allowedExtensions : [];
  if(!values.length) throw new Error("At least one allowed extension is required");
  return new Set(values.map(value => {
    const normalized = String(value || "").trim().toLowerCase();
    if(!normalized) throw new Error("Allowed extensions cannot be empty");
    return normalized.startsWith(".") ? normalized : "." + normalized;
  }));
}

function inspectInputFile(sourcePath, allowedExtensions, maxBytes){
  if(typeof sourcePath !== "string" || !sourcePath.trim()){
    throw new Error("Input path is required");
  }
  const limit = maxBytes === undefined ? XML_MAX_BYTES : Number(maxBytes);
  if(!Number.isSafeInteger(limit) || limit <= 0){
    throw new Error("maxBytes must be a positive safe integer");
  }
  const absolutePath = path.resolve(sourcePath);
  const stat = fs.lstatSync(absolutePath);
  if(stat.isSymbolicLink() || !stat.isFile()){
    throw new Error("Input must be a regular file");
  }
  const extension = path.extname(absolutePath).toLowerCase();
  if(!normalizeExtensions(allowedExtensions).has(extension)){
    throw new Error("Input extension is not allowed: " + (extension || "(none)"));
  }
  if(stat.size <= 0) throw new Error("Input file is empty");
  if(stat.size > limit){
    throw new Error("Input file exceeds the " + limit + " byte limit");
  }
  return {
    absolutePath,
    extension,
    name: path.basename(absolutePath),
    size: stat.size,
  };
}

function safeDisplayName(value){
  return String(value || "timeline.xml")
    .replace(/[\x00-\x1f\x7f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 255) || "timeline.xml";
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

function transactionPaths(transactionRoot){
  return {
    manifestPath: path.join(transactionRoot, MANIFEST_NAME),
    candidatePath: path.join(transactionRoot, CANDIDATE_NAME),
    nextJobPath: path.join(transactionRoot, NEXT_JOB_NAME),
    rollbackMarkerPath: path.join(transactionRoot, ROLLBACK_MARKER_NAME),
    backupRoot: path.join(transactionRoot, "backup"),
    sourceBackupRoot: path.join(transactionRoot, "backup", "source"),
    referencesBackupRoot: path.join(transactionRoot, "backup", "references"),
    jobBackupPath: path.join(transactionRoot, "backup", "job.json"),
  };
}

function assertTransactionRoot(transactionRoot, logRoot){
  const resolvedLogRoot = ensureDirectoryNoLink(logRoot, "logRoot");
  const resolvedTransactionRoot = path.resolve(transactionRoot);
  const match = path.basename(resolvedTransactionRoot).match(TRANSACTION_NAME_PATTERN);
  if(!match || !samePath(path.dirname(resolvedTransactionRoot), resolvedLogRoot)){
    throw new Error("Unsafe XML transaction root");
  }
  if(fs.existsSync(resolvedTransactionRoot)){
    const stat = fs.lstatSync(resolvedTransactionRoot);
    if(stat.isSymbolicLink() || !stat.isDirectory()){
      throw new Error("XML transaction root is not a real directory");
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
  const paths = transactionPaths(transactionRoot);
  const next = { ...manifest, updatedAt: new Date().toISOString() };
  const temporaryPath = preserveExistingTemps
    ? nextUniqueManifestStagingPath(paths.manifestPath)
    : nextManifestStagingPath(paths.manifestPath);
  writeTextDurably(temporaryPath, JSON.stringify(next, null, 2) + "\n", true);
  replaceFromStagedFile(temporaryPath, paths.manifestPath, "XML transaction manifest");
  return next;
}

function validateManifest(manifest){
  if(!manifest || manifest.version !== 1 || typeof manifest.transactionId !== "string"){
    throw new Error("Invalid XML transaction manifest");
  }
  return manifest;
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
    return { status: "invalid", error: new Error("XML transaction manifest must be a regular file") };
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
  const manifestPath = transactionPaths(transactionRoot).manifestPath;
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
  const error = new Error("XML transaction manifest is missing");
  error.code = "ENOENT";
  throw error;
}

function ensurePrimaryManifestForCleanup(transactionRoot){
  const manifestPath = transactionPaths(transactionRoot).manifestPath;
  const primary = readManifestCandidate(manifestPath);
  if(primary.status === "valid") return primary.manifest;
  // RED ZONE: keep every existing fallback until a repaired primary is durable and validated.
  const authority = readManifest(transactionRoot);
  const repaired = writeManifest(transactionRoot, authority, { preserveExistingTemps: true });
  const verified = readManifestCandidate(manifestPath);
  if(verified.status !== "valid") throw verified.error || new Error("XML primary manifest repair failed");
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
  const paths = transactionPaths(transactionRoot);
  return Object.freeze({
    transactionId: manifest.transactionId,
    transactionRoot,
    logRoot,
    candidatePath: paths.candidatePath,
    manifestPath: paths.manifestPath,
    inputName: manifest.input.name,
    inputSize: manifest.input.size,
    inputSha256: manifest.input.sha256,
    inputMethod: manifest.input.method,
  });
}

function validatePreparation(preparation){
  if(!preparation || typeof preparation !== "object"){
    throw new Error("XML preparation is required");
  }
  const checked = assertTransactionRoot(preparation.transactionRoot, preparation.logRoot);
  if(!fs.existsSync(checked.transactionRoot)) throw new Error("XML transaction no longer exists");
  const manifest = readManifest(checked.transactionRoot);
  if(manifest.transactionId.toLowerCase() !== checked.transactionId ||
      String(preparation.transactionId || "").toLowerCase() !== checked.transactionId){
    throw new Error("XML transaction identity mismatch");
  }
  return { ...checked, manifest, paths: transactionPaths(checked.transactionRoot) };
}

function prepareXmlCandidate({ sourcePath, logRoot, inputMethod } = {}){
  const inspected = inspectInputFile(sourcePath, [".xml"], XML_MAX_BYTES);
  const resolvedLogRoot = ensureDirectoryNoLink(logRoot, "logRoot");
  const transactionId = crypto.randomUUID().toLowerCase();
  const transactionRoot = path.join(resolvedLogRoot, TRANSACTION_PREFIX + transactionId);
  fs.mkdirSync(transactionRoot, { recursive: false });
  const paths = transactionPaths(transactionRoot);
  try{
    fs.copyFileSync(inspected.absolutePath, paths.candidatePath, fs.constants.COPYFILE_EXCL);
    const candidate = inspectInputFile(paths.candidatePath, [".xml"], XML_MAX_BYTES);
    const manifest = writeManifest(transactionRoot, {
      version: 1,
      transactionId,
      state: "prepared",
      phase: "prepared",
      createdAt: new Date().toISOString(),
      input: {
        name: safeDisplayName(inspected.name),
        size: candidate.size,
        sha256: hashFile(paths.candidatePath),
        method: String(inputMethod || "unknown").replace(/[\x00-\x1f\x7f]/g, "_").slice(0, 40),
      },
      hadJob: null,
      nextJobSha256: null,
      moved: { source: [], references: [] },
    });
    return preparationFrom(transactionRoot, resolvedLogRoot, manifest);
  }catch(error){
    try{ cleanupTransactionRoot(transactionRoot, resolvedLogRoot); }catch{}
    throw error;
  }
}

function discardPreparedCandidate(preparation){
  if(!preparation?.transactionRoot || !fs.existsSync(preparation.transactionRoot)) return false;
  const context = validatePreparation(preparation);
  if(["committing", "rolling_back"].includes(context.manifest.state)){
    throw new Error("An active XML transaction must be recovered, not discarded");
  }
  cleanupTransactionRoot(context.transactionRoot, context.logRoot);
  return true;
}

function ensureCommitLayout({ logRoot, sourceRoot, referencesRoot, jobPath }){
  const resolvedLogRoot = ensureDirectoryNoLink(logRoot, "logRoot");
  const resolvedSourceRoot = ensureDirectoryNoLink(sourceRoot, "sourceRoot");
  const resolvedReferencesRoot = ensureDirectoryNoLink(referencesRoot, "referencesRoot");
  const resolvedJobPath = path.resolve(jobPath);
  const resolvedJobParent = ensureDirectoryNoLink(path.dirname(resolvedJobPath), "jobPath parent");
  if(pathsOverlap(resolvedSourceRoot, resolvedReferencesRoot) ||
      pathsOverlap(resolvedSourceRoot, resolvedLogRoot) ||
      pathsOverlap(resolvedReferencesRoot, resolvedLogRoot)){
    throw new Error("XML lifecycle roots must not overlap");
  }
  if(samePath(resolvedJobPath, resolvedSourceRoot) || samePath(resolvedJobPath, resolvedReferencesRoot) ||
      isInside(resolvedSourceRoot, resolvedJobPath) || isInside(resolvedReferencesRoot, resolvedJobPath) ||
      isInside(resolvedLogRoot, resolvedJobPath)){
    throw new Error("jobPath must be outside managed source, reference, and log roots");
  }
  const devices = [resolvedLogRoot, resolvedSourceRoot, resolvedReferencesRoot, resolvedJobParent]
    .map(directory => fs.statSync(directory).dev);
  if(devices.some(device => device !== devices[0])){
    throw new Error("XML lifecycle roots must be on the same filesystem");
  }
  if(fs.existsSync(resolvedJobPath)){
    const stat = fs.lstatSync(resolvedJobPath);
    if(stat.isSymbolicLink() || !stat.isFile()) throw new Error("jobPath must be a regular file");
  }
  return {
    logRoot: resolvedLogRoot,
    sourceRoot: resolvedSourceRoot,
    referencesRoot: resolvedReferencesRoot,
    jobPath: resolvedJobPath,
  };
}

function directEntries(rootPath){
  return fs.readdirSync(rootPath)
    .filter(name => name !== ".gitkeep")
    .map(name => ({ name, absolutePath: path.join(rootPath, name) }));
}

function moveEntriesToBackup(rootPath, backupRoot, manifest, manifestKey, transactionRoot){
  fs.mkdirSync(backupRoot, { recursive: true });
  let nextManifest = manifest;
  for(const entry of directEntries(rootPath)){
    fs.lstatSync(entry.absolutePath); // lstat verifies the entry without following a link or junction.
    const destination = path.join(backupRoot, entry.name);
    if(fs.existsSync(destination)) throw new Error("Duplicate transaction backup entry: " + entry.name);
    fs.renameSync(entry.absolutePath, destination);
    nextManifest = {
      ...nextManifest,
      moved: {
        ...nextManifest.moved,
        [manifestKey]: [...nextManifest.moved[manifestKey], entry.name],
      },
    };
    nextManifest = writeManifest(transactionRoot, nextManifest);
  }
  return nextManifest;
}

function moveTimelineToBackup(sourceRoot, backupRoot, manifest, transactionRoot){
  const timelinePath = path.join(sourceRoot, "timeline.xml");
  if(!fs.existsSync(timelinePath)) return manifest;
  const stat = fs.lstatSync(timelinePath);
  if(stat.isSymbolicLink() || !stat.isFile()){
    throw new Error("Existing timeline.xml must be a regular file");
  }
  fs.mkdirSync(backupRoot, { recursive: true });
  const destination = path.join(backupRoot, "timeline.xml");
  if(fs.existsSync(destination)) throw new Error("Duplicate timeline.xml transaction backup");
  fs.renameSync(timelinePath, destination);
  return writeManifest(transactionRoot, {
    ...manifest,
    moved: {
      ...manifest.moved,
      source: [...manifest.moved.source, "timeline.xml"],
    },
  });
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
    throw new Error("Job backup verification failed");
  }
  replaceFromStagedFile(partialPath, backupPath, "XML transaction Job backup");
}

function restoreBackupEntries(backupRoot, destinationRoot){
  if(!fs.existsSync(backupRoot)) return;
  const stat = fs.lstatSync(backupRoot);
  if(stat.isSymbolicLink() || !stat.isDirectory()){
    throw new Error("Invalid transaction backup directory");
  }
  for(const name of fs.readdirSync(backupRoot)){
    const source = path.join(backupRoot, name);
    const destination = path.join(destinationRoot, name);
    fs.lstatSync(source);
    if(fs.existsSync(destination)){
      throw new Error("Rollback destination already exists: " + name);
    }
    fs.renameSync(source, destination);
  }
}

function replaceJobFromStagedFile(stagedPath, jobPath){
  return replaceFromStagedFile(stagedPath, jobPath, "Staged Job");
}

function restoreJobBackup(context){
  const { paths, manifest, jobPath, transactionRoot } = context;
  // hadJob is persisted only after the verified backup is complete; null means the live Job is still untouched.
  if(manifest.hadJob === null) return;
  if(manifest.hadJob === true && fs.existsSync(paths.jobBackupPath)){
    const backupStat = fs.lstatSync(paths.jobBackupPath);
    if(backupStat.isSymbolicLink() || !backupStat.isFile()){
      throw new Error("Invalid job backup");
    }
    const restorePath = path.join(transactionRoot, "restore-job.json");
    if(fs.existsSync(restorePath)) removeTreeNoFollow(restorePath);
    fs.copyFileSync(paths.jobBackupPath, restorePath, fs.constants.COPYFILE_EXCL);
    replaceJobFromStagedFile(restorePath, jobPath);
    return;
  }
  if(manifest.hadJob === true){
    throw new Error("Verified previous Job backup is missing");
  }
  if(fs.existsSync(jobPath) && manifest.hadJob === false && manifest.nextJobSha256){
    const stat = fs.lstatSync(jobPath);
    if(stat.isSymbolicLink() || !stat.isFile()) throw new Error("Unexpected jobPath during rollback");
    if(hashFile(jobPath) !== manifest.nextJobSha256){
      throw new Error("Refusing to remove an unrecognized job file during rollback");
    }
    fs.unlinkSync(jobPath);
    return;
  }
  if(fs.existsSync(jobPath) && manifest.hadJob !== null){
    throw new Error("Unexpected Job file without a verified rollback source");
  }
}

function rollbackTransaction(context){
  const { paths, manifest, sourceRoot, referencesRoot } = context;
  const candidateStillStaged = fs.existsSync(paths.candidatePath);
  const installedTimeline = path.join(sourceRoot, "timeline.xml");
  const previousTimelineWasMoved = Array.isArray(manifest.moved?.source) &&
    manifest.moved.source.includes("timeline.xml");
  const previousTimelineStillBackedUp = fs.existsSync(path.join(paths.sourceBackupRoot, "timeline.xml"));
  // A retry after rollback must not delete the restored old timeline once its backup was consumed.
  const shouldRemoveInstalledCandidate = !candidateStillStaged &&
    (!previousTimelineWasMoved || previousTimelineStillBackedUp);
  if(shouldRemoveInstalledCandidate && fs.existsSync(installedTimeline)){
    const stat = fs.lstatSync(installedTimeline);
    if(stat.isDirectory() && !stat.isSymbolicLink()){
      throw new Error("Refusing to recursively remove an unexpected timeline.xml directory");
    }
    if(stat.isFile() && hashFile(installedTimeline) !== manifest.input.sha256){
      throw new Error("Refusing to remove an unrecognized timeline.xml during rollback");
    }
    fs.unlinkSync(installedTimeline);
  }
  restoreBackupEntries(paths.sourceBackupRoot, sourceRoot);
  restoreBackupEntries(paths.referencesBackupRoot, referencesRoot);
  restoreJobBackup(context);
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
    const valid = marker?.version === 1 && marker.kind === "xml" &&
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
  replaceFromStagedFile(validStagedPath, markerPath, "XML rollback completion marker");
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
    kind: "xml",
    transactionId: context.transactionId,
    completedAt: new Date().toISOString(),
  }, null, 2) + "\n";
  let lastError = null;
  for(let attempt = 0; attempt < REPLACE_RETRY_COUNT; attempt += 1){
    const stagedPath = nextRollbackMarkerStagingPath(context);
    try{
      writeTextDurably(stagedPath, text, true);
      replaceFromStagedFile(stagedPath, context.paths.rollbackMarkerPath, "XML rollback completion marker");
      if(!rollbackAlreadyComplete(context)) throw new Error("XML rollback completion marker verification failed");
      return;
    }catch(error){
      if(!isTransientRenameError(error)) throw error;
      lastError = error;
      if(attempt + 1 < REPLACE_RETRY_COUNT) waitForReplaceRetry(attempt);
    }
  }
  throw lastError || new Error("XML rollback completion marker could not be written");
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
  return { text, value: JSON.parse(text), sha256: crypto.createHash("sha256").update(text).digest("hex") };
}

function commitPreparedXml({ preparation, sourceRoot, referencesRoot, jobPath, nextJob, onEvent } = {}){
  const prepared = validatePreparation(preparation);
  if(prepared.manifest.state !== "prepared"){
    throw new Error("XML transaction is not prepared");
  }
  const layout = ensureCommitLayout({
    logRoot: prepared.logRoot,
    sourceRoot,
    referencesRoot,
    jobPath,
  });
  const context = { ...prepared, ...layout };
  const candidate = inspectInputFile(prepared.paths.candidatePath, [".xml"], XML_MAX_BYTES);
  if(candidate.size !== prepared.manifest.input.size ||
      hashFile(prepared.paths.candidatePath) !== prepared.manifest.input.sha256){
    throw new Error("Prepared XML candidate changed before commit");
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
  emit(onEvent, "job_xml_commit_started", {
    transactionId: prepared.transactionId,
    inputName: manifest.input.name,
  });

  try{
    fs.mkdirSync(prepared.paths.backupRoot, { recursive: true });
    const hadJob = fs.existsSync(layout.jobPath);
    if(hadJob){
      createVerifiedJobBackup(layout.jobPath, prepared.paths.jobBackupPath);
    }
    manifest = writeManifest(prepared.transactionRoot, {
      ...manifest,
      hadJob,
      phase: "moving_source",
    });
    context.manifest = manifest;

    manifest = moveEntriesToBackup(
      layout.sourceRoot,
      prepared.paths.sourceBackupRoot,
      manifest,
      "source",
      prepared.transactionRoot,
    );
    manifest = writeManifest(prepared.transactionRoot, { ...manifest, phase: "moving_references" });
    context.manifest = manifest;
    manifest = moveEntriesToBackup(
      layout.referencesRoot,
      prepared.paths.referencesBackupRoot,
      manifest,
      "references",
      prepared.transactionRoot,
    );
    manifest = writeManifest(prepared.transactionRoot, { ...manifest, phase: "installing_candidate" });
    context.manifest = manifest;

    const installedTimeline = path.join(layout.sourceRoot, "timeline.xml");
    if(fs.existsSync(installedTimeline)) throw new Error("timeline.xml still exists after source reset");
    fs.renameSync(prepared.paths.candidatePath, installedTimeline);
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
    emit(onEvent, "job_xml_commit_committed", {
      transactionId: prepared.transactionId,
      inputName: manifest.input.name,
      removedSourceCount: manifest.moved.source.length,
      removedReferenceCount: manifest.moved.references.length,
    });

    let cleanupDeferred = false;
    try{
      cleanupTransactionRoot(prepared.transactionRoot, prepared.logRoot);
    }catch(error){
      cleanupDeferred = true;
      emit(onEvent, "job_xml_commit_cleanup_deferred", {
        transactionId: prepared.transactionId,
        code: error.code || "CLEANUP_FAILED",
      });
    }
    return {
      transactionId: prepared.transactionId,
      job: serializedJob.value,
      inputName: manifest.input.name,
      removedSourceCount: manifest.moved.source.length,
      removedReferenceCount: manifest.moved.references.length,
      cleanupDeferred,
    };
  }catch(error){
    emit(onEvent, "job_xml_commit_rollback_started", {
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
      emit(onEvent, "job_xml_commit_rollback_completed", {
        transactionId: prepared.transactionId,
      });
      try{
        cleanupTransactionRoot(prepared.transactionRoot, prepared.logRoot);
      }catch(cleanupError){
        emit(onEvent, "job_xml_commit_rollback_cleanup_deferred", {
          transactionId: prepared.transactionId,
          code: cleanupError.code || "CLEANUP_DEFERRED",
        });
      }
    }catch(candidate){
      rollbackError = candidate;
      emit(onEvent, "job_xml_commit_rollback_failed", {
        transactionId: prepared.transactionId,
        code: candidate.code || "ROLLBACK_FAILED",
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

function commitPreparedXmlUpdate({ preparation, sourceRoot, referencesRoot, jobPath, nextJob, onEvent } = {}){
  const prepared = validatePreparation(preparation);
  if(prepared.manifest.state !== "prepared"){
    throw new Error("XML transaction is not prepared");
  }
  const layout = ensureCommitLayout({
    logRoot: prepared.logRoot,
    sourceRoot,
    referencesRoot,
    jobPath,
  });
  const context = { ...prepared, ...layout };
  const candidate = inspectInputFile(prepared.paths.candidatePath, [".xml"], XML_MAX_BYTES);
  if(candidate.size !== prepared.manifest.input.size ||
      hashFile(prepared.paths.candidatePath) !== prepared.manifest.input.sha256){
    throw new Error("Prepared XML candidate changed before commit");
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
  emit(onEvent, "job_xml_update_commit_started", {
    transactionId: prepared.transactionId,
    inputName: manifest.input.name,
  });

  try{
    fs.mkdirSync(prepared.paths.backupRoot, { recursive: true });
    const hadJob = fs.existsSync(layout.jobPath);
    if(hadJob){
      createVerifiedJobBackup(layout.jobPath, prepared.paths.jobBackupPath);
    }
    manifest = writeManifest(prepared.transactionRoot, {
      ...manifest,
      hadJob,
      phase: "moving_source",
    });
    context.manifest = manifest;

    // UPDATE keeps every source asset except timeline.xml and never touches references.
    manifest = moveTimelineToBackup(
      layout.sourceRoot,
      prepared.paths.sourceBackupRoot,
      manifest,
      prepared.transactionRoot,
    );
    manifest = writeManifest(prepared.transactionRoot, { ...manifest, phase: "installing_candidate" });
    context.manifest = manifest;

    const installedTimeline = path.join(layout.sourceRoot, "timeline.xml");
    if(fs.existsSync(installedTimeline)) throw new Error("timeline.xml still exists after update backup");
    fs.renameSync(prepared.paths.candidatePath, installedTimeline);
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
    emit(onEvent, "job_xml_update_commit_committed", {
      transactionId: prepared.transactionId,
      inputName: manifest.input.name,
      replacedTimelineCount: manifest.moved.source.length,
    });

    let cleanupDeferred = false;
    try{
      cleanupTransactionRoot(prepared.transactionRoot, prepared.logRoot);
    }catch(error){
      cleanupDeferred = true;
      emit(onEvent, "job_xml_update_commit_cleanup_deferred", {
        transactionId: prepared.transactionId,
        code: error.code || "CLEANUP_FAILED",
      });
    }
    return {
      transactionId: prepared.transactionId,
      job: serializedJob.value,
      inputName: manifest.input.name,
      removedSourceCount: manifest.moved.source.length,
      removedReferenceCount: 0,
      cleanupDeferred,
    };
  }catch(error){
    emit(onEvent, "job_xml_update_commit_rollback_started", {
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
      emit(onEvent, "job_xml_update_commit_rollback_completed", {
        transactionId: prepared.transactionId,
      });
      try{
        cleanupTransactionRoot(prepared.transactionRoot, prepared.logRoot);
      }catch(cleanupError){
        emit(onEvent, "job_xml_update_commit_rollback_cleanup_deferred", {
          transactionId: prepared.transactionId,
          code: cleanupError.code || "CLEANUP_DEFERRED",
        });
      }
    }catch(candidateError){
      rollbackError = candidateError;
      emit(onEvent, "job_xml_update_commit_rollback_failed", {
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
  const backupRoot = transactionPaths(transactionRoot).backupRoot;
  return fs.existsSync(backupRoot);
}

function recoverXmlTransactions({ logRoot, sourceRoot, referencesRoot, jobPath, onEvent } = {}){
  const layout = ensureCommitLayout({ logRoot, sourceRoot, referencesRoot, jobPath });
  const result = { recovered: 0, cleaned: 0, deferred: 0, failed: 0, failures: [] };
  for(const name of fs.readdirSync(layout.logRoot)){
    const match = name.match(TRANSACTION_NAME_PATTERN);
    if(!match) continue;
    const transactionRoot = path.join(layout.logRoot, name);
    const lstat = fs.lstatSync(transactionRoot);
    if(lstat.isSymbolicLink()){
      fs.unlinkSync(transactionRoot);
      result.cleaned += 1;
      emit(onEvent, "job_xml_recovery_link_removed", { transactionId: match[1].toLowerCase() });
      continue;
    }
    if(!lstat.isDirectory()) continue;
    const checked = assertTransactionRoot(transactionRoot, layout.logRoot);
    emit(onEvent, "job_xml_recovery_started", { transactionId: checked.transactionId });
    try{
      if(!hasManifestCandidate(transactionRoot)){
        if(hasTransactionBackup(transactionRoot)){
          throw new Error("Transaction backup exists without a manifest");
        }
        try{
          cleanupTransactionRoot(transactionRoot, layout.logRoot);
          result.cleaned += 1;
        }catch(error){
          if(!isTransientRenameError(error)) throw error;
          result.deferred += 1;
          emit(onEvent, "job_xml_recovery_cleanup_deferred", {
            transactionId: checked.transactionId,
            code: error.code || "CLEANUP_DEFERRED",
          });
        }
        continue;
      }
      const manifest = readManifest(transactionRoot);
      if(manifest.transactionId.toLowerCase() !== checked.transactionId){
        throw new Error("Transaction directory and manifest do not match");
      }
      if(manifest.state === "prepared" || manifest.state === "committed" || manifest.state === "rolled_back"){
        try{
          cleanupTransactionRoot(transactionRoot, layout.logRoot);
          result.cleaned += 1;
          emit(onEvent, "job_xml_recovery_orphan_cleaned", {
            transactionId: checked.transactionId,
            state: manifest.state,
          });
        }catch(error){
          if(!isTransientRenameError(error)) throw error;
          result.deferred += 1;
          emit(onEvent, "job_xml_recovery_cleanup_deferred", {
            transactionId: checked.transactionId,
            state: manifest.state,
            code: error.code || "CLEANUP_DEFERRED",
          });
        }
        continue;
      }
      if(manifest.state !== "committing" && manifest.state !== "rolling_back"){
        throw new Error("Unknown XML transaction state: " + manifest.state);
      }
      const context = {
        ...checked,
        ...layout,
        manifest,
        paths: transactionPaths(transactionRoot),
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
        emit(onEvent, "job_xml_recovery_cleanup_deferred", {
          transactionId: checked.transactionId,
          state: "rolled_back",
          code: error.code || "CLEANUP_DEFERRED",
        });
      }
      emit(onEvent, "job_xml_recovery_rolled_back", {
        transactionId: checked.transactionId,
        alreadyComplete,
      });
    }catch(error){
      result.failed += 1;
      result.failures.push({ transactionId: checked.transactionId, code: error.code || "RECOVERY_FAILED" });
      emit(onEvent, "job_xml_recovery_failed", {
        transactionId: checked.transactionId,
        code: error.code || "RECOVERY_FAILED",
      });
    }
  }
  return result;
}

module.exports = {
  inspectInputFile,
  prepareXmlCandidate,
  discardPreparedCandidate,
  commitPreparedXml,
  commitPreparedXmlUpdate,
  recoverXmlTransactions,
};
