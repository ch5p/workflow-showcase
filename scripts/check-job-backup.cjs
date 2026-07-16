"use strict";

const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {createJobBackup}=require("../job-backup.cjs");

const tempRoot=fs.mkdtempSync(path.join(os.tmpdir(),"workflow-showcase-backup-"));
try{
  const appRoot=path.join(tempRoot,"app");
  const jobRoot=path.join(appRoot,"current-job");
  const sourceRoot=path.join(jobRoot,"source");
  const referencesRoot=path.join(jobRoot,"references");
  fs.mkdirSync(sourceRoot,{recursive:true});
  fs.mkdirSync(referencesRoot,{recursive:true});
  fs.writeFileSync(path.join(sourceRoot,"timeline.xml"),"<xmeml />","utf8");
  fs.writeFileSync(path.join(sourceRoot,"video.mp4"),Buffer.from("video"));
  fs.writeFileSync(path.join(referencesRoot,"image-01.png"),Buffer.from("image"));
  const job={
    version:1,jobId:"test-job",revision:7,
    xml:{relativePath:"source/timeline.xml"},video:{relativePath:"source/video.mp4"},
    references:[{relativePath:"references/image-01.png"}],
  };
  const jobPath=path.join(jobRoot,"job.json");
  fs.writeFileSync(jobPath,JSON.stringify(job),"utf8");
  const result=createJobBackup({
    appRoot,jobRoot,sourceRoot,referencesRoot,jobPath,job,
    now:new Date(2026,6,17,14,32,8),
  });
  assert.equal(result.backupName,"2026-07-17_14-32-08");
  assert.equal(result.fileCount,3);
  const snapshotRoot=path.join(appRoot,"backup",result.backupName);
  assert.equal(fs.readFileSync(path.join(snapshotRoot,"source","timeline.xml"),"utf8"),"<xmeml />");
  assert.equal(fs.readFileSync(path.join(snapshotRoot,"references","image-01.png"),"utf8"),"image");
  assert.equal(fs.existsSync(path.join(snapshotRoot,"source","video.mp4")),false,"Source video must not be duplicated into settings backups");
  assert.equal(fs.existsSync(path.join(snapshotRoot,"output")),false,"Exports must not be duplicated into manual backups");
  const manifest=JSON.parse(fs.readFileSync(path.join(snapshotRoot,"manifest.json"),"utf8"));
  assert.equal(manifest.scope,"settings-references-and-timeline");
  assert.equal(manifest.jobId,"test-job");
  assert.equal(manifest.revision,7);
  assert.deepEqual(manifest.excluded,["source/video","output","logs"]);
  assert.equal(manifest.files.length,3);

  const broken={...job,references:[{relativePath:"references/missing.png"}]};
  assert.throws(()=>createJobBackup({appRoot,jobRoot,sourceRoot,referencesRoot,jobPath,job:broken,now:new Date(2026,6,17,14,33,8)}));
  assert.equal(fs.existsSync(path.join(appRoot,"backup","2026-07-17_14-33-08")),false,"A failed backup must not leave a final snapshot");
  console.log("JOB_BACKUP_CHECK_OK");
}finally{
  fs.rmSync(tempRoot,{recursive:true,force:true,maxRetries:2});
}
