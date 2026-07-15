"use strict";

const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const {spawnSync}=require("node:child_process");

const root=path.resolve(__dirname,"..");
const required=[
  "main.cjs","preload.cjs","export-preload.cjs","exporter.cjs","render-spec.cjs","LICENSE","README.md","CUSTOMIZING.md","CONTRIBUTING.md","SECURITY.md","CHANGELOG.md","ROADMAP.md",
  "job-lifecycle.cjs","video-lifecycle.cjs","timeline-reconcile.cjs",
  "src/core/xmeml-parser.js","src/core/primary-timeline.js","src/core/shot-model.js","src/core/reference-mapping.js",
  "src/layouts/classic/tokens.css","src/layouts/classic/classic.css",
  "scripts/check-core-modules.cjs","scripts/check-job-lifecycle.cjs","scripts/check-video-lifecycle.cjs","scripts/check-timeline-reconcile.cjs","scripts/run-smoke.cjs","scripts/create-public-tree.cjs",
  "src/index.html","src/mvp-app.js","src/output-preview.html",
  "src/export-dialog.html","src/export-dialog.js",
  "current-job/source","current-job/references","current-job/output","current-job/logs",
  "fixtures/premiere-export-kit/public-fixture/premiere-synthetic.xml",
  "fixtures/premiere-export-kit/public-fixture/premiere-synthetic-final.mp4",
  "fixtures/premiere-export-kit/public-fixture/SOURCE_NOTES.md",
  "docs/XML_COMPATIBILITY.md","docs/CLASSIC_LAYOUT.md","src/layouts/classic/README.md",".github/pull_request_template.md",".github/ISSUE_TEMPLATE/bug_report.yml",".github/ISSUE_TEMPLATE/layout_proposal.yml",
];
for(const relative of required){
  if(!fs.existsSync(path.join(root,relative)))throw new Error("Missing: "+relative);
}
for(const relative of [
  "main.cjs","preload.cjs","export-preload.cjs","exporter.cjs","render-spec.cjs",
  "job-lifecycle.cjs","video-lifecycle.cjs","timeline-reconcile.cjs",
  "src/core/xmeml-parser.js","src/core/primary-timeline.js","src/core/shot-model.js","src/core/reference-mapping.js",
  "scripts/check-core-modules.cjs","scripts/check-job-lifecycle.cjs","scripts/check-video-lifecycle.cjs","scripts/check-timeline-reconcile.cjs","scripts/run-smoke.cjs","scripts/create-public-tree.cjs",
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
for(const marker of ["./layouts/classic/tokens.css","./layouts/classic/classic.css","./core/xmeml-parser.js","./core/primary-timeline.js","./core/shot-model.js","function build(rawData)","window.portablePreview","setRenderSpec","inspectXml(text)","clearVideo(){ return clearVideoSource(); }","releaseMedia","id=\"videoCallout\"","function updateVideoCallout","setCalloutConfig",">EDIT WORKFLOW<"]){
  if(!preview.includes(marker))throw new Error("Parser bridge marker missing: "+marker);
}
if(/<style(?:\s|>)/i.test(preview))throw new Error("Classic preview CSS returned to inline HTML");
const editor=fs.readFileSync(path.join(root,"src/index.html"),"utf8");
if(!editor.includes('id="overlayProjectTitle"'))throw new Error("Project title editor missing");
if(!editor.includes('id="calloutSettings"'))throw new Error("Callout settings missing");
if(editor.includes("calloutTool"))throw new Error("Removed callout tool tags returned");
if(!editor.includes('id="resetPreviewTop"'))throw new Error("Preview reset control missing");
if(editor.includes('id="addFilesTop"'))throw new Error("Removed top add-files control returned");
if(/id="overlay(?:LoadXml|Play|Reset)"/.test(editor))throw new Error("Removed overlay transport control returned");
for(const marker of ['class="command inputDropZone"','class="command inputDropZone video"',"./core/reference-mapping.js","loadDroppedXml","loadDroppedVideo","function replaceShots(nextShots,mappings={},emitChange=true)"]){
  if(!editor.includes(marker))throw new Error("Input drop-zone contract missing: "+marker);
}
const main=fs.readFileSync(path.join(root,"main.cjs"),"utf8");
for(const marker of ["PORTABLE_TEST_JOB_ROOT","app:get-render-spec","recoverXmlTransactions","recoverVideoTransactions","commitPreparedXmlUpdate","job:choose-xml-mode","job:commit-xml","job:commit-video","job_save_rejected_stale","job_xml_update_committed","job_reset_committed"]){
  if(!main.includes(marker))throw new Error("Current Job lifecycle marker missing: "+marker);
}
const renderer=fs.readFileSync(path.join(root,"src/mvp-app.js"),"utf8");
for(const marker of ["expectedJobId","expectedRevision","prepareDroppedXml","chooseXmlImportMode","commitXmlImport","prepareDroppedVideo","commitVideo","loadDroppedVideo"]){
  if(!renderer.includes(marker))throw new Error("Renderer lifecycle marker missing: "+marker);
}
const currentJobPath=path.join(root,"current-job","job.json");
const currentJobBefore=fs.existsSync(currentJobPath)?fs.readFileSync(currentJobPath):null;
for(const [script,successMarker] of [
  ["check-core-modules.cjs","CORE_MODULES_CHECK_OK"],
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
const packageJson=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
if(packageJson.version!=="0.1.0-beta.1"||packageJson.license!=="MIT")throw new Error("Public beta package metadata is incomplete");
if(packageJson.devDependencies?.electron!=="43.1.1")throw new Error("Electron must stay pinned to the tested version");
if(!String(packageJson.scripts?.smoke||"").includes("run-smoke.cjs"))throw new Error("Smoke is not routed through the isolated runner");
const license=fs.readFileSync(path.join(root,"LICENSE"),"utf8");
if(!license.includes("MIT License")||!license.includes("Copyright (c) 2026 ch5p"))throw new Error("MIT License is incomplete");
for(const relative of ["README.md","CUSTOMIZING.md","CONTRIBUTING.md","SECURITY.md","CHANGELOG.md","ROADMAP.md","docs/XML_COMPATIBILITY.md","docs/CLASSIC_LAYOUT.md","src/layouts/classic/README.md",".github/pull_request_template.md"]){
  const bytes=fs.readFileSync(path.join(root,relative));
  if(bytes.length<3||bytes[0]!==0xef||bytes[1]!==0xbb||bytes[2]!==0xbf)throw new Error("Markdown must use UTF-8 BOM: "+relative);
}
for(const relative of ["src/index.html","src/output-preview.html","src/mvp-app.js"]){
  const content=fs.readFileSync(path.join(root,relative),"utf8");
  if(/[A-Za-z]:[\\/]+Users[\\/]+/i.test(content)||/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(content)){
    throw new Error("Private path or email found in public UI source: "+relative);
  }
}
const sourceNotes=fs.readFileSync(path.join(root,"fixtures","premiere-export-kit","public-fixture","SOURCE_NOTES.md"),"utf8");
for(const marker of ["Premiere Pro 2026","26.2.2","Build 3","Passed","MIT License"]){
  if(!sourceNotes.includes(marker))throw new Error("Fixture provenance marker missing: "+marker);
}
for(const relative of ["main.cjs","preload.cjs","export-preload.cjs","exporter.cjs","job-lifecycle.cjs","video-lifecycle.cjs","timeline-reconcile.cjs","src/index.html","src/mvp-app.js","src/export-dialog.html","src/export-dialog.js"]){
  const content=fs.readFileSync(path.join(root,relative),"utf8");
  if(/[A-Za-z]:[\\/]+Users[\\/]+/i.test(content))throw new Error("Non-portable absolute path: "+relative);
}
console.log("CHECK_OK portable paths, JavaScript syntax, parser bridge, drop zones, XML/video transactions, timeline reconcile, fixtures");
