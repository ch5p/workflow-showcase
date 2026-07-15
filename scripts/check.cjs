"use strict";

const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const {spawnSync}=require("node:child_process");

const root=path.resolve(__dirname,"..");
const required=[
  "main.cjs","preload.cjs","export-preload.cjs","exporter.cjs",
  "job-lifecycle.cjs","video-lifecycle.cjs","timeline-reconcile.cjs",
  "scripts/check-job-lifecycle.cjs","scripts/check-video-lifecycle.cjs","scripts/check-timeline-reconcile.cjs",
  "src/index.html","src/mvp-app.js","src/output-preview.html",
  "src/export-dialog.html","src/export-dialog.js",
  "current-job/source","current-job/references","current-job/output","current-job/logs",
  "fixtures/premiere-export-kit/public-fixture/premiere-synthetic.xml",
  "fixtures/premiere-export-kit/public-fixture/premiere-synthetic-final.mp4",
  "fixtures/premiere-export-kit/public-fixture/SOURCE_NOTES.md",
];
for(const relative of required){
  if(!fs.existsSync(path.join(root,relative)))throw new Error("Missing: "+relative);
}
for(const relative of [
  "main.cjs","preload.cjs","export-preload.cjs","exporter.cjs",
  "job-lifecycle.cjs","video-lifecycle.cjs","timeline-reconcile.cjs",
  "scripts/check-job-lifecycle.cjs","scripts/check-video-lifecycle.cjs","scripts/check-timeline-reconcile.cjs",
  "src/mvp-app.js","src/export-dialog.js",
]){
  const result=spawnSync(process.execPath,["--check",path.join(root,relative)],{encoding:"utf8"});
  if(result.status!==0)throw new Error(relative+" syntax failed\n"+result.stderr);
}
for(const relative of ["src/index.html","src/output-preview.html","src/export-dialog.html"]){
  const html=fs.readFileSync(path.join(root,relative),"utf8");
  const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match=>match[1]).filter(source=>source.trim());
  scripts.forEach((source,index)=>new vm.Script(source,{filename:relative+"#inline-"+(index+1)}));
}
const preview=fs.readFileSync(path.join(root,"src/output-preview.html"),"utf8");
for(const marker of ["function parseFCPXML","function build(rawData)","window.portablePreview","inspectXml(text)","clearVideo(){ return clearVideoSource(); }","releaseMedia","id=\"videoCallout\"","function updateVideoCallout","setCalloutConfig",">EDIT WORKFLOW<"]){
  if(!preview.includes(marker))throw new Error("Parser bridge marker missing: "+marker);
}
const editor=fs.readFileSync(path.join(root,"src/index.html"),"utf8");
if(!editor.includes('id="overlayProjectTitle"'))throw new Error("Project title editor missing");
if(!editor.includes('id="calloutSettings"'))throw new Error("Callout settings missing");
if(editor.includes("calloutTool"))throw new Error("Removed callout tool tags returned");
if(!editor.includes('id="resetPreviewTop"'))throw new Error("Preview reset control missing");
if(editor.includes('id="addFilesTop"'))throw new Error("Removed top add-files control returned");
if(/id="overlay(?:LoadXml|Play|Reset)"/.test(editor))throw new Error("Removed overlay transport control returned");
for(const marker of ['class="command inputDropZone"','class="command inputDropZone video"',"loadDroppedXml","loadDroppedVideo","function replaceShots(nextShots,mappings={},emitChange=true)"]){
  if(!editor.includes(marker))throw new Error("Input drop-zone contract missing: "+marker);
}
const main=fs.readFileSync(path.join(root,"main.cjs"),"utf8");
for(const marker of ["recoverXmlTransactions","recoverVideoTransactions","commitPreparedXmlUpdate","job:choose-xml-mode","job:commit-xml","job:commit-video","job_save_rejected_stale","job_xml_update_committed","job_reset_committed"]){
  if(!main.includes(marker))throw new Error("Current Job lifecycle marker missing: "+marker);
}
const renderer=fs.readFileSync(path.join(root,"src/mvp-app.js"),"utf8");
for(const marker of ["expectedJobId","expectedRevision","prepareDroppedXml","chooseXmlImportMode","commitXmlImport","prepareDroppedVideo","commitVideo","loadDroppedVideo"]){
  if(!renderer.includes(marker))throw new Error("Renderer lifecycle marker missing: "+marker);
}
const currentJobPath=path.join(root,"current-job","job.json");
const currentJobBefore=fs.existsSync(currentJobPath)?fs.readFileSync(currentJobPath):null;
for(const [script,successMarker] of [
  ["check-job-lifecycle.cjs","JOB_LIFECYCLE_CHECK_OK"],
  ["check-video-lifecycle.cjs","VIDEO_LIFECYCLE_CHECK_OK"],
  ["check-timeline-reconcile.cjs","TIMELINE_RECONCILE_OK"],
]){
  const lifecycleCheck=spawnSync(process.execPath,[path.join(root,"scripts",script)],{encoding:"utf8"});
  if(lifecycleCheck.status!==0)throw new Error(script+" failed\n"+lifecycleCheck.stdout+"\n"+lifecycleCheck.stderr);
  if(!lifecycleCheck.stdout.includes(successMarker))throw new Error(script+" did not report success");
}
const currentJobAfter=fs.existsSync(currentJobPath)?fs.readFileSync(currentJobPath):null;
const currentJobUnchanged=currentJobBefore===null
  ? currentJobAfter===null
  : Buffer.isBuffer(currentJobAfter)&&currentJobBefore.equals(currentJobAfter);
if(!currentJobUnchanged){
  throw new Error("Job lifecycle check touched current-job/job.json");
}
const sourceNotes=fs.readFileSync(path.join(root,"fixtures","premiere-export-kit","public-fixture","SOURCE_NOTES.md"),"utf8");
for(const marker of ["Premiere Pro 2026","26.2.2","Build 3","Pending"]){
  if(!sourceNotes.includes(marker))throw new Error("Fixture provenance marker missing: "+marker);
}
for(const relative of ["main.cjs","preload.cjs","export-preload.cjs","exporter.cjs","job-lifecycle.cjs","video-lifecycle.cjs","timeline-reconcile.cjs","src/index.html","src/mvp-app.js","src/export-dialog.html","src/export-dialog.js"]){
  const content=fs.readFileSync(path.join(root,relative),"utf8");
  if(/C:\\Users\\/i.test(content))throw new Error("Non-portable absolute path: "+relative);
}
console.log("CHECK_OK portable paths, JavaScript syntax, parser bridge, drop zones, XML/video transactions, timeline reconcile, fixtures");
