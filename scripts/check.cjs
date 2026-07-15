"use strict";

const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const {spawnSync}=require("node:child_process");

const root=path.resolve(__dirname,"..");
const required=[
  "main.cjs","preload.cjs","export-preload.cjs","exporter.cjs","src/index.html","src/mvp-app.js","src/output-preview.html",
  "src/export-dialog.html","src/export-dialog.js",
  "current-job/source","current-job/references","current-job/output","current-job/logs",
];
for(const relative of required){
  if(!fs.existsSync(path.join(root,relative)))throw new Error("Missing: "+relative);
}
for(const relative of ["main.cjs","preload.cjs","export-preload.cjs","exporter.cjs","src/mvp-app.js","src/export-dialog.js"]){
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
for(const marker of ["function parseFCPXML","function build(rawData)","window.portablePreview","id=\"videoCallout\"","function updateVideoCallout","setCalloutConfig",">EDIT WORKFLOW<"]){
  if(!preview.includes(marker))throw new Error("Parser bridge marker missing: "+marker);
}
const editor=fs.readFileSync(path.join(root,"src/index.html"),"utf8");
if(!editor.includes('id="overlayProjectTitle"'))throw new Error("Project title editor missing");
if(!editor.includes('id="calloutSettings"'))throw new Error("Callout settings missing");
if(editor.includes("calloutTool"))throw new Error("Removed callout tool tags returned");
if(!editor.includes('id="resetPreviewTop"'))throw new Error("Preview reset control missing");
if(editor.includes('id="addFilesTop"'))throw new Error("Removed top add-files control returned");
if(/id="overlay(?:LoadXml|Play|Reset)"/.test(editor))throw new Error("Removed overlay transport control returned");
for(const relative of ["main.cjs","preload.cjs","export-preload.cjs","exporter.cjs","src/index.html","src/mvp-app.js","src/export-dialog.html","src/export-dialog.js"]){
  const content=fs.readFileSync(path.join(root,relative),"utf8");
  if(/C:\\Users\\/i.test(content))throw new Error("Non-portable absolute path: "+relative);
}
console.log("CHECK_OK portable paths, JavaScript syntax, parser bridge, job folders");
