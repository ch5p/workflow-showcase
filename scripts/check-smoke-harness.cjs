"use strict";

const assert = require("node:assert/strict");
const { assertSecondarySmoke, tailText } = require("../smoke-harness.cjs");

assert.equal(tailText("abc", "def", 4), "cdef");
assert.equal(assertSecondarySmoke({ status: 0, stdout: "SINGLE_INSTANCE_REJECTED", stderr: "" }), true);
assert.throws(() => assertSecondarySmoke({ status: 1, stdout: "", stderr: "failed" }), /Single-instance smoke failed/);

console.log("SMOKE_HARNESS_CHECK_OK 3 cases");
