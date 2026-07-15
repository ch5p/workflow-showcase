"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_RETRY_COUNT = 4;
const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

function waitForRetry(attempt){
  const delayMs = [8, 24, 60][Math.min(attempt, 2)];
  if(typeof SharedArrayBuffer !== "function" || typeof Atomics?.wait !== "function") return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function isTransientRenameError(error){
  return TRANSIENT_RENAME_CODES.has(String(error?.code || "").toUpperCase());
}

function assertRegularFile(filePath, label, fileSystem = fs){
  const stat = fileSystem.lstatSync(filePath);
  if(stat.isSymbolicLink() || !stat.isFile()) throw new Error(label + " must be a regular file");
  return stat;
}

function hashFile(filePath, fileSystem = fs){
  const hash = crypto.createHash("sha256");
  const descriptor = fileSystem.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try{
    let bytesRead = 0;
    do{
      bytesRead = fileSystem.readSync(descriptor, buffer, 0, buffer.length, null);
      if(bytesRead) hash.update(buffer.subarray(0, bytesRead));
    }while(bytesRead);
  }finally{
    fileSystem.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function verifyHash(filePath, expectedSha256, label, fileSystem = fs){
  assertRegularFile(filePath, label, fileSystem);
  if(hashFile(filePath, fileSystem) !== expectedSha256){
    throw new Error(label + " hash verification failed");
  }
}

function writeTextDurably(filePath, text, fileSystem = fs){
  const descriptor = fileSystem.openSync(filePath, "wx");
  try{
    fileSystem.writeFileSync(descriptor, text, "utf8");
    fileSystem.fsyncSync(descriptor);
  }finally{
    fileSystem.closeSync(descriptor);
  }
}

function fsyncExistingFile(filePath, fileSystem = fs){
  assertRegularFile(filePath, "File", fileSystem);
  const descriptor = fileSystem.openSync(filePath, "r+");
  try{
    fileSystem.fsyncSync(descriptor);
  }finally{
    fileSystem.closeSync(descriptor);
  }
}

function replaceByRenameWithRetry(stagedPath, targetPath, {
  label = "Staged file",
  retryCount = DEFAULT_RETRY_COUNT,
  fileSystem = fs,
  wait = waitForRetry,
} = {}){
  const attempts = Number.isSafeInteger(retryCount) && retryCount > 0 ? retryCount : DEFAULT_RETRY_COUNT;
  assertRegularFile(stagedPath, label + " staging file", fileSystem);
  const expectedSha256 = hashFile(stagedPath, fileSystem);
  let lastError = null;

  for(let attempt = 0; attempt < attempts; attempt += 1){
    try{
      fileSystem.renameSync(stagedPath, targetPath);
      verifyHash(targetPath, expectedSha256, label + " destination", fileSystem);
      return { method: "rename", sha256: expectedSha256 };
    }catch(error){
      if(!fileSystem.existsSync(stagedPath) && fileSystem.existsSync(targetPath)){
        verifyHash(targetPath, expectedSha256, label + " destination", fileSystem);
        return { method: "rename", sha256: expectedSha256 };
      }
      if(!isTransientRenameError(error)) throw error;
      lastError = error;
      if(attempt + 1 < attempts) wait(attempt);
    }
  }

  // RED ZONE: a completed staged file is recovery evidence; never delete it after replace exhaustion.
  const error = new Error(label + " could not be installed after Windows file-lock retries. The staged file was preserved.");
  error.code = "FILE_REPLACE_DEFERRED";
  error.stagedPath = stagedPath;
  error.cause = lastError;
  throw error;
}

function writeTextAtomically(targetPath, text, { label = "Text file", fileSystem = fs } = {}){
  const resolvedTarget = path.resolve(targetPath);
  const parent = path.dirname(resolvedTarget);
  fileSystem.mkdirSync(parent, { recursive: true });
  const stagedPath = path.join(parent, "." + path.basename(resolvedTarget) + "." + crypto.randomUUID() + ".tmp");
  writeTextDurably(stagedPath, text, fileSystem);
  return {
    stagedPath,
    ...replaceByRenameWithRetry(stagedPath, resolvedTarget, { label, fileSystem }),
  };
}

function cleanupSiblingStagingFiles(targetPath, fileSystem = fs){
  const resolvedTarget = path.resolve(targetPath);
  const parent = path.dirname(resolvedTarget);
  const prefix = "." + path.basename(resolvedTarget) + ".";
  let removed = 0;
  for(const name of fileSystem.readdirSync(parent)){
    if(!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    const candidate = path.join(parent, name);
    try{
      const stat = fileSystem.lstatSync(candidate);
      if(stat.isSymbolicLink() || !stat.isFile()) continue;
      fileSystem.unlinkSync(candidate);
      removed += 1;
    }catch(error){
      if(!isTransientRenameError(error) && error.code !== "ENOENT") throw error;
    }
  }
  return removed;
}

module.exports = {
  cleanupSiblingStagingFiles,
  fsyncExistingFile,
  isTransientRenameError,
  replaceByRenameWithRetry,
  writeTextAtomically,
};
