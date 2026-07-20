"use strict";

const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {
  parseCapCutDraft,
  createCapCutSnapshot,
  parseCapCutSnapshot,
}=require("../src/adapters/capcut-draft-parser.js");
const {
  prepareCapCutCandidate,
  commitPreparedTimeline,
  commitPreparedTimelineUpdate,
}=require("../job-lifecycle.cjs");
const {resolveTimelineInput,timelineJobFields,createTimelineRecord}=require("../timeline-input.cjs");
const {buildPrimarySegments}=require("../src/core/primary-timeline.js");
const {inspectTimeline}=require("../src/core/shot-model.js");

const fixturePath=path.join(__dirname,"..","fixtures","capcut-9x","public-fixture","draft_content.json");
const fixtureText=fs.readFileSync(fixturePath,"utf8");
const timeline=parseCapCutDraft(fixtureText,{projectName:"workflow-showcase-test"});

assert.equal(timeline.fps,24);
assert.equal(timeline.duration,186);
assert.equal(timeline.name,"workflow-showcase-test");
assert.equal(timeline.clips.length,4);
assert.equal(timeline.clips[0].sourceId,timeline.clips[2].sourceId);
assert.notEqual(timeline.clips[0].sourceId,timeline.clips[1].sourceId);
assert.equal(timeline.clips.some(clip=>/[\\/](?:users|home)[\\/]/i.test(clip.sourceId)),false);

const primary=buildPrimarySegments(timeline);
assert.deepEqual(primary.map(segment=>[segment.start,segment.end,segment.clip.name]),[
  [0,50,"clip-a.mp4"],
  [50,108,"clip-c.mp4"],
  [108,147,"clip-b.mp4"],
  [147,186,"clip-a.mp4"],
]);

const inspection=inspectTimeline(timeline);
assert.equal(inspection.edits,4);
assert.equal(inspection.shots.length,3);
assert.deepEqual(inspection.shots.map(shot=>shot.edits),[2,1,1]);

const snapshot=createCapCutSnapshot(fixtureText,{
  projectName:"workflow-showcase-test",
  sourceName:"draft_content.json",
});
const snapshotText=JSON.stringify(snapshot);
assert.equal(snapshot.format,"capcut-draft");
assert.equal(snapshot.editorVersion,"9.0.0");
assert.equal(snapshotText.includes("media/clip-a.mp4"),false);
assert.equal(snapshotText.includes("device_id"),false);
assert.deepEqual(parseCapCutSnapshot(snapshotText),timeline);
assert.deepEqual(resolveTimelineInput({xml:{name:"legacy.xml",relativePath:"source/timeline.xml"}}),{
  format:"xmeml",name:"legacy.xml",relativePath:"source/timeline.xml",editorVersion:undefined,
});
assert.deepEqual(timelineJobFields(createTimelineRecord("capcut-draft","workflow-showcase-test",{editorVersion:"9.0.0"})),{
  timelineInput:{format:"capcut-draft",name:"workflow-showcase-test",relativePath:"source/timeline.capcut.json",editorVersion:"9.0.0"},
  xml:null,
});

assert.throws(()=>parseCapCutDraft("{"),/not valid JSON/);
const unsupported=JSON.parse(fixtureText);
unsupported.platform.app_version="10.0.0";
assert.throws(()=>parseCapCutDraft(JSON.stringify(unsupported)),/Unsupported CapCut Desktop version/);

const transactionRoot=fs.mkdtempSync(path.join(os.tmpdir(),"workflow-showcase-capcut-"));
try{
  const inputRoot=path.join(transactionRoot,"input");
  const logRoot=path.join(transactionRoot,"job","logs");
  const sourceRoot=path.join(transactionRoot,"job","source");
  const referencesRoot=path.join(transactionRoot,"job","references");
  const jobPath=path.join(transactionRoot,"job","job.json");
  for(const directory of [inputRoot,logRoot,sourceRoot,referencesRoot])fs.mkdirSync(directory,{recursive:true});
  const rawPath=path.join(inputRoot,"draft_content.json");
  fs.writeFileSync(rawPath,fixtureText,"utf8");
  fs.writeFileSync(path.join(sourceRoot,"timeline.xml"),"<xmeml version=\"5\"/>","utf8");
  fs.writeFileSync(path.join(sourceRoot,"video.mp4"),"previous-video","utf8");
  fs.writeFileSync(path.join(referencesRoot,"previous-reference.png"),"previous-reference","utf8");
  fs.writeFileSync(jobPath,JSON.stringify({
    version:1,jobId:"previous-xmeml-job",revision:4,
    xml:{name:"previous.xml",relativePath:"source/timeline.xml"},
    video:{name:"previous.mp4",relativePath:"source/video.mp4"},
    references:[{id:"previous-ref",type:"image",name:"previous-reference.png",relativePath:"references/previous-reference.png"}],
  }),"utf8");
  const snapshotText=JSON.stringify(snapshot,null,2)+"\n";
  const preparation=prepareCapCutCandidate({
    sourcePath:rawPath,logRoot,inputMethod:"test",candidateText:snapshotText,displayName:"workflow-showcase-test",
  });
  assert.equal(path.basename(preparation.candidatePath),"candidate.capcut.json");
  const firstJob={version:1,jobId:"capcut-job",revision:1,timelineInput:{
    format:"capcut-draft",name:"workflow-showcase-test",relativePath:"source/timeline.capcut.json",editorVersion:"9.0.0",
  },xml:null};
  const installed=commitPreparedTimeline({preparation,sourceRoot,referencesRoot,jobPath,nextJob:firstJob});
  const installedPath=path.join(sourceRoot,"timeline.capcut.json");
  assert.equal(fs.readFileSync(installedPath,"utf8"),snapshotText);
  assert.equal(installed.removedSourceCount,2);
  assert.equal(installed.removedReferenceCount,1);
  assert.equal(fs.existsSync(path.join(sourceRoot,"timeline.xml")),false);
  assert.equal(fs.existsSync(path.join(sourceRoot,"video.mp4")),false);
  assert.deepEqual(fs.readdirSync(referencesRoot),[]);
  fs.writeFileSync(path.join(sourceRoot,"video.mp4"),"fixture-video","utf8");

  const updateSnapshot={...snapshot,sourceName:"draft_content.json",timeline:{...snapshot.timeline,name:"updated-capcut-project"}};
  const updateText=JSON.stringify(updateSnapshot,null,2)+"\n";
  const updatePreparation=prepareCapCutCandidate({
    sourcePath:rawPath,logRoot,inputMethod:"test-update",candidateText:updateText,displayName:"updated-capcut-project",
  });
  commitPreparedTimelineUpdate({
    preparation:updatePreparation,sourceRoot,referencesRoot,jobPath,
    nextJob:{...firstJob,revision:2,timelineInput:{...firstJob.timelineInput,name:"updated-capcut-project"}},
  });
  assert.equal(fs.readFileSync(installedPath,"utf8"),updateText);
  assert.equal(fs.readFileSync(path.join(sourceRoot,"video.mp4"),"utf8"),"fixture-video");
}finally{
  fs.rmSync(transactionRoot,{recursive:true,force:true});
}

console.log("CAPCUT_ADAPTER_CHECK_OK");
