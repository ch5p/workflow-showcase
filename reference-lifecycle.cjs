"use strict";

const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { inspectInputFile } = require("./job-lifecycle.cjs");
const { resolveOwnedRelativeFile } = require("./owned-path.cjs");
const { commitImportedReferences } = require("./reference-import-state.cjs");
const { assertCopySpace, copyFileWithHash } = require("./storage-policy.cjs");

const REFERENCE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".mp4", ".mov", ".m4v", ".webm"];
const REFERENCE_PICKER_EXTENSIONS = REFERENCE_EXTENSIONS.map(extension => extension.slice(1));
const REFERENCE_MAX_BYTES = 64 * 1024 * 1024 * 1024;

function safeName(name){
  const normalized = path.basename(name).normalize("NFKC");
  return normalized.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim() || "file";
}

function referenceType(filePath){
  const extension = path.extname(filePath).toLowerCase();
  if([".mp4", ".mov", ".m4v", ".webm"].includes(extension)) return "video";
  if([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"].includes(extension)) return "image";
  return null;
}

function normalizeReferenceLabels(references){
  const counts = { image: 0, video: 0 };
  return (references || []).map(reference => {
    const type = reference.type === "video" ? "video" : "image";
    counts[type] += 1;
    return {
      ...reference,
      label: type.toUpperCase() + " " + String(counts[type]).padStart(2, "0"),
    };
  });
}

function createReferenceLifecycle({
  jobRoot,
  referencesRoot,
  loadExpectedJob,
  persistJob,
  hydrateJob,
  logEvent,
  sendProgress,
} = {}){
  for(const [label, value] of Object.entries({ loadExpectedJob, persistJob, hydrateJob, logEvent, sendProgress })){
    if(typeof value !== "function") throw new TypeError("Reference lifecycle dependency is required: " + label);
  }
  if(typeof jobRoot !== "string" || !jobRoot || typeof referencesRoot !== "string" || !referencesRoot){
    throw new TypeError("Reference lifecycle roots are required");
  }

  async function importPaths(event, sourcePaths, expectedJobId, expectedRevision){
    const current = loadExpectedJob(expectedJobId, expectedRevision, "reference_import");
    const added = [];
    const createdPaths = [];
    const inspectedInputs = [];
    let next = null;
    for(const candidate of sourcePaths || []){
      if(typeof candidate !== "string") continue;
      try{
        const inspected = inspectInputFile(candidate, REFERENCE_EXTENSIONS, REFERENCE_MAX_BYTES);
        const type = referenceType(inspected.absolutePath);
        if(type) inspectedInputs.push({ inspected, type });
      }catch(error){
        logEvent("reference_import_skipped", { code: error.code || "INVALID_INPUT" });
      }
    }
    const totalBytes = inspectedInputs.reduce((sum, item) => {
      const nextTotal = sum + item.inspected.size;
      if(!Number.isSafeInteger(nextTotal)) throw new RangeError("Reference import selection is too large");
      return nextTotal;
    }, 0);
    const operationId = randomUUID();
    if(totalBytes){
      try{
        assertCopySpace({ destinationPath: referencesRoot, contentBytes: totalBytes, label: "Reference import" });
      }catch(error){
        sendProgress(event, { operationId, kind: "references", state: "failed" });
        logEvent("reference_import_prepare_failed", { code: error.code || "PREPARE_FAILED" });
        throw error;
      }
    }
    let completedBytes = 0;
    try{
      for(const { inspected, type } of inspectedInputs){
        const sourcePath = inspected.absolutePath;
        const nextNumber = current.references.filter(reference => reference.type === type).length + 1;
        const id = type + "-" + String(nextNumber).padStart(2, "0") + "-" + Date.now().toString(36);
        const destinationName = id + "_" + safeName(path.basename(sourcePath));
        const destinationPath = path.join(referencesRoot, destinationName);
        await copyFileWithHash({
          sourcePath,
          destinationPath,
          expectedBytes: inspected.size,
          onProgress: progress => sendProgress(event, {
            operationId,
            kind: "references",
            state: "copying",
            copiedBytes: completedBytes + progress.copiedBytes,
            totalBytes,
            percent: totalBytes ? Math.min(100, Math.round((completedBytes + progress.copiedBytes) / totalBytes * 100)) : 100,
          }),
        });
        createdPaths.push(destinationPath);
        completedBytes += inspected.size;
        const reference = {
          id,
          type,
          label: type.toUpperCase() + " " + String(nextNumber).padStart(2, "0"),
          originalName: path.basename(sourcePath),
          relativePath: path.relative(jobRoot, destinationPath).replaceAll("\\", "/"),
        };
        current.references.push(reference);
        added.push(reference);
      }
      next = added.length
        ? commitImportedReferences({
            loadExpectedJob,
            persistJob,
            normalizeReferences: normalizeReferenceLabels,
            expectedJobId,
            expectedRevision,
            added,
          })
        : current;
    }catch(error){
      sendProgress(event, { operationId, kind: "references", state: "failed" });
      for(const createdPath of createdPaths){
        try{ if(fs.existsSync(createdPath)) fs.unlinkSync(createdPath); }catch(cleanupError){
          logEvent("reference_import_cleanup_failed", { code: cleanupError.code || "CLEANUP_FAILED" });
        }
      }
      if(error.code === "JOB_STALE"){
        logEvent("reference_import_stale_discarded", { copiedFileCount: createdPaths.length });
      }
      throw error;
    }
    if(totalBytes){
      sendProgress(event, {
        operationId,
        kind: "references",
        state: "complete",
        copiedBytes: totalBytes,
        totalBytes,
        percent: 100,
      });
    }
    logEvent("references_imported", { count: added.length });
    return hydrateJob(next);
  }

  function deleteReference(payload){
    const referenceId = payload?.id;
    if(typeof referenceId !== "string" || !referenceId) throw new Error("Invalid reference id");
    const current = loadExpectedJob(payload?.expectedJobId, payload?.expectedRevision, "reference_delete");
    const reference = (current.references || []).find(item => item.id === referenceId);
    if(!reference) return { job: hydrateJob(current), fileDeleted: false, missing: true };

    current.references = normalizeReferenceLabels(current.references.filter(item => item.id !== referenceId));
    current.globalReferenceIds = (current.globalReferenceIds || []).filter(id => id !== referenceId);
    for(const [shotId, mapping] of Object.entries(current.shotMappings || {})){
      const refs = (mapping?.refs || []).filter(id => id !== referenceId);
      if(!refs.length && (mapping?.mode === "ADD" || mapping?.mode === "REPLACE")){
        delete current.shotMappings[shotId];
      }else{
        current.shotMappings[shotId] = { ...mapping, refs };
      }
    }
    current.orphanedShotMappings = (current.orphanedShotMappings || []).flatMap(record => {
      const refs = (record?.mapping?.refs || []).filter(id => id !== referenceId);
      if(!refs.length && (record?.mapping?.mode === "ADD" || record?.mapping?.mode === "REPLACE")) return [];
      return [{ ...record, mapping: { ...record.mapping, refs } }];
    });

    const next = persistJob(current);
    let fileDeleted = false;
    let warning = null;
    try{
      const absolutePath = resolveOwnedRelativeFile({
        jobRoot,
        ownedRoot: referencesRoot,
        relativePath: reference.relativePath,
        label: "reference",
      });
      if(fs.existsSync(absolutePath)){
        resolveOwnedRelativeFile({
          jobRoot,
          ownedRoot: referencesRoot,
          relativePath: reference.relativePath,
          label: "reference",
          mustExist: true,
        });
        fs.unlinkSync(absolutePath);
        fileDeleted = true;
      }
    }catch(error){
      warning = error.message;
      logEvent("reference_file_delete_failed", { id: referenceId, message: warning });
    }
    logEvent("reference_deleted", { id: referenceId, fileDeleted });
    return { job: hydrateJob(next), fileDeleted, warning };
  }

  return { importPaths, deleteReference };
}

module.exports = {
  REFERENCE_EXTENSIONS,
  REFERENCE_PICKER_EXTENSIONS,
  REFERENCE_MAX_BYTES,
  normalizeReferenceLabels,
  createReferenceLifecycle,
};
