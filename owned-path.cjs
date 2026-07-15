"use strict";

const fs = require("node:fs");
const path = require("node:path");

function unsafe(message){
  const error = new Error(message);
  error.code = "STORED_PATH_UNSAFE";
  return error;
}

function containedRelative(rootPath, candidatePath){
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertDirectoryNoLink(directoryPath, label, fileSystem = fs){
  const stat = fileSystem.lstatSync(directoryPath);
  if(stat.isSymbolicLink() || !stat.isDirectory()){
    throw unsafe(label + " must be a real directory");
  }
  return path.resolve(directoryPath);
}

function ensureDirectoryNoLink(directoryPath, label, fileSystem = fs){
  const resolved = path.resolve(directoryPath);
  if(!fileSystem.existsSync(resolved)) fileSystem.mkdirSync(resolved, { recursive: false });
  return assertDirectoryNoLink(resolved, label, fileSystem);
}

function inspectExistingPathComponents(rootPath, candidatePath, label, fileSystem = fs){
  assertDirectoryNoLink(rootPath, label + " root", fileSystem);
  const relative = path.relative(rootPath, candidatePath);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = rootPath;
  for(let index = 0; index < segments.length; index += 1){
    current = path.join(current, segments[index]);
    if(!fileSystem.existsSync(current)) return;
    const stat = fileSystem.lstatSync(current);
    if(stat.isSymbolicLink()) throw unsafe(label + " path contains a symbolic link or junction");
    const leaf = index === segments.length - 1;
    if(!leaf && !stat.isDirectory()) throw unsafe(label + " parent must be a directory");
    if(leaf && !stat.isFile()) throw unsafe(label + " must resolve to a regular file");
  }
}

function resolveOwnedRelativeFile({
  jobRoot,
  ownedRoot,
  relativePath,
  label = "Stored file",
  mustExist = false,
  fileSystem = fs,
} = {}){
  if(typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)){
    throw unsafe(label + " relativePath is invalid");
  }
  const resolvedJobRoot = path.resolve(jobRoot);
  const resolvedOwnedRoot = path.resolve(ownedRoot);
  if(!containedRelative(resolvedJobRoot, resolvedOwnedRoot)){
    throw unsafe(label + " owned root is outside the Current Job");
  }
  const resolvedPath = path.resolve(resolvedJobRoot, relativePath);
  if(!containedRelative(resolvedOwnedRoot, resolvedPath)){
    throw unsafe(label + " relativePath escapes its owned root");
  }

  assertDirectoryNoLink(resolvedJobRoot, "Current Job", fileSystem);
  assertDirectoryNoLink(resolvedOwnedRoot, label + " owned root", fileSystem);
  inspectExistingPathComponents(resolvedOwnedRoot, resolvedPath, label, fileSystem);

  if(mustExist && !fileSystem.existsSync(resolvedPath)) throw unsafe(label + " does not exist");
  if(fileSystem.existsSync(resolvedPath)){
    const realOwnedRoot = fileSystem.realpathSync.native(resolvedOwnedRoot);
    const realPath = fileSystem.realpathSync.native(resolvedPath);
    if(!containedRelative(realOwnedRoot, realPath)){
      throw unsafe(label + " resolves outside its owned root");
    }
  }
  return resolvedPath;
}

module.exports = { assertDirectoryNoLink, ensureDirectoryNoLink, resolveOwnedRelativeFile };
