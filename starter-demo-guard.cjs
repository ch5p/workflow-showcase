"use strict";

const fs = require("node:fs");
const path = require("node:path");

function listExistingJobPayload({ jobRoot, ownedRoots } = {}){
  if(typeof jobRoot !== "string" || !jobRoot || !Array.isArray(ownedRoots)){
    throw new TypeError("Starter demo payload roots are required");
  }
  const resolvedJobRoot = path.resolve(jobRoot);
  const payload = [];
  for(const ownedRoot of ownedRoots){
    if(typeof ownedRoot !== "string" || !ownedRoot || !fs.existsSync(ownedRoot)) continue;
    for(const entry of fs.readdirSync(ownedRoot, { withFileTypes: true })){
      if(entry.name === ".gitkeep") continue;
      const absolute = path.resolve(ownedRoot, entry.name);
      const relative = path.relative(resolvedJobRoot, absolute);
      if(!relative || relative.startsWith("..") || path.isAbsolute(relative)){
        throw new Error("Starter demo payload escapes the Current Job");
      }
      payload.push(relative.replaceAll("\\", "/"));
    }
  }
  return payload.sort();
}

module.exports = { listExistingJobPayload };
