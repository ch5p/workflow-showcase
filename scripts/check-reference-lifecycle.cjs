"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createReferenceLifecycle, normalizeReferenceLabels } = require("../reference-lifecycle.cjs");

assert.deepEqual(
  normalizeReferenceLabels([{ id: "a", type: "image" }, { id: "b", type: "video" }, { id: "c", type: "image" }]).map(item => item.label),
  ["IMAGE 01", "VIDEO 01", "IMAGE 02"],
);

async function main(){
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-showcase-reference-"));
  try{
    const referencesRoot = path.join(root, "references");
    const inputRoot = path.join(root, "input");
    fs.mkdirSync(referencesRoot);
    fs.mkdirSync(inputRoot);
    const sourcePath = path.join(inputRoot, "reference.png");
    fs.writeFileSync(sourcePath, Buffer.from("synthetic reference payload"));

    let stored = {
      jobId: "job-reference-test",
      revision: 3,
      references: [],
      globalReferenceIds: [],
      shotMappings: {},
      orphanedShotMappings: [],
    };
    const events = [];
    const progress = [];
    const loadExpectedJob = (jobId, revision, operation) => {
      assert.equal(jobId, stored.jobId, operation);
      assert.equal(revision, stored.revision, operation);
      return structuredClone(stored);
    };
    const persistJob = job => {
      stored = { ...structuredClone(job), revision: job.revision + 1 };
      return structuredClone(stored);
    };
    const lifecycle = createReferenceLifecycle({
      jobRoot: root,
      referencesRoot,
      loadExpectedJob,
      persistJob,
      hydrateJob: job => structuredClone(job),
      logEvent: (event, detail) => events.push({ event, detail }),
      sendProgress: (_event, detail) => progress.push(detail),
    });

    const imported = await lifecycle.importPaths(null, [sourcePath], stored.jobId, stored.revision);
    assert.equal(imported.references.length, 1);
    assert.equal(imported.references[0].type, "image");
    assert.equal(imported.references[0].label, "IMAGE 01");
    const importedPath = path.join(root, imported.references[0].relativePath);
    assert.equal(fs.existsSync(importedPath), true);
    assert.equal(progress.at(-1)?.state, "complete");

    const referenceId = imported.references[0].id;
    stored.globalReferenceIds = [referenceId];
    stored.shotMappings = { "1": { mode: "ADD", refs: [referenceId] } };
    stored.orphanedShotMappings = [{ descriptor: {}, mapping: { mode: "REPLACE", refs: [referenceId] }, reason: "test" }];
    const deleted = lifecycle.deleteReference({ id: referenceId, expectedJobId: stored.jobId, expectedRevision: stored.revision });
    assert.equal(deleted.fileDeleted, true);
    assert.equal(deleted.job.references.length, 0);
    assert.deepEqual(deleted.job.globalReferenceIds, []);
    assert.deepEqual(deleted.job.shotMappings, {});
    assert.deepEqual(deleted.job.orphanedShotMappings, []);
    assert.equal(fs.existsSync(importedPath), false);
    assert.equal(events.some(entry => entry.event === "references_imported"), true);
    assert.equal(events.some(entry => entry.event === "reference_deleted"), true);
  }finally{
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log("REFERENCE_LIFECYCLE_OK");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
