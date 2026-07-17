"use strict";

const assert = require("node:assert/strict");
const { readPngDimensions, captureFileStamp } = require("../ui-capture.cjs");

const png = Buffer.alloc(24);
png.write("PNG", 1, "ascii");
png.writeUInt32BE(2560, 16);
png.writeUInt32BE(2160, 20);
assert.deepEqual(readPngDimensions(png), { width: 2560, height: 2160 });
assert.throws(() => readPngDimensions(Buffer.from("not-png")), /valid PNG/);
assert.equal(captureFileStamp(new Date(2026, 6, 18, 3, 4, 5)), "20260718-030405");

console.log("UI_CAPTURE_CHECK_OK 3 cases");
