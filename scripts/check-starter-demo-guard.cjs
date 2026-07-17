"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { listExistingJobPayload } = require("../starter-demo-guard.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-showcase-demo-guard-"));
try{
  const sourceRoot = path.join(root, "source");
  const referencesRoot = path.join(root, "references");
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(referencesRoot);
  fs.writeFileSync(path.join(sourceRoot, ".gitkeep"), "");
  fs.writeFileSync(path.join(referencesRoot, ".gitkeep"), "");
  assert.deepEqual(listExistingJobPayload({ jobRoot: root, ownedRoots: [sourceRoot, referencesRoot] }), []);

  fs.writeFileSync(path.join(sourceRoot, "timeline.xml"), "<xmeml/>");
  fs.writeFileSync(path.join(referencesRoot, "image-01.png"), "fixture");
  assert.deepEqual(
    listExistingJobPayload({ jobRoot: root, ownedRoots: [sourceRoot, referencesRoot] }),
    ["references/image-01.png", "source/timeline.xml"],
  );
}finally{
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("STARTER_DEMO_GUARD_OK");
