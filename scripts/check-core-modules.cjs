"use strict";

const assert=require("node:assert/strict");
const {CLASSIC_RENDER_SPEC,resolveRenderSpec}=require("../render-spec.cjs");
const {normalizeSourcePath}=require("../src/core/xmeml-parser.js");
const {buildPrimarySegments}=require("../src/core/primary-timeline.js");
const {inspectTimeline,portableFingerprint}=require("../src/core/shot-model.js");
const {
  mappingForShot,
  resolveVisibleReferenceIds,
  hydrateShots,
  snapshotMappings,
}=require("../src/core/reference-mapping.js");

const clipA1={track:1,name:"clip-a.mp4",start:0,end:72,in:0,out:72,enabled:true,sourceId:"file:file-a"};
const clipB={track:1,name:"clip-b.mp4",start:72,end:144,in:0,out:72,enabled:true,sourceId:"file:file-b"};
const clipA2={track:1,name:"clip-a.mp4",start:144,end:216,in:0,out:72,enabled:true,sourceId:"file:file-a"};
const clipC={track:1,name:"clip-c.mp4",start:216,end:288,in:0,out:72,enabled:true,sourceId:"file:file-c"};
const overlayD={track:2,name:"overlay-d.mp4",start:48,end:120,in:0,out:72,enabled:true,sourceId:"file:file-d"};
const disabledE={track:2,name:"disabled-e.mp4",start:168,end:192,in:0,out:24,enabled:false,sourceId:"file:file-e"};
const timeline={
  fps:24,
  duration:288,
  name:"synthetic-timeline",
  clips:[clipA1,clipB,clipA2,clipC,overlayD,disabledE],
};

assert.deepEqual(resolveRenderSpec(),CLASSIC_RENDER_SPEC);
assert.deepEqual(resolveRenderSpec({fps:"30",bitrateMbps:"18"}),{
  ...CLASSIC_RENDER_SPEC,fps:30,bitrateMbps:18,
});

const segments=buildPrimarySegments(timeline);
assert.deepEqual(segments.map(segment=>[segment.start,segment.end,segment.clip.name]),[
  [0,48,"clip-a.mp4"],
  [48,120,"overlay-d.mp4"],
  [120,144,"clip-b.mp4"],
  [144,216,"clip-a.mp4"],
  [216,288,"clip-c.mp4"],
]);
assert.equal(buildPrimarySegments({duration:12,clips:[]}).length,0);

const inspection=inspectTimeline(timeline);
assert.equal(inspection.fps,24);
assert.equal(inspection.durationFrames,288);
assert.equal(inspection.edits,5);
assert.equal(inspection.shots.length,4);
assert.deepEqual(inspection.shots.map(shot=>shot.edits),[2,1,1,1]);
assert.deepEqual(inspection.shots[0].occurrences.map(item=>[item.startFrame,item.endFrame]),[[0,48],[144,216]]);
assert.match(inspection.shots[0].identityKey,/^src-[0-9a-f]{16}$/);
assert.equal(portableFingerprint("src","file:file-a"),inspection.shots[0].identityKey);

assert.equal(normalizeSourcePath("file://localhost/C:/Fixture/CLIP-A.mp4"),"/c:/fixture/clip-a.mp4");
assert.deepEqual(resolveVisibleReferenceIds(["g1","g2"],{mode:"INHERIT",refs:["s1"]}),["g1","g2"]);
assert.deepEqual(resolveVisibleReferenceIds(["g1","g2"],{mode:"HIDE",refs:["s1"]}),[]);
assert.deepEqual(resolveVisibleReferenceIds(["g1","g2"],{mode:"REPLACE",refs:["s1","s2"]}),["s1","s2"]);
assert.deepEqual(resolveVisibleReferenceIds(["g1","g2"],{mode:"ADD",refs:["g2","s1"]}),["g1","g2","s1"]);
assert.deepEqual(mappingForShot({"1":{mode:"unknown",refs:["x"],leadInSeconds:"1"}},1),{
  mode:"INHERIT",refs:["x"],leadInSeconds:1,
});

const hydrated=hydrateShots([{id:1,edits:2},{id:2,edits:1}],{
  "1":{mode:"ADD",refs:["s1"],leadInSeconds:1},
});
assert.deepEqual(hydrated[0],{id:1,edits:2,mode:"ADD",refs:["s1"],leadInSeconds:1});
assert.deepEqual(hydrated[1],{id:2,edits:1,mode:"INHERIT",refs:[],leadInSeconds:0});
assert.deepEqual(snapshotMappings(hydrated,["g1"]),{
  globalReferenceIds:["g1"],
  shotMappings:{"1":{mode:"ADD",refs:["s1"],leadInSeconds:1}},
});

console.log("CORE_MODULES_CHECK_OK");
