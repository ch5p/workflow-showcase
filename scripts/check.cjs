"use strict";

const fs=require("node:fs");
const crypto=require("node:crypto");
const path=require("node:path");
const vm=require("node:vm");
const {spawnSync}=require("node:child_process");

const root=path.resolve(__dirname,"..");
const required=[
  "main.cjs","preload.cjs","export-preload.cjs","exporter.cjs","render-spec.cjs","LICENSE","AGENTS.md","README.md","README.ko.md","CUSTOMIZING.md","CUSTOMIZING.ko.md","CONTRIBUTING.md","SECURITY.md","CHANGELOG.md","ROADMAP.md",
  "durable-file.cjs","owned-path.cjs","job-lifecycle.cjs","video-lifecycle.cjs","timeline-reconcile.cjs",
  "src/core/xmeml-parser.js","src/core/primary-timeline.js","src/core/shot-model.js","src/core/reference-mapping.js",
  "src/layouts/classic/tokens.css","src/layouts/classic/classic.css",
  "scripts/check-core-modules.cjs","scripts/check-job-lifecycle.cjs","scripts/check-video-lifecycle.cjs","scripts/check-timeline-reconcile.cjs","scripts/check-runtime-safety.cjs","scripts/run-smoke.cjs","scripts/create-public-tree.cjs","scripts/git-hooks/pre-commit",
  "src/index.html","src/mvp-app.js","src/output-preview.html",
  "src/export-dialog.html","src/export-dialog.js",
  "current-job/source","current-job/references","current-job/output","current-job/logs",
  "fixtures/premiere-export-kit/public-fixture/premiere-synthetic.xml",
  "fixtures/premiere-export-kit/public-fixture/premiere-synthetic-final.mp4",
  "fixtures/premiere-export-kit/public-fixture/SOURCE_NOTES.md",
  "docs/XML_COMPATIBILITY.md","docs/CLASSIC_LAYOUT.md","docs/CUSTOMIZING_WITH_AI.md","docs/CUSTOMIZING_WITH_AI.ko.md","docs/PROJECT_MAP.md","src/layouts/classic/README.md",".github/pull_request_template.md",".github/ISSUE_TEMPLATE/bug_report.yml",".github/ISSUE_TEMPLATE/layout_proposal.yml",
];
for(const relative of required){
  if(!fs.existsSync(path.join(root,relative)))throw new Error("Missing: "+relative);
}
for(const relative of [
  "main.cjs","preload.cjs","export-preload.cjs","exporter.cjs","render-spec.cjs",
  "durable-file.cjs","owned-path.cjs","job-lifecycle.cjs","video-lifecycle.cjs","timeline-reconcile.cjs",
  "src/core/xmeml-parser.js","src/core/primary-timeline.js","src/core/shot-model.js","src/core/reference-mapping.js",
  "scripts/check-core-modules.cjs","scripts/check-job-lifecycle.cjs","scripts/check-video-lifecycle.cjs","scripts/check-timeline-reconcile.cjs","scripts/check-runtime-safety.cjs","scripts/run-smoke.cjs","scripts/create-public-tree.cjs",
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
for(const marker of ["./layouts/classic/tokens.css","./layouts/classic/classic.css","./core/xmeml-parser.js","./core/primary-timeline.js","./core/shot-model.js","function build(rawData)","window.portablePreview","setRenderSpec","inspectXml(text)","clearVideo(){ return clearVideoSource(); }","releaseMedia","preflightVideo","routeDroppedFiles","id=\"videoCallout\"","class=\"videoCalloutEyebrow\"","function updateVideoCallout","setCalloutConfig"]){
  if(!preview.includes(marker))throw new Error("Parser bridge marker missing: "+marker);
}
if(/<style(?:\s|>)/i.test(preview))throw new Error("Classic preview CSS returned to inline HTML");
const editor=fs.readFileSync(path.join(root,"src/index.html"),"utf8");
if(!editor.includes('id="overlayProjectTitle"'))throw new Error("Project title editor missing");
if(!editor.includes('id="calloutSettings"'))throw new Error("Callout settings missing");
if(editor.includes("calloutTool"))throw new Error("Removed callout tool tags returned");
if(!editor.includes('id="resetPreviewTop"'))throw new Error("Preview reset control missing");
if(!editor.includes('id="reloadCurrentJob"'))throw new Error("Current Job reload control missing");
if(!editor.includes('id="addReferenceFiles"')||!editor.includes("portableMvp?.addReferences"))throw new Error("Reference file picker control missing");
if(editor.includes('id="addFilesTop"'))throw new Error("Removed top add-files control returned");
if(/id="overlay(?:LoadXml|Play|Reset)"/.test(editor))throw new Error("Removed overlay transport control returned");
for(const marker of ['class="command inputDropZone"','class="command inputDropZone video"',"./core/reference-mapping.js","loadDroppedXml","loadDroppedVideo","function replaceShots(nextShots,mappings={},emitChange=true)"]){
  if(!editor.includes(marker))throw new Error("Input drop-zone contract missing: "+marker);
}
const main=fs.readFileSync(path.join(root,"main.cjs"),"utf8");
for(const marker of ["PORTABLE_TEST_JOB_ROOT","requestSingleInstanceLock","writeTextAtomically","resolveOwnedRelativeFile","app:get-render-spec","app:reload-current-job","recoverXmlTransactions","recoverVideoTransactions","commitPreparedXmlUpdate","job:choose-xml-mode","job:commit-xml","job:commit-video","candidateUrl","job_save_rejected_stale","job_xml_update_committed","job_reset_committed"]){
  if(!main.includes(marker))throw new Error("Current Job lifecycle marker missing: "+marker);
}
if(!main.includes("await runSecondarySmoke()")||main.includes("const secondary = spawnSync"))throw new Error("Single-instance smoke must keep the primary event loop available");
if(!main.includes("readyMessage")||!main.includes("mustExist: true"))throw new Error("Export readiness file check missing");
if(preview.includes("DURATION Δ"))throw new Error("Unimplemented duration warning returned to help text");
const renderer=fs.readFileSync(path.join(root,"src/mvp-app.js"),"utf8");
for(const marker of ["expectedJobId","expectedRevision","prepareDroppedXml","chooseXmlImportMode","commitXmlImport","prepareDroppedVideo","commitVideo","preflightVideo","loadDroppedVideo","reloadCurrentJob"]){
  if(!renderer.includes(marker))throw new Error("Renderer lifecycle marker missing: "+marker);
}
const currentJobPath=path.join(root,"current-job","job.json");
function hashIfPresent(filePath){
  return fs.existsSync(filePath)?crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"):null;
}
const currentJobBefore=hashIfPresent(currentJobPath);
for(const [script,successMarker] of [
  ["check-core-modules.cjs","CORE_MODULES_CHECK_OK"],
  ["check-job-lifecycle.cjs","JOB_LIFECYCLE_CHECK_OK"],
  ["check-video-lifecycle.cjs","VIDEO_LIFECYCLE_CHECK_OK"],
  ["check-timeline-reconcile.cjs","TIMELINE_RECONCILE_OK"],
  ["check-runtime-safety.cjs","RUNTIME_SAFETY_CHECK_OK"],
]){
  const lifecycleCheck=spawnSync(process.execPath,[path.join(root,"scripts",script)],{encoding:"utf8"});
  if(lifecycleCheck.status!==0)throw new Error(script+" failed\n"+lifecycleCheck.stdout+"\n"+lifecycleCheck.stderr);
  if(!lifecycleCheck.stdout.includes(successMarker))throw new Error(script+" did not report success");
}
const currentJobAfter=hashIfPresent(currentJobPath);
const currentJobUnchanged=currentJobBefore===currentJobAfter;
if(!currentJobUnchanged){
  throw new Error("Job lifecycle check touched current-job/job.json");
}
const packageJson=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
if(packageJson.version!=="0.1.0-beta.2"||packageJson.license!=="MIT")throw new Error("Public beta package metadata is incomplete");
if(packageJson.devDependencies?.electron!=="43.1.1")throw new Error("Electron must stay pinned to the tested version");
if(!String(packageJson.scripts?.smoke||"").includes("run-smoke.cjs"))throw new Error("Smoke is not routed through the isolated runner");
const workflow=fs.readFileSync(path.join(root,".github","workflows","check.yml"),"utf8");
if(!/permissions:\s*[\r\n]+\s+contents:\s*read/.test(workflow)||!/timeout-minutes:\s*\d+/.test(workflow)){
  throw new Error("GitHub check workflow must be read-only and time-bounded");
}
const license=fs.readFileSync(path.join(root,"LICENSE"),"utf8");
if(!license.includes("MIT License")||!license.includes("Copyright (c) 2026 ch5p"))throw new Error("MIT License is incomplete");
function collectMarkdownTree(directory,relativeDirectory){
  const found=[];
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const absolute=path.join(directory,entry.name);
    const relative=path.join(relativeDirectory,entry.name).split(path.sep).join("/");
    if(entry.isDirectory())found.push(...collectMarkdownTree(absolute,relative));
    else if(entry.isFile()&&entry.name.toLowerCase().endsWith(".md"))found.push(relative);
  }
  return found;
}
function collectPublicMarkdown(){
  const rootMarkdown=fs.readdirSync(root,{withFileTypes:true})
    .filter(entry=>entry.isFile()&&entry.name.toLowerCase().endsWith(".md"))
    .map(entry=>entry.name);
  const publicDirectories=[".github","docs","fixtures","scripts","src"];
  return rootMarkdown.concat(publicDirectories.flatMap(relative=>{
    const absolute=path.join(root,relative);
    return fs.existsSync(absolute)?collectMarkdownTree(absolute,relative):[];
  }));
}
const koreanMarkdownWithoutSuffix=new Set([
  "fixtures/premiere-export-kit/PREMIERE_EXPORT_GUIDE.md",
  "fixtures/premiere-export-kit/public-fixture/SOURCE_NOTES.md",
]);
for(const relative of collectPublicMarkdown()){
  if(relative.toLowerCase().endsWith(".en.md")){
    throw new Error("Legacy *.en.md must be replaced by the English default + .ko.md pair: "+relative);
  }
  const bytes=fs.readFileSync(path.join(root,relative));
  const hasBom=bytes.length>=3&&bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf;
  const needsBom=relative.toLowerCase().endsWith(".ko.md")||koreanMarkdownWithoutSuffix.has(relative);
  if(needsBom&&!hasBom)throw new Error("Korean Markdown must use UTF-8 BOM: "+relative);
  if(!needsBom&&hasBom)throw new Error("English/default Markdown must not use a UTF-8 BOM: "+relative);
}
const publicTreeBuilder=fs.readFileSync(path.join(root,"scripts","create-public-tree.cjs"),"utf8");
for(const marker of ["AGENTS.md","README.ko.md","CUSTOMIZING.ko.md","docs/CUSTOMIZING_WITH_AI.ko.md","docs/PROJECT_MAP.md"]){
  if(!publicTreeBuilder.includes('"'+marker+'"'))throw new Error("Public tree contract file missing from manifest: "+marker);
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
for(const relative of ["main.cjs","preload.cjs","export-preload.cjs","exporter.cjs","durable-file.cjs","owned-path.cjs","job-lifecycle.cjs","video-lifecycle.cjs","timeline-reconcile.cjs","scripts/check-runtime-safety.cjs","src/index.html","src/mvp-app.js","src/export-dialog.html","src/export-dialog.js"]){
  const content=fs.readFileSync(path.join(root,relative),"utf8");
  if(/[A-Za-z]:[\\/]+Users[\\/]+/i.test(content))throw new Error("Non-portable absolute path: "+relative);
}
console.log("CHECK_OK portable paths, JavaScript syntax, parser bridge, drop zones, XML/video transactions, timeline reconcile, fixtures");
