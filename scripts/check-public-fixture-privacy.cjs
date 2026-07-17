"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assertNoPrivateBinaryContent } = require("./public-privacy.cjs");

const root = path.resolve(__dirname, "..");
const fixtureRoot = path.join(root, "fixtures", "premiere-export-kit", "public-fixture");

const syntheticPrivatePath = ["C:", "Users", "example", "project.prproj"].join("\\");
assert.throws(
  () => assertNoPrivateBinaryContent(Buffer.from("creatorAtom " + syntheticPrivatePath, "latin1"), "ASCII fixture"),
  error => error?.code === "PUBLIC_PRIVATE_DATA",
);
assert.throws(
  () => assertNoPrivateBinaryContent(Buffer.from(syntheticPrivatePath, "utf16le"), "UTF-16 fixture"),
  error => error?.code === "PUBLIC_PRIVATE_DATA",
);
assert.throws(
  () => assertNoPrivateBinaryContent(Buffer.concat([Buffer.from([0]), Buffer.from(syntheticPrivatePath, "utf16le")]), "unaligned UTF-16 fixture"),
  error => error?.code === "PUBLIC_PRIVATE_DATA",
);
for(const entry of fs.readdirSync(fixtureRoot, { withFileTypes: true })){
  if(!entry.isFile()) continue;
  const absolute = path.join(fixtureRoot, entry.name);
  assertNoPrivateBinaryContent(fs.readFileSync(absolute), path.relative(root, absolute).replaceAll("\\", "/"));
}

console.log("PUBLIC_FIXTURE_PRIVACY_OK");
