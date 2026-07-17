"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { fsyncExistingFile } = require("./durable-file.cjs");

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const MIN_COPY_RESERVE_BYTES = 512 * MIB;
const MAX_COPY_RESERVE_BYTES = 8 * GIB;

function checkedBytes(value, label){
  const bytes = Number(value);
  if(!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError(label + " must be non-negative safe bytes");
  return bytes;
}

function copyReserveBytes(contentBytes){
  const bytes = checkedBytes(contentBytes, "contentBytes");
  return Math.min(MAX_COPY_RESERVE_BYTES, Math.max(MIN_COPY_RESERVE_BYTES, Math.ceil(bytes * 0.1)));
}

function availableDiskBytes(destinationPath, { statfsSync = fs.statfsSync } = {}){
  if(typeof statfsSync !== "function"){
    const error = new Error("Disk space inspection is unavailable on this runtime");
    error.code = "DISK_SPACE_CHECK_UNAVAILABLE";
    throw error;
  }
  let stats;
  try{
    stats = statfsSync(destinationPath, { bigint: true });
  }catch(cause){
    const error = new Error("Unable to inspect destination disk space");
    error.code = "DISK_SPACE_CHECK_FAILED";
    error.cause = cause;
    throw error;
  }
  const blockSize = BigInt(stats?.bsize ?? 0);
  const availableBlocks = BigInt(stats?.bavail ?? stats?.bfree ?? 0);
  if(blockSize <= 0n || availableBlocks < 0n){
    const error = new Error("Destination disk space information is invalid");
    error.code = "DISK_SPACE_CHECK_FAILED";
    throw error;
  }
  return blockSize * availableBlocks;
}

function humanBytes(value){
  const bytes = typeof value === "bigint" ? value : BigInt(value);
  if(bytes >= BigInt(GIB)) return (Number(bytes / BigInt(MIB)) / 1024).toFixed(1) + " GiB";
  if(bytes >= BigInt(MIB)) return (Number(bytes / 1024n) / 1024).toFixed(1) + " MiB";
  return bytes + " bytes";
}

function assertAvailableSpace({ destinationPath, requiredBytes, label = "File operation", statfsSync } = {}){
  const required = BigInt(checkedBytes(requiredBytes, "requiredBytes"));
  const available = availableDiskBytes(destinationPath, { statfsSync });
  if(available < required){
    const error = new Error(label + " needs " + humanBytes(required) + " free, but only " + humanBytes(available) + " is available");
    error.code = "INSUFFICIENT_DISK_SPACE";
    error.requiredBytes = required.toString();
    error.availableBytes = available.toString();
    throw error;
  }
  return { requiredBytes: required, availableBytes: available };
}

function assertCopySpace({ destinationPath, contentBytes, label, statfsSync } = {}){
  const content = checkedBytes(contentBytes, "contentBytes");
  const reserve = copyReserveBytes(content);
  const required = content + reserve;
  if(!Number.isSafeInteger(required)) throw new RangeError("Copy space requirement is too large");
  return {
    ...assertAvailableSpace({ destinationPath, requiredBytes: required, label: label || "File copy", statfsSync }),
    contentBytes: content,
    reserveBytes: reserve,
  };
}

function estimateExportBytes({ durationSeconds, bitrateMbps, audioKbps = 512 } = {}){
  const duration = Number(durationSeconds);
  const videoRate = Number(bitrateMbps);
  const audioRate = Number(audioKbps);
  if(!Number.isFinite(duration) || duration <= 0) throw new TypeError("durationSeconds must be positive");
  if(!Number.isFinite(videoRate) || videoRate <= 0) throw new TypeError("bitrateMbps must be positive");
  if(!Number.isFinite(audioRate) || audioRate < 0) throw new TypeError("audioKbps must be non-negative");
  const bytes = Math.ceil(duration * (videoRate * 1_000_000 + audioRate * 1_000) / 8 * 1.05);
  if(!Number.isSafeInteger(bytes)) throw new RangeError("Export estimate is too large");
  return bytes;
}

function assertExportSpace({ destinationPath, durationSeconds, bitrateMbps, statfsSync } = {}){
  const estimatedBytes = estimateExportBytes({ durationSeconds, bitrateMbps });
  const reserveBytes = copyReserveBytes(estimatedBytes);
  const requiredBytes = estimatedBytes + reserveBytes;
  return {
    ...assertAvailableSpace({
      destinationPath,
      requiredBytes,
      label: "Export",
      statfsSync,
    }),
    estimatedBytes,
    reserveBytes,
  };
}

function abortError(){
  const error = new Error("File copy was cancelled");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

async function copyFileWithHash({ sourcePath, destinationPath, expectedBytes, onProgress, signal } = {}){
  const totalBytes = checkedBytes(expectedBytes, "expectedBytes");
  if(signal?.aborted) throw abortError();
  let copiedBytes = 0;
  let lastReportAt = 0;
  const hash = crypto.createHash("sha256");
  let destinationCreated = false;
  const report = force => {
    if(typeof onProgress !== "function") return;
    const now = Date.now();
    if(!force && now - lastReportAt < 200) return;
    lastReportAt = now;
    try{
      onProgress({
        copiedBytes,
        totalBytes,
        percent: totalBytes ? Math.min(100, Math.round(copiedBytes / totalBytes * 100)) : 100,
      });
    }catch{}
  };
  const meter = new Transform({
    transform(chunk, _encoding, callback){
      copiedBytes += chunk.length;
      hash.update(chunk);
      report(false);
      callback(null, chunk);
    },
  });

  report(true);
  try{
    const source = fs.createReadStream(sourcePath);
    const destination = fs.createWriteStream(destinationPath, { flags: "wx" });
    destination.once("open", () => { destinationCreated = true; });
    if(signal) await pipeline(source, meter, destination, { signal });
    else await pipeline(source, meter, destination);
    if(copiedBytes !== totalBytes){
      const error = new Error("Source file changed while it was being copied");
      error.code = "SOURCE_CHANGED_DURING_COPY";
      throw error;
    }
    fsyncExistingFile(destinationPath);
    report(true);
    return { bytes: copiedBytes, sha256: hash.digest("hex") };
  }catch(error){
    try{ if(destinationCreated && fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath); }catch{}
    throw error;
  }
}

module.exports = {
  MIN_COPY_RESERVE_BYTES,
  MAX_COPY_RESERVE_BYTES,
  copyReserveBytes,
  availableDiskBytes,
  assertAvailableSpace,
  assertCopySpace,
  estimateExportBytes,
  assertExportSpace,
  copyFileWithHash,
};
