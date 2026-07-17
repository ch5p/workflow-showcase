"use strict";

const { reconcileTimelineMappings } = require("./timeline-reconcile.cjs");

function isPlainObject(value){
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validatePersistedTimelineState({
  timelineShots,
  shotMappings,
  orphanedShotMappings,
} = {}){
  if(timelineShots !== undefined && !Array.isArray(timelineShots)){
    throw new TypeError("timelineShots must be an array");
  }
  if(orphanedShotMappings !== undefined && !Array.isArray(orphanedShotMappings)){
    throw new TypeError("orphanedShotMappings must be an array");
  }
  if(!isPlainObject(shotMappings)) throw new TypeError("shotMappings must be an object");

  const persistedShots = timelineShots || [];
  const persistedOrphans = orphanedShotMappings || [];
  if(persistedShots.length || persistedOrphans.length){
    // RED ZONE: validation reuses the pure normalizer without changing persisted Job data.
    reconcileTimelineMappings({
      previousShots: persistedShots,
      nextShots: persistedShots,
      shotMappings,
      orphanedShotMappings: persistedOrphans,
    });
  }
  return true;
}

module.exports = { validatePersistedTimelineState };
