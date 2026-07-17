"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  inspectVideoCandidate,
  prepareVideoCandidate,
  discardPreparedVideoCandidate,
  commitPreparedVideo,
  recoverVideoTransactions,
} = require("../video-lifecycle.cjs");

const TEMP_PREFIX = "workflow-video-lifecycle-";
const PROJECT_CURRENT_JOB = path.resolve(__dirname, "..", "current-job");
const VIDEO_LIMIT = 64 * 1024 * 1024;
const OLD_VIDEO = Buffer.from("OLD_VIDEO_MP4\n");
const NEW_VIDEO = Buffer.from("NEW_VIDEO_MP4\n");

function samePath(left, right){
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(parentPath, candidatePath){
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertOutsideRealCurrentJob(candidatePath){
  assert.ok(
    !samePath(PROJECT_CURRENT_JOB, candidatePath) && !isInside(PROJECT_CURRENT_JOB, candidatePath),
    "test path entered the real current-job",
  );
}

function installCurrentJobAccessGuard(){
  const pathArguments = {
    lstatSync: [0],
    statSync: [0],
    existsSync: [0],
    readdirSync: [0],
    mkdirSync: [0],
    readFileSync: [0],
    writeFileSync: [0],
    openSync: [0],
    copyFileSync: [0, 1],
    renameSync: [0, 1],
    unlinkSync: [0],
    rmdirSync: [0],
    rmSync: [0],
    symlinkSync: [0, 1],
  };
  const originals = new Map();
  let blockedAccesses = 0;
  for(const [method, indexes] of Object.entries(pathArguments)){
    const original = fs[method];
    if(typeof original !== "function") continue;
    originals.set(method, original);
    fs[method] = function(...args){
      for(const index of indexes){
        const candidate = args[index];
        if(typeof candidate !== "string") continue;
        if(samePath(PROJECT_CURRENT_JOB, candidate) || isInside(PROJECT_CURRENT_JOB, candidate)){
          blockedAccesses += 1;
          throw new Error("Test attempted to access the real current-job");
        }
      }
      return original.apply(this, args);
    };
  }
  return {
    blockedAccesses: () => blockedAccesses,
    restore(){
      for(const [method, original] of originals) fs[method] = original;
    },
  };
}

function writeFile(filePath, content){
  assertOutsideRealCurrentJob(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createLayout(root, label){
  const jobRoot = path.join(root, label);
  const sourceRoot = path.join(jobRoot, "source");
  const outputRoot = path.join(root, label + "-output");
  const logRoot = path.join(jobRoot, "logs");
  const jobPath = path.join(jobRoot, "job.json");
  for(const candidate of [jobRoot, sourceRoot, outputRoot, logRoot, jobPath]){
    assertOutsideRealCurrentJob(candidate);
  }
  for(const directory of [sourceRoot, outputRoot, logRoot]){
    fs.mkdirSync(directory, { recursive: true });
  }
  writeFile(path.join(sourceRoot, ".gitkeep"), "");
  writeFile(path.join(sourceRoot, "timeline.xml"), "TIMELINE_SENTINEL\n");
  writeFile(path.join(sourceRoot, "video.mp4"), OLD_VIDEO);
  writeFile(path.join(sourceRoot, "keep-source.txt"), "SOURCE_SENTINEL\n");
  writeFile(path.join(outputRoot, "preserve.mp4"), "OUTPUT_SENTINEL");
  writeFile(path.join(logRoot, ".gitkeep"), "");
  writeFile(path.join(logRoot, "app.log"), "LOG_SENTINEL\n");
  const oldJob = {
    version: 1,
    jobId: "job-" + label,
    xml: { name: "timeline.xml", relativePath: "source/timeline.xml" },
    video: { name: "old-video.mp4", relativePath: "source/video.mp4" },
    references: [],
    globalReferenceIds: [],
    shotMappings: {},
    projectTitle: "VIDEO LIFECYCLE TEST",
    callout: { enabled: true },
    ui: { panelOpen: true },
    output: { codec: "h264", bitrateMbps: 12, fps: 60 },
  };
  writeFile(jobPath, JSON.stringify(oldJob, null, 2) + "\n");
  return { jobRoot, sourceRoot, outputRoot, logRoot, jobPath, oldJob };
}

function nextJobFor(layout, inputName = "new-video.mp4"){
  const next = JSON.parse(JSON.stringify(layout.oldJob));
  next.video = { name: inputName, relativePath: "source/video.mp4" };
  return next;
}

function transactionNames(logRoot){
  return fs.readdirSync(logRoot).filter(name => name.startsWith(".video-import-"));
}

function writeManifest(preparation, manifest){
  fs.writeFileSync(preparation.manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

function sha256(text){
  return crypto.createHash("sha256").update(text).digest("hex");
}

function assertPreservedSentinels(layout){
  assert.equal(fs.readFileSync(path.join(layout.sourceRoot, "timeline.xml"), "utf8"), "TIMELINE_SENTINEL\n");
  assert.equal(fs.readFileSync(path.join(layout.sourceRoot, "keep-source.txt"), "utf8"), "SOURCE_SENTINEL\n");
  assert.equal(fs.readFileSync(path.join(layout.outputRoot, "preserve.mp4"), "utf8"), "OUTPUT_SENTINEL");
  assert.equal(fs.readFileSync(path.join(layout.logRoot, "app.log"), "utf8"), "LOG_SENTINEL\n");
}

function assertManifestHasNoAbsoluteInput(preparation, inputPath){
  const manifest = JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8"));
  assert.equal(manifest.input.name, path.basename(inputPath));
  assert.equal(Object.hasOwn(manifest.input, "absolutePath"), false);
  const strings = [];
  (function collect(value){
    if(typeof value === "string") strings.push(value);
    else if(Array.isArray(value)) value.forEach(collect);
    else if(value && typeof value === "object") Object.values(value).forEach(collect);
  })(manifest);
  assert.equal(strings.some(value => path.isAbsolute(value) || /^file:/i.test(value)), false);
}

function prepareInput(root, layout, label, content = NEW_VIDEO){
  const inputPath = path.join(root, "inputs", label + ".mp4");
  writeFile(inputPath, content);
  const preparation = prepareVideoCandidate({
    sourcePath: inputPath,
    logRoot: layout.logRoot,
    inputMethod: "test-drop",
    allowedExtensions: ["mp4", "mov", "m4v"],
    maxBytes: VIDEO_LIMIT,
  });
  assert.equal(path.dirname(preparation.transactionRoot), path.resolve(layout.logRoot));
  assert.equal(path.basename(preparation.candidatePath), "candidate.mp4");
  assertManifestHasNoAbsoluteInput(preparation, inputPath);
  return { inputPath, preparation };
}

function runInvalidInputChecks(root){
  const invalidPath = path.join(root, "inputs", "invalid.txt");
  const emptyPath = path.join(root, "inputs", "empty.mp4");
  const logRoot = path.join(root, "invalid-logs");
  writeFile(invalidPath, NEW_VIDEO);
  writeFile(emptyPath, Buffer.alloc(0));
  fs.mkdirSync(logRoot, { recursive: true });
  assert.throws(
    () => inspectVideoCandidate({ sourcePath: invalidPath, allowedExtensions: [".mp4"], maxBytes: VIDEO_LIMIT }),
    /extension is not allowed/i,
  );
  assert.throws(
    () => inspectVideoCandidate({ sourcePath: emptyPath, allowedExtensions: [".mp4"], maxBytes: VIDEO_LIMIT }),
    /file is empty/i,
  );
  assert.throws(
    () => prepareVideoCandidate({
      sourcePath: emptyPath,
      logRoot,
      inputMethod: "empty-test",
      allowedExtensions: [".mp4"],
      maxBytes: VIDEO_LIMIT,
    }),
    /file is empty/i,
  );
  assert.deepEqual(transactionNames(logRoot), []);

  const validPath = path.join(root, "inputs", "symlink-target.mp4");
  const linkPath = path.join(root, "inputs", "symlink-input.mp4");
  writeFile(validPath, NEW_VIDEO);
  try{
    fs.symlinkSync(validPath, linkPath, "file");
    assert.throws(
      () => inspectVideoCandidate({ sourcePath: linkPath, allowedExtensions: [".mp4"], maxBytes: VIDEO_LIMIT }),
      /regular file/i,
    );
  }catch(error){
    if(!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
  }
}

function runDiscardCheck(root){
  const layout = createLayout(root, "discard");
  const { preparation } = prepareInput(root, layout, "discard-video");
  assert.equal(discardPreparedVideoCandidate(preparation), true);
  assert.equal(discardPreparedVideoCandidate(preparation), false);
  assert.deepEqual(transactionNames(layout.logRoot), []);
  assert.deepEqual(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4")), OLD_VIDEO);
  assertPreservedSentinels(layout);
}

function runSuccessCheck(root){
  const layout = createLayout(root, "success");
  const { inputPath, preparation } = prepareInput(root, layout, "success-video");
  const inspected = inspectVideoCandidate({
    sourcePath: inputPath,
    allowedExtensions: [".mp4"],
    maxBytes: VIDEO_LIMIT,
  });
  assert.equal(inspected.size, NEW_VIDEO.length);

  const events = [];
  const nextJob = nextJobFor(layout, path.basename(inputPath));
  const committed = commitPreparedVideo({
    preparation,
    sourceRoot: layout.sourceRoot,
    jobPath: layout.jobPath,
    nextJob,
    onEvent: (event, detail) => events.push({ event, detail }),
  });

  assert.deepEqual(committed.job, nextJob);
  assert.equal(committed.installedName, "video.mp4");
  assert.equal(committed.replacedVideoCount, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(layout.jobPath, "utf8")), nextJob);
  assert.deepEqual(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4")), NEW_VIDEO);
  assert.deepEqual(fs.readdirSync(layout.sourceRoot).sort(), [".gitkeep", "keep-source.txt", "timeline.xml", "video.mp4"]);
  assertPreservedSentinels(layout);
  assert.deepEqual(transactionNames(layout.logRoot), []);
  assert.ok(events.some(item => item.event === "job_video_commit_started"));
  assert.ok(events.some(item => item.event === "job_video_commit_committed"));
}

function runPersistentManifestEpermCheck(root){
  const layout = createLayout(root, "manifest-eperm");
  const { preparation } = prepareInput(root, layout, "manifest-eperm-video");
  const originalRename = fs.renameSync;
  let renameAttempts = 0;
  fs.renameSync = function(sourcePath, destinationPath){
    if(path.basename(String(sourcePath)) === "manifest.json.tmp" &&
        path.basename(String(destinationPath)) === "manifest.json"){
      renameAttempts += 1;
      const error = new Error("forced persistent manifest rename denial");
      error.code = "EPERM";
      throw error;
    }
    return originalRename.apply(this, arguments);
  };
  try{
    const nextJob = nextJobFor(layout, "manifest-eperm-video.mp4");
    const committed = commitPreparedVideo({
      preparation,
      sourceRoot: layout.sourceRoot,
      jobPath: layout.jobPath,
      nextJob,
    });
    assert.deepEqual(committed.job, nextJob);
  }finally{
    fs.renameSync = originalRename;
  }
  assert.ok(renameAttempts >= 4, "manifest rename was not retried before verified-copy fallback");
  assert.deepEqual(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4")), NEW_VIDEO);
  assertPreservedSentinels(layout);
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runLockedStaleManifestTempCheck(root){
  const layout = createLayout(root, "locked-stale-manifest");
  const { preparation } = prepareInput(root, layout, "locked-stale-manifest-video");
  const staleTemporaryPath = preparation.manifestPath + ".tmp";
  fs.copyFileSync(preparation.manifestPath, staleTemporaryPath);
  const originalUnlink = fs.unlinkSync;
  let unlinkAttempts = 0;
  fs.unlinkSync = function(candidatePath){
    if(samePath(String(candidatePath), staleTemporaryPath)){
      unlinkAttempts += 1;
      const error = new Error("forced locked stale video manifest staging file");
      error.code = "EPERM";
      throw error;
    }
    return originalUnlink.apply(this, arguments);
  };
  let committed;
  let deferredRecovery;
  try{
    committed = commitPreparedVideo({
      preparation,
      sourceRoot: layout.sourceRoot,
      jobPath: layout.jobPath,
      nextJob: nextJobFor(layout, "locked-stale-manifest-video.mp4"),
    });
    deferredRecovery = recoverVideoTransactions({
      logRoot: layout.logRoot,
      sourceRoot: layout.sourceRoot,
      jobPath: layout.jobPath,
    });
  }finally{
    fs.unlinkSync = originalUnlink;
  }
  assert.ok(unlinkAttempts >= 4, "locked stale video manifest staging file was not retried");
  assert.equal(committed.cleanupDeferred, true);
  assert.equal(deferredRecovery.deferred, 1);
  assert.equal(deferredRecovery.failed, 0);
  assert.equal(transactionNames(layout.logRoot).length, 1);

  const recovery = recoverVideoTransactions({
    logRoot: layout.logRoot,
    sourceRoot: layout.sourceRoot,
    jobPath: layout.jobPath,
  });
  assert.equal(recovery.cleaned, 1);
  assert.equal(recovery.deferred, 0);
  assert.equal(recovery.failed, 0);
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runFallbackAuthorityCleanupInterruptionCheck(root){
  const layout = createLayout(root, "fallback-authority-cleanup");
  const { preparation } = prepareInput(root, layout, "fallback-authority-cleanup-video");
  const uniqueTemporaryPath = preparation.manifestPath + ".tmp-" + require("node:crypto").randomUUID();
  fs.copyFileSync(preparation.manifestPath, uniqueTemporaryPath);
  fs.writeFileSync(preparation.manifestPath, "{BROKEN PRIMARY\n");

  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = function(candidatePath){
    if(samePath(String(candidatePath), preparation.candidatePath)){
      const error = new Error("forced video candidate cleanup lock");
      error.code = "EPERM";
      throw error;
    }
    return originalUnlink.apply(this, arguments);
  };
  let firstRecovery;
  try{
    firstRecovery = recoverVideoTransactions({
      logRoot: layout.logRoot,
      sourceRoot: layout.sourceRoot,
      jobPath: layout.jobPath,
    });
  }finally{
    fs.unlinkSync = originalUnlink;
  }
  assert.equal(firstRecovery.deferred, 1);
  assert.equal(firstRecovery.failed, 0);
  assert.equal(JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8")).state, "prepared");
  assert.ok(fs.existsSync(preparation.candidatePath));

  const secondRecovery = recoverVideoTransactions({
    logRoot: layout.logRoot,
    sourceRoot: layout.sourceRoot,
    jobPath: layout.jobPath,
  });
  assert.equal(secondRecovery.cleaned, 1);
  assert.equal(secondRecovery.failed, 0);
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runManifestReadFallbackChecks(root){
  const fallbackLayout = createLayout(root, "manifest-fallback");
  const { preparation: fallbackPreparation } = prepareInput(root, fallbackLayout, "manifest-fallback-video");
  const temporaryManifestPath = fallbackPreparation.manifestPath + ".tmp";
  fs.copyFileSync(fallbackPreparation.manifestPath, temporaryManifestPath);
  fs.writeFileSync(fallbackPreparation.manifestPath, "{BROKEN PRIMARY\n");
  assert.equal(discardPreparedVideoCandidate(fallbackPreparation), true);
  assert.deepEqual(transactionNames(fallbackLayout.logRoot), []);

  const primaryLayout = createLayout(root, "manifest-primary-first");
  const { preparation: primaryPreparation } = prepareInput(root, primaryLayout, "manifest-primary-first-video");
  const staleTemporary = JSON.parse(fs.readFileSync(primaryPreparation.manifestPath, "utf8"));
  staleTemporary.state = "rolling_back";
  staleTemporary.phase = "rolling_back";
  staleTemporary.moved = { sourceVideos: ["video.mp4"] };
  fs.writeFileSync(
    primaryPreparation.manifestPath + ".tmp",
    JSON.stringify(staleTemporary, null, 2) + "\n",
  );
  assert.equal(discardPreparedVideoCandidate(primaryPreparation), true);
  assert.deepEqual(transactionNames(primaryLayout.logRoot), []);
}

function runPersistentJobInstallEpermCheck(root){
  const layout = createLayout(root, "job-install-eperm");
  const { preparation } = prepareInput(root, layout, "job-install-eperm-video");
  const nextJob = nextJobFor(layout, "job-install-eperm-video.mp4");
  const originalRename = fs.renameSync;
  let renameAttempts = 0;
  fs.renameSync = function(sourcePath, destinationPath){
    if(path.basename(String(sourcePath)) === "next-job.json" && samePath(destinationPath, layout.jobPath)){
      renameAttempts += 1;
      const error = new Error("forced persistent Job install rename denial");
      error.code = "EPERM";
      throw error;
    }
    return originalRename.apply(this, arguments);
  };
  try{
    const committed = commitPreparedVideo({
      preparation,
      sourceRoot: layout.sourceRoot,
      jobPath: layout.jobPath,
      nextJob,
    });
    assert.deepEqual(committed.job, nextJob);
  }finally{
    fs.renameSync = originalRename;
  }
  assert.ok(renameAttempts >= 4, "Job install rename was not retried before verified-copy fallback");
  assert.deepEqual(JSON.parse(fs.readFileSync(layout.jobPath, "utf8")), nextJob);
  assert.deepEqual(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4")), NEW_VIDEO);
  assertPreservedSentinels(layout);
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runCommitFailureRollbackCheck(root){
  const layout = createLayout(root, "commit-failure");
  const { preparation } = prepareInput(root, layout, "rollback-video");
  const oldJobText = fs.readFileSync(layout.jobPath, "utf8");
  const originalRename = fs.renameSync;
  fs.renameSync = function(sourcePath, destinationPath){
    if(path.basename(String(sourcePath)) === "next-job.json" && samePath(destinationPath, layout.jobPath)){
      const error = new Error("forced video Job install failure");
      error.code = "TEST_COMMIT_FAILURE";
      throw error;
    }
    return originalRename.apply(this, arguments);
  };
  try{
    assert.throws(
      () => commitPreparedVideo({
        preparation,
        sourceRoot: layout.sourceRoot,
        jobPath: layout.jobPath,
        nextJob: nextJobFor(layout, "rollback-video.mp4"),
      }),
      /forced video Job install failure/i,
    );
  }finally{
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(layout.jobPath, "utf8"), oldJobText);
  assert.deepEqual(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4")), OLD_VIDEO);
  assertPreservedSentinels(layout);
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runRecoveryCheck(root){
  const layout = createLayout(root, "recovery");
  const { preparation } = prepareInput(root, layout, "recovery-video");
  const manifest = JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8"));
  const backupRoot = path.join(preparation.transactionRoot, "backup");
  const sourceBackupRoot = path.join(backupRoot, "source");
  fs.mkdirSync(sourceBackupRoot, { recursive: true });
  fs.copyFileSync(layout.jobPath, path.join(backupRoot, "job.json"));
  fs.renameSync(path.join(layout.sourceRoot, "video.mp4"), path.join(sourceBackupRoot, "video.mp4"));
  fs.renameSync(preparation.candidatePath, path.join(layout.sourceRoot, "video.mp4"));
  const interruptedJob = nextJobFor(layout, "recovery-video.mp4");
  const interruptedJobText = JSON.stringify(interruptedJob, null, 2) + "\n";
  writeFile(layout.jobPath, interruptedJobText);
  manifest.state = "committing";
  manifest.phase = "installing_job";
  manifest.hadJob = true;
  manifest.nextJobSha256 = sha256(interruptedJobText);
  manifest.installedName = "video.mp4";
  manifest.moved = { sourceVideos: ["video.mp4"] };
  writeManifest(preparation, manifest);

  const events = [];
  const recovery = recoverVideoTransactions({
    logRoot: layout.logRoot,
    sourceRoot: layout.sourceRoot,
    jobPath: layout.jobPath,
    onEvent: (event, detail) => events.push({ event, detail }),
  });

  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.failed, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(layout.jobPath, "utf8")), layout.oldJob);
  assert.deepEqual(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4")), OLD_VIDEO);
  assertPreservedSentinels(layout);
  assert.deepEqual(transactionNames(layout.logRoot), []);
  assert.ok(events.some(item => item.event === "job_video_recovery_rolled_back"));
}

function runRollbackCleanupInterruptionCheck(root){
  const layout = createLayout(root, "rollback-cleanup-interruption");
  const { preparation } = prepareInput(root, layout, "rollback-cleanup-interruption-video");
  const manifest = JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8"));
  const backupRoot = path.join(preparation.transactionRoot, "backup");
  const sourceBackupRoot = path.join(backupRoot, "source");
  fs.mkdirSync(sourceBackupRoot, { recursive: true });
  fs.copyFileSync(layout.jobPath, path.join(backupRoot, "job.json"));
  fs.renameSync(path.join(layout.sourceRoot, "video.mp4"), path.join(sourceBackupRoot, "video.mp4"));
  fs.renameSync(preparation.candidatePath, path.join(layout.sourceRoot, "video.mp4"));
  const interruptedJob = nextJobFor(layout, "rollback-cleanup-interruption-video.mp4");
  const interruptedJobText = JSON.stringify(interruptedJob, null, 2) + "\n";
  writeFile(layout.jobPath, interruptedJobText);
  manifest.state = "committing";
  manifest.phase = "installing_job";
  manifest.hadJob = true;
  manifest.nextJobSha256 = sha256(interruptedJobText);
  manifest.installedName = "video.mp4";
  manifest.moved = { sourceVideos: ["video.mp4"] };
  writeManifest(preparation, manifest);

  const originalRmdir = fs.rmdirSync;
  fs.rmdirSync = function(candidatePath){
    if(samePath(String(candidatePath), backupRoot)){
      const error = new Error("forced video backup cleanup lock");
      error.code = "EPERM";
      throw error;
    }
    return originalRmdir.apply(this, arguments);
  };
  let firstRecovery;
  try{
    firstRecovery = recoverVideoTransactions({
      logRoot: layout.logRoot,
      sourceRoot: layout.sourceRoot,
      jobPath: layout.jobPath,
    });
  }finally{
    fs.rmdirSync = originalRmdir;
  }
  assert.equal(firstRecovery.recovered, 1);
  assert.equal(firstRecovery.deferred, 1);
  assert.equal(firstRecovery.failed, 0);
  assert.equal(JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8")).state, "rolled_back");
  assert.deepEqual(JSON.parse(fs.readFileSync(layout.jobPath, "utf8")), layout.oldJob);
  assert.deepEqual(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4")), OLD_VIDEO);

  const secondRecovery = recoverVideoTransactions({
    logRoot: layout.logRoot,
    sourceRoot: layout.sourceRoot,
    jobPath: layout.jobPath,
  });
  assert.equal(secondRecovery.cleaned, 1);
  assert.equal(secondRecovery.failed, 0);
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runEmptyPreviousVideoRollbackCheck(root){
  const layout = createLayout(root, "empty-previous-video");
  fs.unlinkSync(path.join(layout.sourceRoot, "video.mp4"));
  const { preparation } = prepareInput(root, layout, "empty-previous-video-candidate");
  const manifest = JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8"));
  const backupRoot = path.join(preparation.transactionRoot, "backup");
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.copyFileSync(layout.jobPath, path.join(backupRoot, "job.json"));
  fs.renameSync(preparation.candidatePath, path.join(layout.sourceRoot, "video.mp4"));
  manifest.state = "committing";
  manifest.phase = "installing_job";
  manifest.hadJob = true;
  manifest.installedName = "video.mp4";
  manifest.moved = { sourceVideos: [] };
  writeManifest(preparation, manifest);

  const recovery = recoverVideoTransactions({
    logRoot: layout.logRoot,
    sourceRoot: layout.sourceRoot,
    jobPath: layout.jobPath,
  });
  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.failed, 0);
  assert.equal(fs.existsSync(path.join(layout.sourceRoot, "video.mp4")), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(layout.jobPath, "utf8")), layout.oldJob);
  assertPreservedSentinels(layout);
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runRollbackMarkerWriteFailureRetryCheck(root){
  const layout = createLayout(root, "rollback-marker-write-failure");
  const { preparation } = prepareInput(root, layout, "rollback-marker-write-failure-video");
  const manifest = JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8"));
  const backupRoot = path.join(preparation.transactionRoot, "backup");
  const sourceBackupRoot = path.join(backupRoot, "source");
  fs.mkdirSync(sourceBackupRoot, { recursive: true });
  fs.copyFileSync(layout.jobPath, path.join(backupRoot, "job.json"));
  fs.renameSync(path.join(layout.sourceRoot, "video.mp4"), path.join(sourceBackupRoot, "video.mp4"));
  fs.renameSync(preparation.candidatePath, path.join(layout.sourceRoot, "video.mp4"));
  const interruptedJob = nextJobFor(layout, "rollback-marker-write-failure-video.mp4");
  const interruptedJobText = JSON.stringify(interruptedJob, null, 2) + "\n";
  writeFile(layout.jobPath, interruptedJobText);
  manifest.state = "committing";
  manifest.phase = "installing_job";
  manifest.hadJob = true;
  manifest.nextJobSha256 = sha256(interruptedJobText);
  manifest.installedName = "video.mp4";
  manifest.moved = { sourceVideos: ["video.mp4"] };
  writeManifest(preparation, manifest);

  const originalOpen = fs.openSync;
  let markerOpenAttempts = 0;
  fs.openSync = function(candidatePath, flags){
    if(path.basename(String(candidatePath)).startsWith("rollback-complete.json.tmp-") && flags === "wx"){
      markerOpenAttempts += 1;
      const error = new Error("forced video rollback marker staging denial");
      error.code = "EPERM";
      throw error;
    }
    return originalOpen.apply(this, arguments);
  };
  let firstRecovery;
  try{
    firstRecovery = recoverVideoTransactions({
      logRoot: layout.logRoot,
      sourceRoot: layout.sourceRoot,
      jobPath: layout.jobPath,
    });
  }finally{
    fs.openSync = originalOpen;
  }
  assert.ok(markerOpenAttempts >= 4, "video rollback marker staging was not retried");
  assert.equal(firstRecovery.failed, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(layout.jobPath, "utf8")), layout.oldJob);
  assert.deepEqual(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4")), OLD_VIDEO);
  writeFile(path.join(preparation.transactionRoot, "rollback-complete.json"), "{BROKEN MARKER\n");

  const secondRecovery = recoverVideoTransactions({
    logRoot: layout.logRoot,
    sourceRoot: layout.sourceRoot,
    jobPath: layout.jobPath,
  });
  assert.equal(secondRecovery.recovered, 1);
  assert.equal(secondRecovery.failed, 0);
  assert.deepEqual(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4")), OLD_VIDEO);
  assertPreservedSentinels(layout);
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runPersistentJobRestoreEpermCheck(root){
  const layout = createLayout(root, "job-restore-eperm");
  const { preparation } = prepareInput(root, layout, "job-restore-eperm-video");
  const manifest = JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8"));
  const backupRoot = path.join(preparation.transactionRoot, "backup");
  const sourceBackupRoot = path.join(backupRoot, "source");
  fs.mkdirSync(sourceBackupRoot, { recursive: true });
  fs.copyFileSync(layout.jobPath, path.join(backupRoot, "job.json"));
  fs.renameSync(path.join(layout.sourceRoot, "video.mp4"), path.join(sourceBackupRoot, "video.mp4"));
  fs.renameSync(preparation.candidatePath, path.join(layout.sourceRoot, "video.mp4"));
  const interruptedJob = nextJobFor(layout, "job-restore-eperm-video.mp4");
  const interruptedJobText = JSON.stringify(interruptedJob, null, 2) + "\n";
  writeFile(layout.jobPath, interruptedJobText);
  manifest.state = "committing";
  manifest.phase = "installing_job";
  manifest.hadJob = true;
  manifest.nextJobSha256 = sha256(interruptedJobText);
  manifest.installedName = "video.mp4";
  manifest.moved = { sourceVideos: ["video.mp4"] };
  writeManifest(preparation, manifest);

  const originalRename = fs.renameSync;
  let renameAttempts = 0;
  fs.renameSync = function(sourcePath, destinationPath){
    if(path.basename(String(sourcePath)) === "restore-job.json" && samePath(destinationPath, layout.jobPath)){
      renameAttempts += 1;
      const error = new Error("forced persistent Job restore rename denial");
      error.code = "EPERM";
      throw error;
    }
    return originalRename.apply(this, arguments);
  };
  let recovery;
  try{
    recovery = recoverVideoTransactions({
      logRoot: layout.logRoot,
      sourceRoot: layout.sourceRoot,
      jobPath: layout.jobPath,
    });
  }finally{
    fs.renameSync = originalRename;
  }

  assert.ok(renameAttempts >= 4, "Job restore rename was not retried before verified-copy fallback");
  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.failed, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(layout.jobPath, "utf8")), layout.oldJob);
  assert.deepEqual(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4")), OLD_VIDEO);
  assertPreservedSentinels(layout);
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runIdenticalJobRestoreSkipsReplaceCheck(root){
  const layout = createLayout(root, "job-restore-identical");
  const { preparation } = prepareInput(root, layout, "job-restore-identical-video");
  const manifest = JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8"));
  const backupRoot = path.join(preparation.transactionRoot, "backup");
  const sourceBackupRoot = path.join(backupRoot, "source");
  fs.mkdirSync(sourceBackupRoot, { recursive: true });
  fs.copyFileSync(layout.jobPath, path.join(backupRoot, "job.json"));
  fs.renameSync(path.join(layout.sourceRoot, "video.mp4"), path.join(sourceBackupRoot, "video.mp4"));
  fs.renameSync(preparation.candidatePath, path.join(layout.sourceRoot, "video.mp4"));
  const nextJobText = JSON.stringify(nextJobFor(layout, "job-restore-identical-video.mp4"), null, 2) + "\n";
  manifest.state = "committing";
  manifest.phase = "installing_job";
  manifest.hadJob = true;
  manifest.nextJobSha256 = sha256(nextJobText);
  manifest.installedName = "video.mp4";
  manifest.moved = { sourceVideos: ["video.mp4"] };
  writeManifest(preparation, manifest);

  const originalRename = fs.renameSync;
  let jobRenameAttempts = 0;
  fs.renameSync = function(sourcePath, destinationPath){
    if(path.basename(String(sourcePath)) === "restore-job.json" && samePath(destinationPath, layout.jobPath)){
      jobRenameAttempts += 1;
      const error = new Error("identical Job should not be renamed");
      error.code = "TEST_IDENTICAL_RENAME";
      throw error;
    }
    return originalRename.apply(this, arguments);
  };
  let recovery;
  try{
    recovery = recoverVideoTransactions({
      logRoot: layout.logRoot,
      sourceRoot: layout.sourceRoot,
      jobPath: layout.jobPath,
    });
  }finally{
    fs.renameSync = originalRename;
  }

  assert.equal(jobRenameAttempts, 0, "identical Job content should bypass replacement");
  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.failed, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(layout.jobPath, "utf8")), layout.oldJob);
  assert.deepEqual(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4")), OLD_VIDEO);
  assertPreservedSentinels(layout);
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runMissingJobBackupRecoveryCheck(root){
  const layout = createLayout(root, "missing-job-backup");
  const { preparation } = prepareInput(root, layout, "missing-job-backup-video");
  const manifest = JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8"));
  const backupRoot = path.join(preparation.transactionRoot, "backup");
  const sourceBackupRoot = path.join(backupRoot, "source");
  fs.mkdirSync(sourceBackupRoot, { recursive: true });
  fs.renameSync(path.join(layout.sourceRoot, "video.mp4"), path.join(sourceBackupRoot, "video.mp4"));
  fs.renameSync(preparation.candidatePath, path.join(layout.sourceRoot, "video.mp4"));
  const interruptedJob = nextJobFor(layout, "missing-job-backup-video.mp4");
  const interruptedJobText = JSON.stringify(interruptedJob, null, 2) + "\n";
  writeFile(layout.jobPath, interruptedJobText);
  manifest.state = "committing";
  manifest.phase = "installing_job";
  manifest.hadJob = true;
  manifest.nextJobSha256 = sha256(interruptedJobText);
  manifest.installedName = "video.mp4";
  manifest.moved = { sourceVideos: ["video.mp4"] };
  writeManifest(preparation, manifest);

  const recovery = recoverVideoTransactions({
    logRoot: layout.logRoot,
    sourceRoot: layout.sourceRoot,
    jobPath: layout.jobPath,
  });

  assert.equal(recovery.recovered, 0);
  assert.equal(recovery.failed, 1);
  assert.match(recovery.failures[0].code, /RECOVERY_FAILED/);
  assert.equal(fs.readFileSync(layout.jobPath, "utf8"), interruptedJobText);
  assert.deepEqual(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4")), NEW_VIDEO);
  assert.deepEqual(fs.readFileSync(path.join(sourceBackupRoot, "video.mp4")), OLD_VIDEO);
  assertPreservedSentinels(layout);
  assert.equal(transactionNames(layout.logRoot).length, 1);
}

function runEarlyCommittingRecoveryCheck(root){
  const layout = createLayout(root, "early-recovery");
  const { preparation } = prepareInput(root, layout, "early-recovery-video");
  const oldJobText = fs.readFileSync(layout.jobPath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8"));
  const nextJobText = JSON.stringify(nextJobFor(layout, "early-recovery-video.mp4"), null, 2) + "\n";
  const backupRoot = path.join(preparation.transactionRoot, "backup");
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.copyFileSync(layout.jobPath, path.join(backupRoot, "job.json.partial"));
  writeFile(path.join(backupRoot, "job.json"), "{\"old\":");
  manifest.state = "committing";
  manifest.phase = "backing_up_job";
  manifest.hadJob = null;
  manifest.nextJobSha256 = sha256(nextJobText);
  writeManifest(preparation, manifest);

  const recovery = recoverVideoTransactions({
    logRoot: layout.logRoot,
    sourceRoot: layout.sourceRoot,
    jobPath: layout.jobPath,
  });

  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.failed, 0);
  assert.equal(fs.readFileSync(layout.jobPath, "utf8"), oldJobText);
  assert.deepEqual(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4")), OLD_VIDEO);
  assertPreservedSentinels(layout);
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runOrphanCleanupChecks(root){
  const preparedLayout = createLayout(root, "prepared-orphan");
  prepareInput(root, preparedLayout, "prepared-orphan-video");
  const preparedRecovery = recoverVideoTransactions({
    logRoot: preparedLayout.logRoot,
    sourceRoot: preparedLayout.sourceRoot,
    jobPath: preparedLayout.jobPath,
  });
  assert.equal(preparedRecovery.cleaned, 1);
  assert.equal(preparedRecovery.failed, 0);
  assert.deepEqual(transactionNames(preparedLayout.logRoot), []);
  assert.deepEqual(fs.readFileSync(path.join(preparedLayout.sourceRoot, "video.mp4")), OLD_VIDEO);

  const committedLayout = createLayout(root, "committed-orphan");
  const { preparation } = prepareInput(root, committedLayout, "committed-orphan-video");
  const manifest = JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8"));
  manifest.state = "committed";
  manifest.phase = "committed";
  manifest.committedAt = new Date().toISOString();
  writeManifest(preparation, manifest);
  const committedRecovery = recoverVideoTransactions({
    logRoot: committedLayout.logRoot,
    sourceRoot: committedLayout.sourceRoot,
    jobPath: committedLayout.jobPath,
  });
  assert.equal(committedRecovery.cleaned, 1);
  assert.equal(committedRecovery.failed, 0);
  assert.deepEqual(transactionNames(committedLayout.logRoot), []);
  assert.deepEqual(fs.readFileSync(path.join(committedLayout.sourceRoot, "video.mp4")), OLD_VIDEO);
}

function safeCleanup(root){
  if(!root || !fs.existsSync(root)) return;
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(root);
  const relative = path.relative(temporaryRoot, resolved);
  if(!relative || relative.startsWith("..") || path.isAbsolute(relative) ||
      !path.basename(resolved).startsWith(TEMP_PREFIX) || samePath(resolved, PROJECT_CURRENT_JOB)){
    throw new Error("Refusing unsafe video lifecycle-check cleanup");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

let temporaryRoot = null;
let accessGuard = null;
try{
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  assertOutsideRealCurrentJob(temporaryRoot);
  accessGuard = installCurrentJobAccessGuard();
  runInvalidInputChecks(temporaryRoot);
  runDiscardCheck(temporaryRoot);
  runSuccessCheck(temporaryRoot);
  runPersistentManifestEpermCheck(temporaryRoot);
  runLockedStaleManifestTempCheck(temporaryRoot);
  runFallbackAuthorityCleanupInterruptionCheck(temporaryRoot);
  runManifestReadFallbackChecks(temporaryRoot);
  runPersistentJobInstallEpermCheck(temporaryRoot);
  runCommitFailureRollbackCheck(temporaryRoot);
  runRecoveryCheck(temporaryRoot);
  runRollbackCleanupInterruptionCheck(temporaryRoot);
  runEmptyPreviousVideoRollbackCheck(temporaryRoot);
  runRollbackMarkerWriteFailureRetryCheck(temporaryRoot);
  runPersistentJobRestoreEpermCheck(temporaryRoot);
  runIdenticalJobRestoreSkipsReplaceCheck(temporaryRoot);
  runMissingJobBackupRecoveryCheck(temporaryRoot);
  runEarlyCommittingRecoveryCheck(temporaryRoot);
  runOrphanCleanupChecks(temporaryRoot);
  assert.equal(accessGuard.blockedAccesses(), 0, "real current-job access was attempted");
  console.log("VIDEO_LIFECYCLE_CHECK_OK");
}finally{
  accessGuard?.restore();
  safeCleanup(temporaryRoot);
}
