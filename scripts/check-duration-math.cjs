"use strict";

const assert = require("node:assert/strict");
const { resolveDurationDelta } = require("../src/core/duration-math.js");

function delta(videoSeconds, durationFrames = 312, fps = 24){
  return resolveDurationDelta({ videoSeconds, durationFrames, fps });
}

assert.equal(delta(13.01).visible, false, "0.01s container rounding must stay below one frame");
assert.equal(delta(13.04).visible, false, "0.04s at 24fps is still below one frame");
assert.equal(delta(13 + 1 / 24).visible, true, "exactly one positive frame must be shown");
assert.equal(delta(13 - 1 / 24).visible, true, "exactly one negative frame must be shown");
assert.deepEqual(resolveDurationDelta({ videoSeconds: 12, durationFrames: 288, fps: 24 }), {
  xmlSeconds: 12,
  deltaSeconds: 0,
  frameSeconds: 1 / 24,
  visible: false,
});
assert.equal(resolveDurationDelta({ videoSeconds: 12, durationFrames: 288, fps: 0 }), null);

console.log("DURATION_MATH_CHECK_OK 6 cases");
