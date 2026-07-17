"use strict";

function commitImportedReferences({
  loadExpectedJob,
  persistJob,
  normalizeReferences,
  expectedJobId,
  expectedRevision,
  added,
} = {}){
  if(typeof loadExpectedJob !== "function" || typeof persistJob !== "function" || typeof normalizeReferences !== "function"){
    throw new TypeError("Reference import commit dependencies are required");
  }
  const imported = Array.isArray(added) ? added : [];
  const current = loadExpectedJob(expectedJobId, expectedRevision, "reference_import_commit");
  if(!imported.length) return current;
  current.references = normalizeReferences([...(current.references || []), ...imported]);
  return persistJob(current);
}

module.exports = { commitImportedReferences };
