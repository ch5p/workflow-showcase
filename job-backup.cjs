"use strict";

const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { fsyncExistingFile } = require("./durable-file.cjs");
const { assertDirectoryNoLink, ensureDirectoryNoLink, resolveOwnedRelativeFile } = require("./owned-path.cjs");
const { resolveTimelineInput } = require("./timeline-input.cjs");

function inside(rootPath, candidatePath){
  const relative=path.relative(path.resolve(rootPath),path.resolve(candidatePath));
  return Boolean(relative)&&!relative.startsWith("..")&&!path.isAbsolute(relative);
}

function hashFile(filePath){
  const hash=createHash("sha256");
  const buffer=Buffer.allocUnsafe(1024*1024);
  const descriptor=fs.openSync(filePath,"r");
  try{
    let position=0;
    while(true){
      const bytesRead=fs.readSync(descriptor,buffer,0,buffer.length,position);
      if(!bytesRead)break;
      hash.update(buffer.subarray(0,bytesRead));
      position+=bytesRead;
    }
  }finally{fs.closeSync(descriptor)}
  return hash.digest("hex");
}

function assertRegularFile(filePath,label){
  const stat=fs.lstatSync(filePath);
  if(stat.isSymbolicLink()||!stat.isFile())throw new Error(label+" must be a regular file");
  return stat;
}

function formatBackupName(now){
  const pad=value=>String(value).padStart(2,"0");
  return now.getFullYear()+"-"+pad(now.getMonth()+1)+"-"+pad(now.getDate())+"_"+
    pad(now.getHours())+"-"+pad(now.getMinutes())+"-"+pad(now.getSeconds());
}

function ensureSnapshotParent(snapshotRoot,relativePath){
  const parentRelative=path.relative(snapshotRoot,path.dirname(path.resolve(snapshotRoot,relativePath)));
  if(parentRelative&&(!inside(snapshotRoot,path.dirname(path.resolve(snapshotRoot,relativePath))))){
    throw new Error("Backup destination escapes the snapshot root");
  }
  let current=snapshotRoot;
  for(const part of parentRelative.split(path.sep).filter(Boolean)){
    current=ensureDirectoryNoLink(path.join(current,part),"Backup snapshot directory");
  }
}

function copyVerifiedFile(sourcePath,snapshotRoot,relativePath){
  if(typeof relativePath!=="string"||!relativePath||path.isAbsolute(relativePath)){
    throw new Error("Backup relative path is invalid");
  }
  const destination=path.resolve(snapshotRoot,relativePath);
  if(!inside(snapshotRoot,destination))throw new Error("Backup destination escapes the snapshot root");
  const sourceStat=assertRegularFile(sourcePath,"Backup source");
  ensureSnapshotParent(snapshotRoot,relativePath);
  fs.copyFileSync(sourcePath,destination,fs.constants.COPYFILE_EXCL);
  const destinationStat=assertRegularFile(destination,"Backup copy");
  const sourceHash=hashFile(sourcePath);
  const destinationHash=hashFile(destination);
  if(sourceStat.size!==destinationStat.size||sourceHash!==destinationHash){
    throw new Error("Backup copy verification failed: "+relativePath);
  }
  fsyncExistingFile(destination);
  return {relativePath,bytes:sourceStat.size,sha256:sourceHash};
}

function storedJobFiles(job,{jobRoot,sourceRoot,referencesRoot}){
  const files=[];
  const seen=new Set();
  const add=(relativePath,ownedRoot,label)=>{
    if(!relativePath)return;
    if(seen.has(relativePath))throw new Error("Duplicate Current Job backup path: "+relativePath);
    seen.add(relativePath);
    files.push({
      relativePath,
      absolutePath:resolveOwnedRelativeFile({jobRoot,ownedRoot,relativePath,label,mustExist:true}),
    });
  };
  const timelineInput=resolveTimelineInput(job);
  if(timelineInput?.relativePath)add(timelineInput.relativePath,sourceRoot,"backup timeline");
  for(const reference of Array.isArray(job.references)?job.references:[]){
    if(!reference?.relativePath)throw new Error("Backup reference relativePath is missing");
    add(reference.relativePath,referencesRoot,"backup reference");
  }
  return files;
}

function snapshotDirectory(backupRoot,baseName){
  let suffix=1;
  while(true){
    const name=suffix===1?baseName:baseName+"-"+String(suffix).padStart(2,"0");
    const candidate=path.join(backupRoot,name);
    if(!fs.existsSync(candidate))return {name,path:candidate};
    suffix++;
  }
}

function cleanupStaging(stagingPath){
  if(!stagingPath||!fs.existsSync(stagingPath))return;
  const stat=fs.lstatSync(stagingPath);
  if(stat.isSymbolicLink()||!stat.isDirectory())return;
  fs.rmSync(stagingPath,{recursive:true,force:true,maxRetries:2});
}

function createJobBackup({appRoot,jobRoot,sourceRoot,referencesRoot,jobPath,job,now=new Date()}={}){
  if(!job||typeof job!=="object")throw new Error("Current Job is not available for backup");
  assertDirectoryNoLink(appRoot,"App root");
  assertDirectoryNoLink(jobRoot,"Current Job");
  assertDirectoryNoLink(sourceRoot,"Current Job source");
  assertDirectoryNoLink(referencesRoot,"Current Job references");
  const backupRoot=ensureDirectoryNoLink(path.join(appRoot,"backup"),"Manual backup root");
  const stagePath=path.join(backupRoot,".manual-backup-"+randomUUID()+".partial");
  let finalSnapshot=null;
  try{
    fs.mkdirSync(stagePath,{recursive:false});
    assertDirectoryNoLink(stagePath,"Manual backup staging");
    const files=[copyVerifiedFile(jobPath,stagePath,"job.json")];
    for(const entry of storedJobFiles(job,{jobRoot,sourceRoot,referencesRoot})){
      files.push(copyVerifiedFile(entry.absolutePath,stagePath,entry.relativePath));
    }
    const manifest={
      version:2,
      scope:"settings-references-and-timeline",
      createdAt:now.toISOString(),
      jobId:String(job.jobId||""),
      revision:Number(job.revision)||0,
      excluded:["source/video","output","logs"],
      files,
    };
    const manifestPath=path.join(stagePath,"manifest.json");
    fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+"\n","utf8");
    fsyncExistingFile(manifestPath);
    finalSnapshot=snapshotDirectory(backupRoot,formatBackupName(now));
    fs.renameSync(stagePath,finalSnapshot.path);
    return {
      backupName:finalSnapshot.name,
      fileCount:files.length,
      bytes:files.reduce((total,file)=>total+file.bytes,0),
    };
  }catch(error){
    cleanupStaging(stagePath);
    throw error;
  }
}

module.exports={createJobBackup,formatBackupName};
