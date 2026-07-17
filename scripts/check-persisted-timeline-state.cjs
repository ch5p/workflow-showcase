"use strict";

const assert = require("node:assert/strict");
const { validatePersistedTimelineState } = require("../persisted-timeline-state.cjs");

function shot(overrides = {}){
  return {
    id: "shot-1",
    identityKey: "src-0123456789abcdef",
    nameKey: "name-fedcba9876543210",
    startFrame: 0,
    endFrame: 24,
    occurrences: [{ startFrame: 0, endFrame: 24, inFrame: 0, outFrame: 24 }],
    ...overrides,
  };
}

assert.equal(validatePersistedTimelineState({ shotMappings: {} }), true);

const current = {
  timelineShots: [shot()],
  shotMappings: { "shot-1": { mode: "ADD", refs: ["reference-1"] } },
  orphanedShotMappings: [{
    descriptor: shot({
      id: "shot-orphan",
      identityKey: "src-1111111111111111",
      nameKey: "name-2222222222222222",
    }),
    mapping: { mode: "REPLACE", refs: ["reference-2"] },
    reason: "unmatched",
  }],
};
const before = JSON.stringify(current);
assert.equal(validatePersistedTimelineState(current), true);
assert.equal(JSON.stringify(current), before, "validation must not mutate persisted timeline data");

assert.throws(() => validatePersistedTimelineState({
  timelineShots: [shot({ timestamp: 1 })],
  shotMappings: {},
}), /forbidden field: timestamp/);
assert.throws(() => validatePersistedTimelineState({
  timelineShots: [shot({ identityKey: "clip-a.mp4" })],
  shotMappings: {},
}), /src-<16 hex>/);
assert.throws(() => validatePersistedTimelineState({ timelineShots: {}, shotMappings: {} }), /timelineShots/);
assert.throws(() => validatePersistedTimelineState({ shotMappings: [] }), /shotMappings/);

console.log("PERSISTED_TIMELINE_STATE_OK 6 cases");
