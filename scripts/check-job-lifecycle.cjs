"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  inspectInputFile,
  prepareXmlCandidate,
  commitPreparedXml,
  commitPreparedXmlUpdate,
  recoverXmlTransactions,
} = require("../job-lifecycle.cjs");

const TEMP_PREFIX = "workflow-job-lifecycle-";
const PROJECT_CURRENT_JOB = path.resolve(__dirname, "..", "current-job");
const XML_TEXT = `<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="5"><sequence><name>Synthetic Timeline</name><duration>48</duration><rate><timebase>24</timebase><ntsc>FALSE</ntsc></rate><media><video><track><clipitem id="clip-1"><name>clip-a.mp4</name><start>0</start><end>48</end><in>0</in><out>48</out><enabled>TRUE</enabled></clipitem></track></video></media></sequence></xmeml>
`;

function writeFile(filePath, content){
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
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

function createLayout(root, label){
  const jobRoot = path.join(root, label);
  const sourceRoot = path.join(jobRoot, "source");
  const referencesRoot = path.join(jobRoot, "references");
  const outputRoot = path.join(jobRoot, "output");
  const logRoot = path.join(jobRoot, "logs");
  const jobPath = path.join(jobRoot, "job.json");
  for(const candidate of [jobRoot, sourceRoot, referencesRoot, outputRoot, logRoot, jobPath]){
    assertOutsideRealCurrentJob(candidate);
  }
  for(const directory of [sourceRoot, referencesRoot, outputRoot, logRoot]){
    fs.mkdirSync(directory, { recursive: true });
  }
  writeFile(path.join(sourceRoot, ".gitkeep"), "");
  writeFile(path.join(referencesRoot, ".gitkeep"), "");
  writeFile(path.join(outputRoot, ".gitkeep"), "");
  writeFile(path.join(logRoot, ".gitkeep"), "");
  writeFile(path.join(sourceRoot, "timeline.xml"), "<xmeml><old/></xmeml>\n");
  writeFile(path.join(sourceRoot, "video.mp4"), "OLD_VIDEO");
  writeFile(path.join(referencesRoot, "old-reference.png"), "OLD_REFERENCE");
  writeFile(path.join(outputRoot, "preserve.mp4"), "OUTPUT_SENTINEL");
  writeFile(path.join(logRoot, "app.log"), "LOG_SENTINEL\n");
  const oldJob = {
    version: 1,
    jobId: "old-" + label,
    xml: { name: "old.xml", relativePath: "source/timeline.xml" },
    video: { name: "old.mp4", relativePath: "source/video.mp4" },
    references: [{ id: "old-ref", relativePath: "references/old-reference.png" }],
    globalReferenceIds: ["old-ref"],
    shotMappings: { "1": { mode: "REPLACE", refs: ["old-ref"] } },
    projectTitle: "OLD TITLE",
    callout: { enabled: false },
    ui: { scale: 1.37, panelOpen: true },
    output: { codec: "h264", bitrateMbps: 18, fps: 60 },
  };
  writeFile(jobPath, JSON.stringify(oldJob, null, 2) + "\n");
  return { jobRoot, sourceRoot, referencesRoot, outputRoot, logRoot, jobPath, oldJob };
}

function nextJobFor(layout, id){
  return {
    version: 1,
    jobId: id,
    xml: { name: "synthetic.xml", relativePath: "source/timeline.xml" },
    video: null,
    references: [],
    globalReferenceIds: [],
    shotMappings: {},
    projectTitle: "UNTITLED PROJECT",
    callout: {
      enabled: true,
      position: "left",
      style: "line",
      startSeconds: 0.08,
      durationSeconds: 3.5,
      subtitle: "REFERENCE MAP · EDIT WORKFLOW",
    },
    ui: JSON.parse(JSON.stringify(layout.oldJob.ui)),
    output: JSON.parse(JSON.stringify(layout.oldJob.output)),
  };
}

function nextJobForUpdate(layout, id){
  const nextJob = JSON.parse(JSON.stringify(layout.oldJob));
  nextJob.jobId = id;
  nextJob.xml = { name: "updated.xml", relativePath: "source/timeline.xml" };
  return nextJob;
}

function transactionNames(logRoot){
  return fs.readdirSync(logRoot).filter(name => name.startsWith(".job-import-"));
}

function moveResettableEntries(root, backupRoot){
  fs.mkdirSync(backupRoot, { recursive: true });
  for(const name of fs.readdirSync(root).filter(name => name !== ".gitkeep")){
    fs.renameSync(path.join(root, name), path.join(backupRoot, name));
  }
}

function writeManifest(preparation, manifest){
  fs.writeFileSync(preparation.manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

function sha256(value){
  return require("node:crypto").createHash("sha256").update(value).digest("hex");
}

function addUpdateSentinels(layout){
  writeFile(path.join(layout.sourceRoot, "video.mov"), "SECOND_VIDEO");
  writeFile(path.join(layout.referencesRoot, "nested", "keep.txt"), "NESTED_REFERENCE");
}

function assertUpdateSentinels(layout){
  assert.equal(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4"), "utf8"), "OLD_VIDEO");
  assert.equal(fs.readFileSync(path.join(layout.sourceRoot, "video.mov"), "utf8"), "SECOND_VIDEO");
  assert.equal(fs.readFileSync(path.join(layout.referencesRoot, "old-reference.png"), "utf8"), "OLD_REFERENCE");
  assert.equal(fs.readFileSync(path.join(layout.referencesRoot, "nested", "keep.txt"), "utf8"), "NESTED_REFERENCE");
  assert.equal(fs.readFileSync(path.join(layout.outputRoot, "preserve.mp4"), "utf8"), "OUTPUT_SENTINEL");
  assert.equal(fs.readFileSync(path.join(layout.logRoot, "app.log"), "utf8"), "LOG_SENTINEL\n");
}

function runSuccessCheck(root){
  const layout = createLayout(root, "success-job");
  const inputPath = path.join(root, "inputs", "synthetic.xml");
  writeFile(inputPath, XML_TEXT);
  const inspected = inspectInputFile(inputPath, ["xml"], 64 * 1024 * 1024);
  assert.equal(inspected.size, Buffer.byteLength(XML_TEXT));

  const preparation = prepareXmlCandidate({
    sourcePath: inputPath,
    logRoot: layout.logRoot,
    inputMethod: "test-dialog",
  });
  assert.equal(path.dirname(preparation.transactionRoot), path.resolve(layout.logRoot));
  assert.ok(fs.existsSync(preparation.candidatePath));
  assert.ok(fs.existsSync(preparation.manifestPath));

  const events = [];
  const nextJob = nextJobFor(layout, "new-success-job");
  const committed = commitPreparedXml({
    preparation,
    sourceRoot: layout.sourceRoot,
    referencesRoot: layout.referencesRoot,
    jobPath: layout.jobPath,
    nextJob,
    onEvent: (event, detail) => events.push({ event, detail }),
  });

  assert.deepEqual(committed.job, nextJob);
  assert.deepEqual(JSON.parse(fs.readFileSync(layout.jobPath, "utf8")), nextJob);
  assert.equal(fs.readFileSync(path.join(layout.sourceRoot, "timeline.xml"), "utf8"), XML_TEXT);
  assert.deepEqual(fs.readdirSync(layout.sourceRoot).sort(), [".gitkeep", "timeline.xml"]);
  assert.deepEqual(fs.readdirSync(layout.referencesRoot), [".gitkeep"]);
  assert.equal(fs.readFileSync(path.join(layout.outputRoot, "preserve.mp4"), "utf8"), "OUTPUT_SENTINEL");
  assert.equal(fs.readFileSync(path.join(layout.logRoot, "app.log"), "utf8"), "LOG_SENTINEL\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(layout.jobPath, "utf8")).ui, layout.oldJob.ui);
  assert.deepEqual(JSON.parse(fs.readFileSync(layout.jobPath, "utf8")).output, layout.oldJob.output);
  assert.deepEqual(transactionNames(layout.logRoot), []);
  assert.ok(events.some(item => item.event === "job_xml_commit_started"));
  assert.ok(events.some(item => item.event === "job_xml_commit_committed"));
}

function runUpdateSuccessCheck(root){
  const layout = createLayout(root, "update-success-job");
  addUpdateSentinels(layout);
  const inputPath = path.join(root, "inputs", "update-success.xml");
  const updateText = XML_TEXT.replace("Synthetic Timeline", "Update Success Timeline");
  writeFile(inputPath, updateText);
  const preparation = prepareXmlCandidate({
    sourcePath: inputPath,
    logRoot: layout.logRoot,
    inputMethod: "test-update",
  });
  const nextJob = nextJobForUpdate(layout, "updated-success-job");
  const events = [];
  const committed = commitPreparedXmlUpdate({
    preparation,
    sourceRoot: layout.sourceRoot,
    referencesRoot: layout.referencesRoot,
    jobPath: layout.jobPath,
    nextJob,
    onEvent: (event, detail) => events.push({ event, detail }),
  });

  assert.deepEqual(committed.job, nextJob);
  assert.equal(committed.removedSourceCount, 1);
  assert.equal(committed.removedReferenceCount, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(layout.jobPath, "utf8")), nextJob);
  assert.equal(fs.readFileSync(path.join(layout.sourceRoot, "timeline.xml"), "utf8"), updateText);
  assert.deepEqual(
    fs.readdirSync(layout.sourceRoot).sort(),
    [".gitkeep", "timeline.xml", "video.mov", "video.mp4"],
  );
  assert.deepEqual(
    fs.readdirSync(layout.referencesRoot).sort(),
    [".gitkeep", "nested", "old-reference.png"],
  );
  assertUpdateSentinels(layout);
  assert.deepEqual(transactionNames(layout.logRoot), []);
  assert.ok(events.some(item => item.event === "job_xml_update_commit_started"));
  assert.ok(events.some(item => item.event === "job_xml_update_commit_committed"));
}

function runUpdateCommitFailureRollbackCheck(root){
  const layout = createLayout(root, "update-failure-job");
  addUpdateSentinels(layout);
  const inputPath = path.join(root, "inputs", "update-failure.xml");
  writeFile(inputPath, XML_TEXT.replace("Synthetic Timeline", "Update Failure Timeline"));
  const preparation = prepareXmlCandidate({
    sourcePath: inputPath,
    logRoot: layout.logRoot,
    inputMethod: "test-update-failure",
  });
  const oldJobText = fs.readFileSync(layout.jobPath, "utf8");
  const oldTimelineText = fs.readFileSync(path.join(layout.sourceRoot, "timeline.xml"), "utf8");
  const events = [];
  const originalRename = fs.renameSync;
  let manifestRenameAttempts = 0;
  fs.renameSync = function(sourcePath, destinationPath){
    if(path.basename(String(sourcePath)) === "manifest.json.tmp" &&
        path.basename(String(destinationPath)) === "manifest.json"){
      manifestRenameAttempts += 1;
      const error = new Error("forced persistent manifest rename denial during rollback");
      error.code = "EPERM";
      throw error;
    }
    if(path.basename(String(sourcePath)) === "next-job.json" && samePath(destinationPath, layout.jobPath)){
      const error = new Error("forced XML update Job install failure");
      error.code = "TEST_UPDATE_COMMIT_FAILURE";
      throw error;
    }
    return originalRename.apply(this, arguments);
  };
  try{
    assert.throws(
      () => commitPreparedXmlUpdate({
        preparation,
        sourceRoot: layout.sourceRoot,
        referencesRoot: layout.referencesRoot,
        jobPath: layout.jobPath,
        nextJob: nextJobForUpdate(layout, "update-should-rollback"),
        onEvent: (event, detail) => events.push({ event, detail }),
      }),
      /forced XML update Job install failure/i,
    );
  }finally{
    fs.renameSync = originalRename;
  }

  assert.ok(manifestRenameAttempts >= 8, "commit and rollback manifests did not use verified-copy fallback");
  assert.equal(fs.readFileSync(layout.jobPath, "utf8"), oldJobText);
  assert.equal(fs.readFileSync(path.join(layout.sourceRoot, "timeline.xml"), "utf8"), oldTimelineText);
  assertUpdateSentinels(layout);
  assert.deepEqual(transactionNames(layout.logRoot), []);
  assert.ok(events.some(item => item.event === "job_xml_update_commit_rollback_started"));
  assert.ok(events.some(item => item.event === "job_xml_update_commit_rollback_completed"));
}

function runPersistentManifestEpermCommitCheck(root){
  const layout = createLayout(root, "manifest-eperm-job");
  const inputPath = path.join(root, "inputs", "manifest-eperm.xml");
  writeFile(inputPath, XML_TEXT.replace("Synthetic Timeline", "Manifest EPERM Timeline"));
  const preparation = prepareXmlCandidate({
    sourcePath: inputPath,
    logRoot: layout.logRoot,
    inputMethod: "manifest-eperm",
  });
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
  let committed;
  try{
    committed = commitPreparedXml({
      preparation,
      sourceRoot: layout.sourceRoot,
      referencesRoot: layout.referencesRoot,
      jobPath: layout.jobPath,
      nextJob: nextJobFor(layout, "manifest-eperm-committed"),
    });
  }finally{
    fs.renameSync = originalRename;
  }
  assert.ok(renameAttempts >= 4, "manifest rename was not retried before verified-copy fallback");
  assert.equal(committed.job.jobId, "manifest-eperm-committed");
  assert.deepEqual(JSON.parse(fs.readFileSync(layout.jobPath, "utf8")), committed.job);
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runPersistentJobBackupEpermCheck(root){
  const layout = createLayout(root, "job-backup-eperm-job");
  const inputPath = path.join(root, "inputs", "job-backup-eperm.xml");
  writeFile(inputPath, XML_TEXT.replace("Synthetic Timeline", "Job Backup EPERM Timeline"));
  const preparation = prepareXmlCandidate({
    sourcePath: inputPath,
    logRoot: layout.logRoot,
    inputMethod: "job-backup-eperm",
  });
  const backupRoot = path.join(preparation.transactionRoot, "backup");
  const originalRename = fs.renameSync;
  let renameAttempts = 0;
  fs.renameSync = function(sourcePath, destinationPath){
    if(path.basename(String(sourcePath)) === "job.json.partial" &&
        path.basename(String(destinationPath)) === "job.json" &&
        samePath(path.dirname(String(destinationPath)), backupRoot)){
      renameAttempts += 1;
      const error = new Error("forced persistent Job backup rename denial");
      error.code = "EPERM";
      throw error;
    }
    return originalRename.apply(this, arguments);
  };
  let committed;
  try{
    committed = commitPreparedXml({
      preparation,
      sourceRoot: layout.sourceRoot,
      referencesRoot: layout.referencesRoot,
      jobPath: layout.jobPath,
      nextJob: nextJobFor(layout, "job-backup-eperm-committed"),
    });
  }finally{
    fs.renameSync = originalRename;
  }
  assert.ok(renameAttempts >= 4, "Job backup rename was not retried before verified-copy fallback");
  assert.equal(committed.job.jobId, "job-backup-eperm-committed");
  assert.deepEqual(JSON.parse(fs.readFileSync(layout.jobPath, "utf8")), committed.job);
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runLockedStaleManifestTempCheck(root){
  const layout = createLayout(root, "locked-stale-manifest-job");
  const inputPath = path.join(root, "inputs", "locked-stale-manifest.xml");
  writeFile(inputPath, XML_TEXT.replace("Synthetic Timeline", "Locked Stale Manifest Timeline"));
  const preparation = prepareXmlCandidate({
    sourcePath: inputPath,
    logRoot: layout.logRoot,
    inputMethod: "locked-stale-manifest",
  });
  const staleTemporaryPath = preparation.manifestPath + ".tmp";
  fs.copyFileSync(preparation.manifestPath, staleTemporaryPath);
  const originalUnlink = fs.unlinkSync;
  let unlinkAttempts = 0;
  fs.unlinkSync = function(candidatePath){
    if(samePath(String(candidatePath), staleTemporaryPath)){
      unlinkAttempts += 1;
      const error = new Error("forced locked stale XML manifest staging file");
      error.code = "EPERM";
      throw error;
    }
    return originalUnlink.apply(this, arguments);
  };
  let committed;
  let deferredRecovery;
  try{
    committed = commitPreparedXml({
      preparation,
      sourceRoot: layout.sourceRoot,
      referencesRoot: layout.referencesRoot,
      jobPath: layout.jobPath,
      nextJob: nextJobFor(layout, "locked-stale-manifest-committed"),
    });
    deferredRecovery = recoverXmlTransactions({
      logRoot: layout.logRoot,
      sourceRoot: layout.sourceRoot,
      referencesRoot: layout.referencesRoot,
      jobPath: layout.jobPath,
    });
  }finally{
    fs.unlinkSync = originalUnlink;
  }
  assert.ok(unlinkAttempts >= 4, "locked stale manifest staging file was not retried");
  assert.equal(committed.cleanupDeferred, true);
  assert.equal(committed.job.jobId, "locked-stale-manifest-committed");
  assert.equal(deferredRecovery.deferred, 1);
  assert.equal(deferredRecovery.failed, 0);
  assert.equal(transactionNames(layout.logRoot).length, 1);

  const recovery = recoverXmlTransactions({
    logRoot: layout.logRoot,
    sourceRoot: layout.sourceRoot,
    referencesRoot: layout.referencesRoot,
    jobPath: layout.jobPath,
  });
  assert.equal(recovery.cleaned, 1);
  assert.equal(recovery.deferred, 0);
  assert.equal(recovery.failed, 0);
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runFallbackAuthorityCleanupInterruptionCheck(root){
  const layout = createLayout(root, "fallback-authority-cleanup-job");
  const inputPath = path.join(root, "inputs", "fallback-authority-cleanup.xml");
  writeFile(inputPath, XML_TEXT.replace("Synthetic Timeline", "Fallback Authority Cleanup Timeline"));
  const preparation = prepareXmlCandidate({
    sourcePath: inputPath,
    logRoot: layout.logRoot,
    inputMethod: "fallback-authority-cleanup",
  });
  const uniqueTemporaryPath = preparation.manifestPath + ".tmp-" + require("node:crypto").randomUUID();
  fs.copyFileSync(preparation.manifestPath, uniqueTemporaryPath);
  fs.writeFileSync(preparation.manifestPath, "{BROKEN PRIMARY\n");

  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = function(candidatePath){
    if(samePath(String(candidatePath), preparation.candidatePath)){
      const error = new Error("forced XML candidate cleanup lock");
      error.code = "EPERM";
      throw error;
    }
    return originalUnlink.apply(this, arguments);
  };
  let firstRecovery;
  try{
    firstRecovery = recoverXmlTransactions({
      logRoot: layout.logRoot,
      sourceRoot: layout.sourceRoot,
      referencesRoot: layout.referencesRoot,
      jobPath: layout.jobPath,
    });
  }finally{
    fs.unlinkSync = originalUnlink;
  }
  assert.equal(firstRecovery.deferred, 1);
  assert.equal(firstRecovery.failed, 0);
  assert.equal(JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8")).state, "prepared");
  assert.ok(fs.existsSync(preparation.candidatePath));

  const secondRecovery = recoverXmlTransactions({
    logRoot: layout.logRoot,
    sourceRoot: layout.sourceRoot,
    referencesRoot: layout.referencesRoot,
    jobPath: layout.jobPath,
  });
  assert.equal(secondRecovery.cleaned, 1);
  assert.equal(secondRecovery.failed, 0);
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runManifestReadFallbackChecks(root){
  const fallbackLayout = createLayout(root, "manifest-fallback-job");
  const fallbackInput = path.join(root, "inputs", "manifest-fallback.xml");
  writeFile(fallbackInput, XML_TEXT);
  const fallbackPreparation = prepareXmlCandidate({
    sourcePath: fallbackInput,
    logRoot: fallbackLayout.logRoot,
    inputMethod: "manifest-fallback",
  });
  fs.copyFileSync(fallbackPreparation.manifestPath, fallbackPreparation.manifestPath + ".tmp");
  fs.writeFileSync(fallbackPreparation.manifestPath, "{BROKEN PRIMARY\n");
  const fallbackRecovery = recoverXmlTransactions({
    logRoot: fallbackLayout.logRoot,
    sourceRoot: fallbackLayout.sourceRoot,
    referencesRoot: fallbackLayout.referencesRoot,
    jobPath: fallbackLayout.jobPath,
  });
  assert.equal(fallbackRecovery.cleaned, 1);
  assert.equal(fallbackRecovery.failed, 0);

  const primaryLayout = createLayout(root, "manifest-primary-first-job");
  const primaryInput = path.join(root, "inputs", "manifest-primary-first.xml");
  writeFile(primaryInput, XML_TEXT);
  const primaryPreparation = prepareXmlCandidate({
    sourcePath: primaryInput,
    logRoot: primaryLayout.logRoot,
    inputMethod: "manifest-primary-first",
  });
  const staleTemporary = JSON.parse(fs.readFileSync(primaryPreparation.manifestPath, "utf8"));
  staleTemporary.state = "rolling_back";
  staleTemporary.phase = "rolling_back";
  staleTemporary.moved = { source: [], references: [] };
  fs.writeFileSync(primaryPreparation.manifestPath + ".tmp", JSON.stringify(staleTemporary, null, 2) + "\n");
  const primaryRecovery = recoverXmlTransactions({
    logRoot: primaryLayout.logRoot,
    sourceRoot: primaryLayout.sourceRoot,
    referencesRoot: primaryLayout.referencesRoot,
    jobPath: primaryLayout.jobPath,
  });
  assert.equal(primaryRecovery.cleaned, 1, "valid primary manifest was not preferred over stale temporary");
  assert.equal(primaryRecovery.recovered, 0);
  assert.equal(primaryRecovery.failed, 0);
}

function runPersistentJobInstallEpermCheck(root){
  const layout = createLayout(root, "job-install-eperm-job");
  const inputPath = path.join(root, "inputs", "job-install-eperm.xml");
  writeFile(inputPath, XML_TEXT.replace("Synthetic Timeline", "Job Install EPERM Timeline"));
  const preparation = prepareXmlCandidate({
    sourcePath: inputPath,
    logRoot: layout.logRoot,
    inputMethod: "job-install-eperm",
  });
  const nextJob = nextJobFor(layout, "job-install-eperm-committed");
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
    commitPreparedXml({
      preparation,
      sourceRoot: layout.sourceRoot,
      referencesRoot: layout.referencesRoot,
      jobPath: layout.jobPath,
      nextJob,
    });
  }finally{
    fs.renameSync = originalRename;
  }
  assert.ok(renameAttempts >= 4, "Job install rename was not retried before verified-copy fallback");
  assert.deepEqual(JSON.parse(fs.readFileSync(layout.jobPath, "utf8")), nextJob);
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runPersistentJobRestoreEpermRecoveryCheck(root){
  const layout = createLayout(root, "job-restore-eperm-job");
  const inputPath = path.join(root, "inputs", "job-restore-eperm.xml");
  writeFile(inputPath, XML_TEXT.replace("Synthetic Timeline", "Job Restore EPERM Timeline"));
  const preparation = prepareXmlCandidate({
    sourcePath: inputPath,
    logRoot: layout.logRoot,
    inputMethod: "job-restore-eperm",
  });
  const oldJobText = fs.readFileSync(layout.jobPath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8"));
  const backupRoot = path.join(preparation.transactionRoot, "backup");
  const sourceBackupRoot = path.join(backupRoot, "source");
  const referencesBackupRoot = path.join(backupRoot, "references");
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.copyFileSync(layout.jobPath, path.join(backupRoot, "job.json"));
  moveResettableEntries(layout.sourceRoot, sourceBackupRoot);
  moveResettableEntries(layout.referencesRoot, referencesBackupRoot);
  fs.renameSync(preparation.candidatePath, path.join(layout.sourceRoot, "timeline.xml"));
  const interruptedJob = nextJobFor(layout, "job-restore-eperm-interrupted");
  const interruptedJobText = JSON.stringify(interruptedJob, null, 2) + "\n";
  writeFile(layout.jobPath, interruptedJobText);
  manifest.state = "committing";
  manifest.phase = "installing_job";
  manifest.hadJob = true;
  manifest.nextJobSha256 = sha256(interruptedJobText);
  manifest.moved = { source: ["timeline.xml", "video.mp4"], references: ["old-reference.png"] };
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
    recovery = recoverXmlTransactions({
      logRoot: layout.logRoot,
      sourceRoot: layout.sourceRoot,
      referencesRoot: layout.referencesRoot,
      jobPath: layout.jobPath,
    });
  }finally{
    fs.renameSync = originalRename;
  }
  assert.ok(renameAttempts >= 4, "Job restore rename was not retried before verified-copy fallback");
  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.failed, 0);
  assert.equal(fs.readFileSync(layout.jobPath, "utf8"), oldJobText);
  assert.equal(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4"), "utf8"), "OLD_VIDEO");
  assert.equal(fs.readFileSync(path.join(layout.referencesRoot, "old-reference.png"), "utf8"), "OLD_REFERENCE");
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runIdenticalJobRestoreSkipsReplaceCheck(root){
  const layout = createLayout(root, "job-restore-identical-job");
  const inputPath = path.join(root, "inputs", "job-restore-identical.xml");
  writeFile(inputPath, XML_TEXT.replace("Synthetic Timeline", "Job Restore Identical Timeline"));
  const preparation = prepareXmlCandidate({
    sourcePath: inputPath,
    logRoot: layout.logRoot,
    inputMethod: "job-restore-identical",
  });
  const manifest = JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8"));
  const backupRoot = path.join(preparation.transactionRoot, "backup");
  const sourceBackupRoot = path.join(backupRoot, "source");
  const referencesBackupRoot = path.join(backupRoot, "references");
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.copyFileSync(layout.jobPath, path.join(backupRoot, "job.json"));
  moveResettableEntries(layout.sourceRoot, sourceBackupRoot);
  moveResettableEntries(layout.referencesRoot, referencesBackupRoot);
  fs.renameSync(preparation.candidatePath, path.join(layout.sourceRoot, "timeline.xml"));
  manifest.state = "committing";
  manifest.phase = "installing_job";
  manifest.hadJob = true;
  manifest.moved = { source: ["timeline.xml", "video.mp4"], references: ["old-reference.png"] };
  writeManifest(preparation, manifest);

  const originalRename = fs.renameSync;
  let jobRenameAttempts = 0;
  fs.renameSync = function(sourcePath, destinationPath){
    if(path.basename(String(sourcePath)) === "restore-job.json" && samePath(destinationPath, layout.jobPath)){
      jobRenameAttempts += 1;
      const error = new Error("identical XML Job should not be renamed");
      error.code = "TEST_IDENTICAL_RENAME";
      throw error;
    }
    return originalRename.apply(this, arguments);
  };
  let recovery;
  try{
    recovery = recoverXmlTransactions({
      logRoot: layout.logRoot,
      sourceRoot: layout.sourceRoot,
      referencesRoot: layout.referencesRoot,
      jobPath: layout.jobPath,
    });
  }finally{
    fs.renameSync = originalRename;
  }
  assert.equal(jobRenameAttempts, 0, "identical XML Job content should bypass replacement");
  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.failed, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(layout.jobPath, "utf8")), layout.oldJob);
  assert.equal(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4"), "utf8"), "OLD_VIDEO");
  assert.equal(fs.readFileSync(path.join(layout.referencesRoot, "old-reference.png"), "utf8"), "OLD_REFERENCE");
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runUpdateRecoveryCheck(root){
  const layout = createLayout(root, "update-recovery-job");
  addUpdateSentinels(layout);
  const inputPath = path.join(root, "inputs", "update-recovery.xml");
  const updateText = XML_TEXT.replace("Synthetic Timeline", "Update Recovery Timeline");
  writeFile(inputPath, updateText);
  const preparation = prepareXmlCandidate({
    sourcePath: inputPath,
    logRoot: layout.logRoot,
    inputMethod: "test-update-crash",
  });
  const oldJobText = fs.readFileSync(layout.jobPath, "utf8");
  const oldTimelineText = fs.readFileSync(path.join(layout.sourceRoot, "timeline.xml"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8"));
  const backupRoot = path.join(preparation.transactionRoot, "backup");
  const sourceBackupRoot = path.join(backupRoot, "source");
  fs.mkdirSync(sourceBackupRoot, { recursive: true });
  fs.copyFileSync(layout.jobPath, path.join(backupRoot, "job.json"));
  fs.renameSync(path.join(layout.sourceRoot, "timeline.xml"), path.join(sourceBackupRoot, "timeline.xml"));
  fs.renameSync(preparation.candidatePath, path.join(layout.sourceRoot, "timeline.xml"));
  writeFile(layout.jobPath, JSON.stringify(nextJobForUpdate(layout, "interrupted-update-job"), null, 2) + "\n");
  manifest.state = "committing";
  manifest.phase = "installing_job";
  manifest.hadJob = true;
  manifest.moved = { source: ["timeline.xml"], references: [] };
  writeManifest(preparation, manifest);

  const recovery = recoverXmlTransactions({
    logRoot: layout.logRoot,
    sourceRoot: layout.sourceRoot,
    referencesRoot: layout.referencesRoot,
    jobPath: layout.jobPath,
  });

  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.failed, 0);
  assert.equal(fs.readFileSync(layout.jobPath, "utf8"), oldJobText);
  assert.equal(fs.readFileSync(path.join(layout.sourceRoot, "timeline.xml"), "utf8"), oldTimelineText);
  assertUpdateSentinels(layout);
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runRecoveryCheck(root){
  const layout = createLayout(root, "recovery-job");
  const inputPath = path.join(root, "inputs", "recovery.xml");
  writeFile(inputPath, XML_TEXT.replace("Synthetic Timeline", "Recovery Timeline"));
  const preparation = prepareXmlCandidate({
    sourcePath: inputPath,
    logRoot: layout.logRoot,
    inputMethod: "crash-simulation",
  });
  const manifest = JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8"));
  const backupRoot = path.join(preparation.transactionRoot, "backup");
  const sourceBackupRoot = path.join(backupRoot, "source");
  const referencesBackupRoot = path.join(backupRoot, "references");
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.copyFileSync(layout.jobPath, path.join(backupRoot, "job.json"));
  moveResettableEntries(layout.sourceRoot, sourceBackupRoot);
  moveResettableEntries(layout.referencesRoot, referencesBackupRoot);
  fs.renameSync(preparation.candidatePath, path.join(layout.sourceRoot, "timeline.xml"));
  const interruptedJob = nextJobFor(layout, "interrupted-job");
  writeFile(layout.jobPath, JSON.stringify(interruptedJob, null, 2) + "\n");
  manifest.state = "committing";
  manifest.phase = "installing_job";
  manifest.hadJob = true;
  manifest.moved = {
    source: ["timeline.xml", "video.mp4"],
    references: ["old-reference.png"],
  };
  writeManifest(preparation, manifest);

  const events = [];
  const recovery = recoverXmlTransactions({
    logRoot: layout.logRoot,
    sourceRoot: layout.sourceRoot,
    referencesRoot: layout.referencesRoot,
    jobPath: layout.jobPath,
    onEvent: (event, detail) => events.push({ event, detail }),
  });

  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.failed, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(layout.jobPath, "utf8")), layout.oldJob);
  assert.equal(fs.readFileSync(path.join(layout.sourceRoot, "timeline.xml"), "utf8"), "<xmeml><old/></xmeml>\n");
  assert.equal(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4"), "utf8"), "OLD_VIDEO");
  assert.equal(fs.readFileSync(path.join(layout.referencesRoot, "old-reference.png"), "utf8"), "OLD_REFERENCE");
  assert.equal(fs.readFileSync(path.join(layout.outputRoot, "preserve.mp4"), "utf8"), "OUTPUT_SENTINEL");
  assert.equal(fs.readFileSync(path.join(layout.logRoot, "app.log"), "utf8"), "LOG_SENTINEL\n");
  assert.deepEqual(transactionNames(layout.logRoot), []);
  assert.ok(events.some(item => item.event === "job_xml_recovery_rolled_back"));
}

function runRollbackCleanupInterruptionCheck(root){
  const layout = createLayout(root, "rollback-cleanup-interruption-job");
  const inputPath = path.join(root, "inputs", "rollback-cleanup-interruption.xml");
  writeFile(inputPath, XML_TEXT.replace("Synthetic Timeline", "Rollback Cleanup Interruption Timeline"));
  const preparation = prepareXmlCandidate({
    sourcePath: inputPath,
    logRoot: layout.logRoot,
    inputMethod: "rollback-cleanup-interruption",
  });
  const manifest = JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8"));
  const backupRoot = path.join(preparation.transactionRoot, "backup");
  const sourceBackupRoot = path.join(backupRoot, "source");
  const referencesBackupRoot = path.join(backupRoot, "references");
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.copyFileSync(layout.jobPath, path.join(backupRoot, "job.json"));
  moveResettableEntries(layout.sourceRoot, sourceBackupRoot);
  moveResettableEntries(layout.referencesRoot, referencesBackupRoot);
  fs.renameSync(preparation.candidatePath, path.join(layout.sourceRoot, "timeline.xml"));
  writeFile(layout.jobPath, JSON.stringify(nextJobFor(layout, "rollback-cleanup-interrupted"), null, 2) + "\n");
  manifest.state = "committing";
  manifest.phase = "installing_job";
  manifest.hadJob = true;
  manifest.moved = { source: ["timeline.xml", "video.mp4"], references: ["old-reference.png"] };
  writeManifest(preparation, manifest);

  const originalRmdir = fs.rmdirSync;
  fs.rmdirSync = function(candidatePath){
    if(samePath(String(candidatePath), backupRoot)){
      const error = new Error("forced XML backup cleanup lock");
      error.code = "EPERM";
      throw error;
    }
    return originalRmdir.apply(this, arguments);
  };
  let firstRecovery;
  try{
    firstRecovery = recoverXmlTransactions({
      logRoot: layout.logRoot,
      sourceRoot: layout.sourceRoot,
      referencesRoot: layout.referencesRoot,
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
  assert.equal(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4"), "utf8"), "OLD_VIDEO");
  assert.equal(fs.readFileSync(path.join(layout.referencesRoot, "old-reference.png"), "utf8"), "OLD_REFERENCE");

  const secondRecovery = recoverXmlTransactions({
    logRoot: layout.logRoot,
    sourceRoot: layout.sourceRoot,
    referencesRoot: layout.referencesRoot,
    jobPath: layout.jobPath,
  });
  assert.equal(secondRecovery.cleaned, 1);
  assert.equal(secondRecovery.failed, 0);
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runEmptyPreviousTimelineRollbackCheck(root){
  const layout = createLayout(root, "empty-previous-timeline-job");
  fs.unlinkSync(path.join(layout.sourceRoot, "timeline.xml"));
  const inputPath = path.join(root, "inputs", "empty-previous-timeline.xml");
  writeFile(inputPath, XML_TEXT.replace("Synthetic Timeline", "Empty Previous Timeline"));
  const preparation = prepareXmlCandidate({
    sourcePath: inputPath,
    logRoot: layout.logRoot,
    inputMethod: "empty-previous-timeline",
  });
  const manifest = JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8"));
  const backupRoot = path.join(preparation.transactionRoot, "backup");
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.copyFileSync(layout.jobPath, path.join(backupRoot, "job.json"));
  fs.renameSync(preparation.candidatePath, path.join(layout.sourceRoot, "timeline.xml"));
  manifest.state = "committing";
  manifest.phase = "installing_job";
  manifest.hadJob = true;
  manifest.moved = { source: [], references: [] };
  writeManifest(preparation, manifest);

  const recovery = recoverXmlTransactions({
    logRoot: layout.logRoot,
    sourceRoot: layout.sourceRoot,
    referencesRoot: layout.referencesRoot,
    jobPath: layout.jobPath,
  });
  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.failed, 0);
  assert.equal(fs.existsSync(path.join(layout.sourceRoot, "timeline.xml")), false);
  assert.equal(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4"), "utf8"), "OLD_VIDEO");
  assert.deepEqual(JSON.parse(fs.readFileSync(layout.jobPath, "utf8")), layout.oldJob);
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runRollbackMarkerWriteFailureRetryCheck(root){
  const layout = createLayout(root, "rollback-marker-write-failure-job");
  const inputPath = path.join(root, "inputs", "rollback-marker-write-failure.xml");
  writeFile(inputPath, XML_TEXT.replace("Synthetic Timeline", "Rollback Marker Failure Timeline"));
  const preparation = prepareXmlCandidate({
    sourcePath: inputPath,
    logRoot: layout.logRoot,
    inputMethod: "rollback-marker-write-failure",
  });
  const manifest = JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8"));
  const backupRoot = path.join(preparation.transactionRoot, "backup");
  const sourceBackupRoot = path.join(backupRoot, "source");
  const referencesBackupRoot = path.join(backupRoot, "references");
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.copyFileSync(layout.jobPath, path.join(backupRoot, "job.json"));
  moveResettableEntries(layout.sourceRoot, sourceBackupRoot);
  moveResettableEntries(layout.referencesRoot, referencesBackupRoot);
  fs.renameSync(preparation.candidatePath, path.join(layout.sourceRoot, "timeline.xml"));
  writeFile(layout.jobPath, JSON.stringify(nextJobFor(layout, "rollback-marker-write-failure"), null, 2) + "\n");
  manifest.state = "committing";
  manifest.phase = "installing_job";
  manifest.hadJob = true;
  manifest.moved = { source: ["timeline.xml", "video.mp4"], references: ["old-reference.png"] };
  writeManifest(preparation, manifest);

  const originalOpen = fs.openSync;
  let markerOpenAttempts = 0;
  fs.openSync = function(candidatePath, flags){
    if(path.basename(String(candidatePath)).startsWith("rollback-complete.json.tmp-") && flags === "wx"){
      markerOpenAttempts += 1;
      const error = new Error("forced XML rollback marker staging denial");
      error.code = "EPERM";
      throw error;
    }
    return originalOpen.apply(this, arguments);
  };
  let firstRecovery;
  try{
    firstRecovery = recoverXmlTransactions({
      logRoot: layout.logRoot,
      sourceRoot: layout.sourceRoot,
      referencesRoot: layout.referencesRoot,
      jobPath: layout.jobPath,
    });
  }finally{
    fs.openSync = originalOpen;
  }
  assert.ok(markerOpenAttempts >= 4, "XML rollback marker staging was not retried");
  assert.equal(firstRecovery.failed, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(layout.jobPath, "utf8")), layout.oldJob);
  assert.equal(fs.readFileSync(path.join(layout.sourceRoot, "timeline.xml"), "utf8"), "<xmeml><old/></xmeml>\n");
  assert.equal(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4"), "utf8"), "OLD_VIDEO");
  writeFile(path.join(preparation.transactionRoot, "rollback-complete.json"), "{BROKEN MARKER\n");

  const secondRecovery = recoverXmlTransactions({
    logRoot: layout.logRoot,
    sourceRoot: layout.sourceRoot,
    referencesRoot: layout.referencesRoot,
    jobPath: layout.jobPath,
  });
  assert.equal(secondRecovery.recovered, 1);
  assert.equal(secondRecovery.failed, 0);
  assert.equal(fs.readFileSync(path.join(layout.sourceRoot, "timeline.xml"), "utf8"), "<xmeml><old/></xmeml>\n");
  assert.equal(fs.readFileSync(path.join(layout.referencesRoot, "old-reference.png"), "utf8"), "OLD_REFERENCE");
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runEarlyBackupCrashCheck(root){
  const layout = createLayout(root, "early-backup-crash-job");
  const inputPath = path.join(root, "inputs", "early-backup.xml");
  writeFile(inputPath, XML_TEXT.replace("Synthetic Timeline", "Early Backup Timeline"));
  const preparation = prepareXmlCandidate({
    sourcePath: inputPath,
    logRoot: layout.logRoot,
    inputMethod: "early-backup-crash",
  });
  const oldJobText = fs.readFileSync(layout.jobPath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(preparation.manifestPath, "utf8"));
  manifest.state = "committing";
  manifest.phase = "backing_up_job";
  manifest.hadJob = null;
  fs.mkdirSync(path.join(preparation.transactionRoot, "backup"), { recursive: true });
  writeFile(path.join(preparation.transactionRoot, "backup", "job.json.partial"), oldJobText);
  writeFile(path.join(preparation.transactionRoot, "backup", "job.json"), "{\"old\":");
  writeManifest(preparation, manifest);

  const recovery = recoverXmlTransactions({
    logRoot: layout.logRoot,
    sourceRoot: layout.sourceRoot,
    referencesRoot: layout.referencesRoot,
    jobPath: layout.jobPath,
  });

  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.failed, 0);
  assert.equal(fs.readFileSync(layout.jobPath, "utf8"), oldJobText);
  assert.deepEqual(JSON.parse(fs.readFileSync(layout.jobPath, "utf8")), layout.oldJob);
  assert.equal(fs.readFileSync(path.join(layout.sourceRoot, "video.mp4"), "utf8"), "OLD_VIDEO");
  assert.equal(fs.readFileSync(path.join(layout.referencesRoot, "old-reference.png"), "utf8"), "OLD_REFERENCE");
  assert.deepEqual(transactionNames(layout.logRoot), []);
}

function runInvalidInputChecks(root){
  const invalidExtension = path.join(root, "inputs", "timeline.txt");
  const emptyXml = path.join(root, "inputs", "empty.xml");
  writeFile(invalidExtension, XML_TEXT);
  writeFile(emptyXml, "");
  assert.throws(
    () => inspectInputFile(invalidExtension, [".xml"], 64 * 1024 * 1024),
    /extension is not allowed/i,
  );
  assert.throws(
    () => inspectInputFile(emptyXml, [".xml"], 64 * 1024 * 1024),
    /file is empty/i,
  );
}

function safeCleanup(root){
  if(!root || !fs.existsSync(root)) return;
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(root);
  const relative = path.relative(temporaryRoot, resolved);
  if(!relative || relative.startsWith("..") || path.isAbsolute(relative) ||
      !path.basename(resolved).startsWith(TEMP_PREFIX) || samePath(resolved, PROJECT_CURRENT_JOB)){
    throw new Error("Refusing unsafe lifecycle-check cleanup");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function samePath(left, right){
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(parentPath, candidatePath){
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

let temporaryRoot = null;
let accessGuard = null;
try{
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  assertOutsideRealCurrentJob(temporaryRoot);
  accessGuard = installCurrentJobAccessGuard();
  runInvalidInputChecks(temporaryRoot);
  runSuccessCheck(temporaryRoot);
  runPersistentManifestEpermCommitCheck(temporaryRoot);
  runPersistentJobBackupEpermCheck(temporaryRoot);
  runLockedStaleManifestTempCheck(temporaryRoot);
  runFallbackAuthorityCleanupInterruptionCheck(temporaryRoot);
  runManifestReadFallbackChecks(temporaryRoot);
  runPersistentJobInstallEpermCheck(temporaryRoot);
  runUpdateSuccessCheck(temporaryRoot);
  runUpdateCommitFailureRollbackCheck(temporaryRoot);
  runUpdateRecoveryCheck(temporaryRoot);
  runRecoveryCheck(temporaryRoot);
  runRollbackCleanupInterruptionCheck(temporaryRoot);
  runEmptyPreviousTimelineRollbackCheck(temporaryRoot);
  runRollbackMarkerWriteFailureRetryCheck(temporaryRoot);
  runPersistentJobRestoreEpermRecoveryCheck(temporaryRoot);
  runIdenticalJobRestoreSkipsReplaceCheck(temporaryRoot);
  runEarlyBackupCrashCheck(temporaryRoot);
  assert.equal(accessGuard.blockedAccesses(), 0, "real current-job access was attempted");
  console.log("JOB_LIFECYCLE_CHECK_OK");
}finally{
  accessGuard?.restore();
  safeCleanup(temporaryRoot);
}
