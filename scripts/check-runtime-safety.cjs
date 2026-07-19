"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  replaceByRenameWithRetry,
  writeTextAtomically,
} = require("../durable-file.cjs");
const {
  assertDirectoryNoLink,
  resolveOwnedRelativeFile,
} = require("../owned-path.cjs");
const {
  availableExportPaths,
  buildCompositeFilter,
  finalizeCompletedExport,
} = require("../exporter.cjs");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-showcase-runtime-safety-"));

function transientError(){
  const error = new Error("forced Windows lock");
  error.code = "EPERM";
  return error;
}

function cleanup(){
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(temporaryRoot);
  const relative = path.relative(tempRoot, resolved);
  if(!relative || relative.startsWith("..") || path.isAbsolute(relative)){
    throw new Error("Refusing to remove non-temporary safety root");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

try{
  const jobRoot = path.join(temporaryRoot, "current-job");
  const sourceRoot = path.join(jobRoot, "source");
  const referencesRoot = path.join(jobRoot, "references");
  const outputRoot = path.join(temporaryRoot, "output");
  const logsRoot = path.join(jobRoot, "logs");
  for(const directory of [sourceRoot, referencesRoot, outputRoot, logsRoot]){
    fs.mkdirSync(directory, { recursive: true });
  }

  const safeXml = path.join(sourceRoot, "timeline.xml");
  fs.writeFileSync(safeXml, "<xmeml/>", "utf8");
  assert.equal(resolveOwnedRelativeFile({
    jobRoot,
    ownedRoot: sourceRoot,
    relativePath: "source/timeline.xml",
    label: "xml",
    mustExist: true,
  }), safeXml);
  assert.throws(() => resolveOwnedRelativeFile({
    jobRoot,
    ownedRoot: sourceRoot,
    relativePath: "source/../../outside.txt",
    label: "xml",
  }), error => error.code === "STORED_PATH_UNSAFE");

  const outsideRoot = path.join(temporaryRoot, "outside");
  fs.mkdirSync(outsideRoot);
  const sentinel = path.join(outsideRoot, "sentinel.txt");
  fs.writeFileSync(sentinel, "KEEP", "utf8");
  const linkedDirectory = path.join(sourceRoot, "linked");
  fs.symlinkSync(outsideRoot, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => resolveOwnedRelativeFile({
    jobRoot,
    ownedRoot: sourceRoot,
    relativePath: "source/linked/sentinel.txt",
    label: "xml",
    mustExist: true,
  }), error => error.code === "STORED_PATH_UNSAFE");
  assert.equal(fs.readFileSync(sentinel, "utf8"), "KEEP");
  assert.throws(() => assertDirectoryNoLink(linkedDirectory, "Linked output"), error => error.code === "STORED_PATH_UNSAFE");

  const jobPath = path.join(jobRoot, "job.json");
  fs.writeFileSync(jobPath, "OLD", "utf8");
  fs.writeFileSync(jobPath + ".tmp", "LEGACY", "utf8");
  writeTextAtomically(jobPath, "NEW", { label: "Current Job" });
  assert.equal(fs.readFileSync(jobPath, "utf8"), "NEW");
  assert.equal(fs.readFileSync(jobPath + ".tmp", "utf8"), "LEGACY");

  const retryStage = path.join(jobRoot, "retry-stage.txt");
  const retryTarget = path.join(jobRoot, "retry-target.txt");
  fs.writeFileSync(retryStage, "RETRY", "utf8");
  const retryFs = Object.create(fs);
  let retryCalls = 0;
  retryFs.renameSync = (from, to) => {
    retryCalls += 1;
    if(retryCalls < 4) throw transientError();
    return fs.renameSync(from, to);
  };
  replaceByRenameWithRetry(retryStage, retryTarget, { fileSystem: retryFs, wait: () => {} });
  assert.equal(retryCalls, 4);
  assert.equal(fs.readFileSync(retryTarget, "utf8"), "RETRY");

  fs.writeFileSync(jobPath, "STABLE", "utf8");
  const lockedFs = Object.create(fs);
  lockedFs.renameSync = () => { throw transientError(); };
  let deferred = null;
  try{
    writeTextAtomically(jobPath, "PRESERVED NEXT", { label: "Current Job", fileSystem: lockedFs });
  }catch(error){ deferred = error; }
  assert.equal(deferred?.code, "FILE_REPLACE_DEFERRED");
  assert.equal(fs.readFileSync(jobPath, "utf8"), "STABLE");
  assert.ok(deferred.stagedPath && fs.existsSync(deferred.stagedPath));
  assert.equal(fs.readFileSync(deferred.stagedPath, "utf8"), "PRESERVED NEXT");

  const partPath = path.join(outputRoot, "completed.part.mp4");
  const finalPath = path.join(outputRoot, "completed.mp4");
  fs.writeFileSync(partPath, Buffer.from("COMPLETED EXPORT"));
  const originalRename = fs.renameSync;
  let finalizeError = null;
  try{
    fs.renameSync = () => { throw transientError(); };
    finalizeCompletedExport(partPath, finalPath);
  }catch(error){ finalizeError = error; }
  finally{ fs.renameSync = originalRename; }
  assert.equal(finalizeError?.code, "FILE_REPLACE_DEFERRED");
  assert.ok(fs.existsSync(partPath));
  assert.equal(fs.existsSync(finalPath), false);

  const firstPaths = availableExportPaths(outputRoot);
  assert.match(path.basename(firstPaths.outputPath), /^workflow_showcase_export_/);
  fs.writeFileSync(firstPaths.outputPath, "EXISTING", "utf8");
  fs.writeFileSync(firstPaths.temporaryPath, "STALE", "utf8");
  const secondPaths = availableExportPaths(outputRoot);
  assert.notEqual(secondPaths.outputPath, firstPaths.outputPath);
  assert.equal(fs.existsSync(secondPaths.outputPath), false);
  assert.equal(fs.existsSync(secondPaths.temporaryPath), false);

  const compositeFilter = buildCompositeFilter({
    width: 1280,
    height: 1080,
    fps: 60,
    inputPixelFormat: "bgra",
    outputPixelFormat: "yuv420p",
    colorSpace: "bt709",
  }, 3);
  assert.match(compositeFilter, /\[1:v\]setpts=PTS-STARTPTS,scale=1280:720/);
  assert.match(compositeFilter, /pad=1280:1080:\(ow-iw\)\/2:\(720-ih\)\/2:color=0x0d0e10/);
  assert.match(compositeFilter, /fps=60,tpad=stop_mode=clone:stop_duration=3\.000000,trim=duration=3\.000000/);
  assert.match(compositeFilter, /\[base\]\[ui\]overlay=0:0:shortest=1:format=auto:alpha=premultiplied/);
  assert.match(compositeFilter, /format=yuv420p\[vout\]/);
  assert.doesNotMatch(compositeFilter, /out_range=tv/);
  assert.throws(() => buildCompositeFilter({ width: 1920, height: 1080 }, 3), /1280x1080/);

  console.log("RUNTIME_SAFETY_CHECK_OK");
}finally{
  cleanup();
}
