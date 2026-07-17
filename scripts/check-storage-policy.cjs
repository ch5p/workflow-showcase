"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MIN_COPY_RESERVE_BYTES,
  MAX_COPY_RESERVE_BYTES,
  copyReserveBytes,
  assertAvailableSpace,
  estimateExportBytes,
  assertExportSpace,
  copyFileWithHash,
} = require("../storage-policy.cjs");

const prefix = "workflow-storage-policy-";
let root = null;

async function run(){
  assert.equal(copyReserveBytes(1), MIN_COPY_RESERVE_BYTES);
  assert.equal(copyReserveBytes(100 * 1024 * 1024 * 1024), MAX_COPY_RESERVE_BYTES);
  assert.throws(() => assertAvailableSpace({
    destinationPath: ".",
    requiredBytes: 1001,
    label: "Test copy",
    statfsSync: () => ({ bsize: 100n, bavail: 10n }),
  }), error => error.code === "INSUFFICIENT_DISK_SPACE" && error.availableBytes === "1000");
  assert.deepEqual(assertAvailableSpace({
    destinationPath: ".",
    requiredBytes: 1000,
    statfsSync: () => ({ bsize: 100n, bavail: 10n }),
  }), { requiredBytes: 1000n, availableBytes: 1000n });
  assert.equal(estimateExportBytes({ durationSeconds: 10, bitrateMbps: 12 }), 16422000);
  assert.throws(() => assertExportSpace({
    destinationPath: ".",
    durationSeconds: 60,
    bitrateMbps: 24,
    statfsSync: () => ({ bsize: 1n, bavail: 1n }),
  }), error => error.code === "INSUFFICIENT_DISK_SPACE");

  root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const sourcePath = path.join(root, "source.bin");
  const destinationPath = path.join(root, "destination.bin");
  const content = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
  fs.writeFileSync(sourcePath, content);
  const progress = [];
  const copied = await copyFileWithHash({
    sourcePath,
    destinationPath,
    expectedBytes: content.length,
    onProgress: value => progress.push(value),
  });
  assert.deepEqual(fs.readFileSync(destinationPath), content);
  assert.equal(copied.bytes, content.length);
  assert.equal(copied.sha256, crypto.createHash("sha256").update(content).digest("hex"));
  assert.equal(progress[0].copiedBytes, 0);
  assert.equal(progress.at(-1).percent, 100);

  const partialPath = path.join(root, "partial.bin");
  await assert.rejects(() => copyFileWithHash({
    sourcePath,
    destinationPath: partialPath,
    expectedBytes: content.length + 1,
  }), error => error.code === "SOURCE_CHANGED_DURING_COPY");
  assert.equal(fs.existsSync(partialPath), false, "failed copy must remove its partial destination");

  const existingPath = path.join(root, "existing.bin");
  fs.writeFileSync(existingPath, "KEEP");
  await assert.rejects(() => copyFileWithHash({
    sourcePath,
    destinationPath: existingPath,
    expectedBytes: content.length,
  }), error => error.code === "EEXIST");
  assert.equal(fs.readFileSync(existingPath, "utf8"), "KEEP", "exclusive copy must preserve a pre-existing destination");

  console.log("STORAGE_POLICY_CHECK_OK 11 cases");
}

run().finally(() => {
  if(!root || !fs.existsSync(root)) return;
  const resolved = path.resolve(root);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolved);
  if(!relative || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(resolved).startsWith(prefix)){
    throw new Error("Refusing unsafe storage-policy cleanup");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
