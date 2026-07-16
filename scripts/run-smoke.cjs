"use strict";

const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {randomUUID}=require("node:crypto");
const {spawnSync}=require("node:child_process");

const root=path.resolve(__dirname,"..");
const fixtureRoot=path.join(root,"fixtures","premiere-export-kit","public-fixture");
const fixtureXml=path.join(fixtureRoot,"premiere-synthetic.xml");
const fixtureVideo=path.join(fixtureRoot,"premiere-synthetic-final.mp4");
const temporaryRoot=fs.mkdtempSync(path.join(os.tmpdir(),"character-workflow-smoke-"));
const jobRoot=path.join(temporaryRoot,"current-job");
const invalidVideo=path.join(temporaryRoot,"invalid-video.mp4");
const exportMode=process.argv.includes("--export");

function prepareExportJob(){
  const sourceRoot=path.join(jobRoot,"source");
  for(const directory of [sourceRoot,path.join(jobRoot,"references"),path.join(jobRoot,"output"),path.join(jobRoot,"logs")]){
    fs.mkdirSync(directory,{recursive:true});
  }
  const xmlName="premiere-synthetic.xml";
  const videoName="premiere-synthetic-final.mp4";
  fs.copyFileSync(fixtureXml,path.join(sourceRoot,xmlName));
  fs.copyFileSync(fixtureVideo,path.join(sourceRoot,videoName));
  const now=new Date().toISOString();
  const job={
    version:1,
    jobId:randomUUID(),
    revision:1,
    createdAt:now,
    updatedAt:now,
    xml:{name:xmlName,relativePath:"source/"+xmlName},
    video:{name:videoName,relativePath:"source/"+videoName},
    references:[],
    globalReferenceIds:[],
    shotMappings:{},
    timelineShots:[],
    orphanedShotMappings:[],
    projectTitle:"SYNTHETIC TIMELINE",
    callout:{enabled:true,position:"left",style:"line",startSeconds:.08,durationSeconds:3.5,subtitle:"REFERENCE MAP · EDIT WORKFLOW"},
    ui:{scale:1.25},
    output:{codec:"h264",bitrateMbps:12,fps:60},
  };
  fs.writeFileSync(path.join(jobRoot,"job.json"),JSON.stringify(job,null,2),"utf8");
}

function safeCleanup(){
  const tempBase=path.resolve(os.tmpdir());
  const resolved=path.resolve(temporaryRoot);
  const relative=path.relative(tempBase,resolved);
  if(!relative||relative.startsWith("..")||path.isAbsolute(relative)){
    throw new Error("Refusing to remove non-temporary smoke root: "+resolved);
  }
  fs.rmSync(resolved,{recursive:true,force:true});
}

let result;
try{
  fs.writeFileSync(invalidVideo,"not a playable video","utf8");
  if(exportMode)prepareExportJob();
  const electronPath=require("electron");
  const env={
    ...process.env,
    PORTABLE_TEST_JOB_ROOT:jobRoot,
    PORTABLE_SMOKE_XML:fixtureXml,
    PORTABLE_SMOKE_VIDEO:fixtureVideo,
    PORTABLE_SMOKE_INVALID_VIDEO:invalidVideo,
  };
  if(exportMode)env.PORTABLE_EXPORT_TEST_SECONDS=process.env.PORTABLE_EXPORT_TEST_SECONDS||"1";
  result=spawnSync(electronPath,[root,exportMode?"--export-smoke":"--smoke-test"],{
    cwd:root,
    env,
    encoding:"utf8",
    windowsHide:true,
    maxBuffer:16*1024*1024,
    timeout:exportMode?120000:60000,
  });
  if(result.stdout)process.stdout.write(result.stdout);
  if(result.stderr)process.stderr.write(result.stderr);
  if(result.error?.code==="ETIMEDOUT")throw new Error((exportMode?"Export smoke":"Smoke")+" timed out");
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error((exportMode?"Export smoke":"Smoke")+" failed with exit code "+result.status);
  const marker=exportMode?"EXPORT_SMOKE_OK":"SMOKE_OK";
  if(!String(result.stdout||"").includes(marker))throw new Error(marker+" marker missing");
}finally{
  safeCleanup();
}
