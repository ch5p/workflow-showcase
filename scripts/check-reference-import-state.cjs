"use strict";

const assert = require("node:assert/strict");
const { commitImportedReferences } = require("../reference-import-state.cjs");

function staleError(){
  const error = new Error("Current Job changed");
  error.code = "JOB_STALE";
  return error;
}

let persisted = false;
assert.throws(() => commitImportedReferences({
  loadExpectedJob: () => { throw staleError(); },
  persistJob: () => { persisted = true; },
  normalizeReferences: references => references,
  expectedJobId: "job-a",
  expectedRevision: 4,
  added: [{ id: "image-02" }],
}), error => error?.code === "JOB_STALE");
assert.equal(persisted, false, "A stale import must not write the Job");

const stored = { jobId: "job-a", revision: 4, references: [{ id: "image-01" }] };
const committed = commitImportedReferences({
  loadExpectedJob: (jobId, revision, operation) => {
    assert.equal(jobId, stored.jobId);
    assert.equal(revision, stored.revision);
    assert.equal(operation, "reference_import_commit");
    return structuredClone(stored);
  },
  persistJob: job => ({ ...job, revision: job.revision + 1 }),
  normalizeReferences: references => references,
  expectedJobId: stored.jobId,
  expectedRevision: stored.revision,
  added: [{ id: "image-02" }],
});
assert.deepEqual(committed.references.map(reference => reference.id), ["image-01", "image-02"]);
assert.equal(committed.revision, 5);

console.log("REFERENCE_IMPORT_STATE_OK");
