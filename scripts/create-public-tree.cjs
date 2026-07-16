"use strict";

const crypto=require("node:crypto");
const fs=require("node:fs");
const path=require("node:path");
const {spawnSync}=require("node:child_process");

const root=path.resolve(__dirname,"..");
const releaseRoot=path.join(root,"release");
const target=path.resolve(process.argv[2]||path.join(releaseRoot,"workflow-showcase"));
const relativeTarget=path.relative(releaseRoot,target);
if(!relativeTarget||relativeTarget.startsWith("..")||path.isAbsolute(relativeTarget)){
  throw new Error("Public tree target must be a dedicated directory inside release/.");
}
if(fs.existsSync(target)&&fs.readdirSync(target).length){
  throw new Error("Public tree target is not empty: "+target);
}
fs.mkdirSync(target,{recursive:true});

const rootFiles=[
  ".gitattributes",".gitignore","AGENTS.md","CHANGELOG.md","CONTRIBUTING.md","CUSTOMIZING.md","CUSTOMIZING.ko.md","LICENSE","README.md","README.ko.md","ROADMAP.md","SECURITY.md","START_APP.cmd",
  "durable-file.cjs","export-preload.cjs","exporter.cjs","job-lifecycle.cjs","main.cjs","owned-path.cjs","package-lock.json","package.json","preload.cjs","render-spec.cjs","timeline-reconcile.cjs","video-lifecycle.cjs",
];
const directoryRoots=[".github","fixtures","scripts","src"];
const explicitFiles=[
  "docs/CLASSIC_LAYOUT.md","docs/CUSTOMIZING_WITH_AI.md","docs/CUSTOMIZING_WITH_AI.ko.md","docs/PROJECT_MAP.md","docs/XML_COMPATIBILITY.md",
  "current-job/source/.gitkeep","current-job/references/.gitkeep","current-job/output/.gitkeep","current-job/logs/.gitkeep",
];

function copyFile(relative){
  const source=path.join(root,relative);
  const destination=path.join(target,relative);
  const stat=fs.lstatSync(source);
  if(!stat.isFile())throw new Error("Public manifest entry is not a regular file: "+relative);
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.copyFileSync(source,destination);
}

function trackedFilesUnder(roots){
  const result=spawnSync("git",["ls-files","-z","--",...roots],{
    cwd:root,
    encoding:"buffer",
    windowsHide:true,
  });
  if(result.error||result.status!==0){
    throw new Error("Unable to read the tracked public file inventory: "+(result.error?.message||String(result.stderr||"git ls-files failed")));
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

rootFiles.forEach(copyFile);
explicitFiles.forEach(copyFile);
trackedFilesUnder(directoryRoots).forEach(copyFile);

const forbidden=[
  {label:"Windows user path",pattern:/[A-Za-z]:[\\/]+Users[\\/]+/i},
  {label:"email address",pattern:/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i},
  {label:"private key",pattern:/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i},
];
const textExtensions=new Set([".cjs",".js",".json",".md",".html",".css",".xml",".yml",".yaml",".cmd",".gitignore",".gitattributes"]);
const manifest=[];

function auditDirectory(directory){
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const absolute=path.join(directory,entry.name);
    if(entry.isDirectory())auditDirectory(absolute);
    else if(entry.isFile()){
      const relative=path.relative(target,absolute).replaceAll("\\","/");
      const bytes=fs.readFileSync(absolute);
      if(bytes.length>50*1024*1024)throw new Error("Public file exceeds 50 MiB: "+relative);
      const extension=path.extname(entry.name).toLowerCase();
      if(textExtensions.has(extension)||entry.name.startsWith(".")){
        const content=bytes.toString("utf8");
        for(const rule of forbidden){
          if(rule.pattern.test(content))throw new Error(rule.label+" found in "+relative);
        }
      }
      manifest.push({path:relative,bytes:bytes.length,sha256:crypto.createHash("sha256").update(bytes).digest("hex")});
    }
  }
}

auditDirectory(target);
manifest.sort((left,right)=>left.path.localeCompare(right.path));
const totalBytes=manifest.reduce((sum,item)=>sum+item.bytes,0);
console.log("PUBLIC_TREE_READY "+JSON.stringify({target,files:manifest.length,bytes:totalBytes}));
