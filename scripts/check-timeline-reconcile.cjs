"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { reconcileTimelineMappings } = require("../timeline-reconcile.cjs");

function hash(value){
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function anonymousKey(prefix, value){
  return prefix + "-" + hash(value).slice(0, 16);
}

function occurrence(startFrame, endFrame, inFrame = 0, outFrame = inFrame + endFrame - startFrame){
  return { startFrame, endFrame, inFrame, outFrame };
}

function shot(id, identity, name, startFrame, endFrame, occurrences = [occurrence(startFrame, endFrame)]){
  return {
    id,
    identityKey: anonymousKey("src", "identity:" + identity),
    nameKey: anonymousKey("name", "name:" + name),
    startFrame,
    endFrame,
    occurrences,
  };
}

function mapping(label){
  return { mode: "REPLACE", refs: [hash("reference:" + label)] };
}

function testInsertPreservesStableShots(){
  const previousShots = [
    shot(1, "a", "a", 0, 10),
    shot(2, "b", "b", 10, 20),
    shot(3, "c", "c", 20, 30),
  ];
  const nextShots = [
    shot(10, "a", "a", 0, 10),
    shot(11, "b", "b", 10, 20),
    shot(12, "x", "x", 20, 30),
    shot(13, "c", "c", 30, 40, [occurrence(30, 40)]),
  ];
  const result = reconcileTimelineMappings({
    previousShots,
    nextShots,
    shotMappings: { 1: mapping("a"), 2: mapping("b"), 3: mapping("c") },
  });
  assert.deepEqual(Object.keys(result.shotMappings), ["10", "11", "13"]);
  assert.deepEqual(result.summary, { preserved: 3, newShots: 1, orphaned: 0, ambiguous: 0, reattached: 0 });
}

function testLengthChangeUsesUniqueNameEvidence(){
  const oldShot = shot("old", "old-source", "shared-name", 0, 100, [occurrence(0, 100, 0, 100)]);
  const resizedShot = shot("new", "new-source", "shared-name", 0, 110, [occurrence(0, 110, 20, 130)]);
  const result = reconcileTimelineMappings({
    previousShots: [oldShot],
    nextShots: [resizedShot],
    shotMappings: { old: mapping("length-change") },
  });
  assert.deepEqual(result.shotMappings.new, mapping("length-change"));
  assert.deepEqual(result.summary, { preserved: 1, newShots: 0, orphaned: 0, ambiguous: 0, reattached: 0 });
}

function testSingleOccurrenceDisjointRangeStaysOrphaned(){
  const oldShot = shot("old", "old-source", "shared-name", 0, 100, [occurrence(0, 100, 0, 100)]);
  const differentShot = shot("new", "different-source", "shared-name", 0, 105, [occurrence(0, 105, 200, 305)]);
  const result = reconcileTimelineMappings({
    previousShots: [oldShot],
    nextShots: [differentShot],
    shotMappings: { old: mapping("must-not-move") },
  });
  assert.deepEqual(result.shotMappings, {});
  assert.equal(result.orphanedShotMappings.length, 1);
  assert.equal(result.orphanedShotMappings[0].reason, "unmatched");
  assert.deepEqual(result.summary, { preserved: 0, newShots: 1, orphaned: 1, ambiguous: 0, reattached: 0 });
}

function testRepeatedSourceOccurrencesStayTogether(){
  const previous = shot("repeat-old", "repeat-source", "repeat-name", 0, 30, [
    occurrence(0, 10, 0, 10),
    occurrence(20, 30, 0, 10),
  ]);
  const next = shot("repeat-new", "repeat-source", "repeat-name", 0, 35, [
    occurrence(0, 12, 0, 12),
    occurrence(25, 35, 0, 10),
  ]);
  const result = reconcileTimelineMappings({
    previousShots: [previous],
    nextShots: [next],
    shotMappings: { "repeat-old": mapping("repeat") },
  });
  assert.deepEqual(result.shotMappings["repeat-new"], mapping("repeat"));
  assert.equal(result.summary.preserved, 1);
  assert.equal(result.summary.orphaned, 0);
}

function testDeletedMappedShotBecomesDeterministicOrphan(){
  const deleted = shot("deleted", "deleted-source", "deleted-name", 0, 10);
  const result = reconcileTimelineMappings({
    previousShots: [deleted],
    nextShots: [],
    shotMappings: { deleted: mapping("deleted") },
  });
  assert.deepEqual(result.shotMappings, {});
  assert.equal(result.orphanedShotMappings.length, 1);
  assert.deepEqual(result.orphanedShotMappings[0], {
    descriptor: deleted,
    mapping: mapping("deleted"),
    reason: "unmatched",
  });
  assert.equal("timestamp" in result.orphanedShotMappings[0], false);
  assert.deepEqual(result.summary, { preserved: 0, newShots: 0, orphaned: 1, ambiguous: 0, reattached: 0 });
}

function testMultipleNameCandidatesStayAmbiguous(){
  const previous = shot("old", "old-identity", "same-name", 0, 20, [occurrence(0, 20, 0, 20)]);
  const nextShots = [
    shot("candidate-a", "candidate-a", "same-name", 0, 20, [occurrence(0, 20, 0, 20)]),
    shot("candidate-b", "candidate-b", "same-name", 20, 40, [occurrence(20, 40, 0, 20)]),
  ];
  const result = reconcileTimelineMappings({
    previousShots: [previous],
    nextShots,
    shotMappings: { old: mapping("ambiguous") },
  });
  assert.deepEqual(result.shotMappings, {});
  assert.equal(result.orphanedShotMappings[0].reason, "ambiguous");
  assert.deepEqual(result.summary, { preserved: 0, newShots: 2, orphaned: 1, ambiguous: 1, reattached: 0 });
}

function testOrphanReappearsAndReattaches(){
  const current = shot("current-old", "current", "current", 0, 10);
  const orphan = shot("lost-old", "lost", "lost", 10, 20);
  const result = reconcileTimelineMappings({
    previousShots: [current],
    nextShots: [
      shot("current-new", "current", "current", 0, 10),
      shot("lost-new", "lost", "lost", 10, 20),
    ],
    shotMappings: { "current-old": mapping("current") },
    orphanedShotMappings: [{ descriptor: orphan, mapping: mapping("lost"), reason: "unmatched" }],
  });
  assert.deepEqual(result.shotMappings["current-new"], mapping("current"));
  assert.deepEqual(result.shotMappings["lost-new"], mapping("lost"));
  assert.deepEqual(result.summary, { preserved: 1, newShots: 0, orphaned: 0, ambiguous: 0, reattached: 1 });
}

function testDescriptorPrivacyAndDeterminism(){
  const safe = shot("safe", "safe", "safe", 0, 10);
  assert.throws(() => reconcileTimelineMappings({
    previousShots: [{ ...safe, rawPath: "forbidden" }],
    nextShots: [],
  }), /forbidden field: rawPath/);
  assert.throws(() => reconcileTimelineMappings({
    previousShots: [{ ...safe, identityKey: "clip-a.mp4" }],
    nextShots: [],
  }), /src-<16 hex>/);
  assert.throws(() => reconcileTimelineMappings({
    previousShots: [{ ...safe, nameKey: anonymousKey("src", "wrong-prefix") }],
    nextShots: [],
  }), /name-<16 hex>/);
  assert.throws(() => reconcileTimelineMappings({
    previousShots: [],
    nextShots: [],
    orphanedShotMappings: [{ descriptor: safe, mapping: mapping("safe"), reason: "unmatched", timestamp: 1 }],
  }), /forbidden field: timestamp/);
  const input = { previousShots: [safe], nextShots: [shot("next", "safe", "safe", 0, 10)], shotMappings: { safe: mapping("safe") } };
  assert.deepEqual(reconcileTimelineMappings(input), reconcileTimelineMappings(input));
}

const tests = [
  testInsertPreservesStableShots,
  testLengthChangeUsesUniqueNameEvidence,
  testSingleOccurrenceDisjointRangeStaysOrphaned,
  testRepeatedSourceOccurrencesStayTogether,
  testDeletedMappedShotBecomesDeterministicOrphan,
  testMultipleNameCandidatesStayAmbiguous,
  testOrphanReappearsAndReattaches,
  testDescriptorPrivacyAndDeterminism,
];

for(const test of tests) test();
console.log("TIMELINE_RECONCILE_OK " + tests.length + " cases");
