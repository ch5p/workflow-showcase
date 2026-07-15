"use strict";

const DESCRIPTOR_KEYS = new Set([
  "id", "identityKey", "nameKey", "startFrame", "endFrame", "occurrences",
]);
const OCCURRENCE_KEYS = new Set(["startFrame", "endFrame", "inFrame", "outFrame"]);
const ORPHAN_KEYS = new Set(["descriptor", "mapping", "reason"]);
const IDENTITY_KEY_PATTERN = /^src-[0-9a-f]{16}$/i;
const NAME_KEY_PATTERN = /^name-[0-9a-f]{16}$/i;
const ORPHAN_REASONS = new Set(["unmatched", "ambiguous"]);

function isPlainObject(value){
  if(!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyKeys(value, allowed, label){
  for(const key of Object.keys(value)){
    if(!allowed.has(key)) throw new TypeError(label + " contains forbidden field: " + key);
  }
}

function normalizeId(value, label){
  if(typeof value === "number"){
    if(!Number.isFinite(value)) throw new TypeError(label + ".id must be finite");
    return value;
  }
  if(typeof value !== "string" || !value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)){
    throw new TypeError(label + ".id must be a non-empty string or finite number");
  }
  return value;
}

function normalizeHashKey(value, pattern, format, label){
  if(typeof value !== "string" || !pattern.test(value)){
    throw new TypeError(label + " must match the anonymous " + format + " contract");
  }
  return value.toLowerCase();
}

function normalizeFrame(value, label){
  if(!Number.isSafeInteger(value) || value < 0){
    throw new TypeError(label + " must be a non-negative safe integer");
  }
  return value;
}

function normalizeOccurrence(value, label){
  if(!isPlainObject(value)) throw new TypeError(label + " must be an object");
  assertOnlyKeys(value, OCCURRENCE_KEYS, label);
  const occurrence = {
    startFrame: normalizeFrame(value.startFrame, label + ".startFrame"),
    endFrame: normalizeFrame(value.endFrame, label + ".endFrame"),
    inFrame: normalizeFrame(value.inFrame, label + ".inFrame"),
    outFrame: normalizeFrame(value.outFrame, label + ".outFrame"),
  };
  if(occurrence.endFrame <= occurrence.startFrame){
    throw new RangeError(label + " must have endFrame greater than startFrame");
  }
  if(occurrence.outFrame <= occurrence.inFrame){
    throw new RangeError(label + " must have outFrame greater than inFrame");
  }
  return occurrence;
}

function occurrenceSortKey(value){
  return [value.startFrame, value.endFrame, value.inFrame, value.outFrame]
    .map(number => String(number).padStart(16, "0"))
    .join(":");
}

function normalizeDescriptor(value, label){
  if(!isPlainObject(value)) throw new TypeError(label + " must be an object");
  assertOnlyKeys(value, DESCRIPTOR_KEYS, label);
  if(!Array.isArray(value.occurrences)) throw new TypeError(label + ".occurrences must be an array");
  const descriptor = {
    id: normalizeId(value.id, label),
    identityKey: normalizeHashKey(value.identityKey, IDENTITY_KEY_PATTERN, "src-<16 hex>", label + ".identityKey"),
    nameKey: normalizeHashKey(value.nameKey, NAME_KEY_PATTERN, "name-<16 hex>", label + ".nameKey"),
    startFrame: normalizeFrame(value.startFrame, label + ".startFrame"),
    endFrame: normalizeFrame(value.endFrame, label + ".endFrame"),
    occurrences: value.occurrences
      .map((occurrence, index) => normalizeOccurrence(occurrence, label + ".occurrences[" + index + "]"))
      .sort((left, right) => occurrenceSortKey(left).localeCompare(occurrenceSortKey(right))),
  };
  if(descriptor.endFrame <= descriptor.startFrame){
    throw new RangeError(label + " must have endFrame greater than startFrame");
  }
  for(const occurrence of descriptor.occurrences){
    if(occurrence.startFrame < descriptor.startFrame || occurrence.endFrame > descriptor.endFrame){
      throw new RangeError(label + " occurrence must stay inside the descriptor timeline range");
    }
  }
  return descriptor;
}

function cloneJson(value, label, seen = new Set()){
  if(value === null || typeof value === "string" || typeof value === "boolean") return value;
  if(typeof value === "number"){
    if(!Number.isFinite(value)) throw new TypeError(label + " contains a non-finite number");
    return value;
  }
  if(typeof value !== "object") throw new TypeError(label + " must contain JSON-compatible values");
  if(seen.has(value)) throw new TypeError(label + " must not contain cycles");
  seen.add(value);
  try{
    if(Array.isArray(value)) return value.map((item, index) => cloneJson(item, label + "[" + index + "]", seen));
    if(!isPlainObject(value)) throw new TypeError(label + " must contain plain objects");
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, cloneJson(value[key], label + "." + key, seen)]));
  }finally{
    seen.delete(value);
  }
}

function normalizeMapping(value, label){
  if(!isPlainObject(value)) throw new TypeError(label + " must be an object");
  return cloneJson(value, label);
}

function canonicalId(value){
  return String(value);
}

function stableStringify(value){
  if(value === null || typeof value !== "object") return JSON.stringify(value);
  if(Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ":" + stableStringify(value[key]))
    .join(",") + "}";
}

function normalizeDescriptorList(value, label){
  if(!Array.isArray(value)) throw new TypeError(label + " must be an array");
  const descriptors = value.map((descriptor, index) => normalizeDescriptor(descriptor, label + "[" + index + "]"));
  const ids = new Set();
  for(const descriptor of descriptors){
    const id = canonicalId(descriptor.id);
    if(ids.has(id)) throw new TypeError(label + " contains duplicate shot id: " + id);
    ids.add(id);
  }
  return descriptors;
}

function normalizeOrphans(value){
  if(value === undefined || value === null) return [];
  if(!Array.isArray(value)) throw new TypeError("orphanedShotMappings must be an array");
  return value.map((record, index) => {
    const label = "orphanedShotMappings[" + index + "]";
    if(!isPlainObject(record)) throw new TypeError(label + " must be an object");
    assertOnlyKeys(record, ORPHAN_KEYS, label);
    if(!ORPHAN_REASONS.has(record.reason)) throw new TypeError(label + ".reason is invalid");
    return {
      descriptor: normalizeDescriptor(record.descriptor, label + ".descriptor"),
      mapping: normalizeMapping(record.mapping, label + ".mapping"),
      reason: record.reason,
    };
  });
}

function groupIndexes(descriptors, indexes, key){
  const groups = new Map();
  for(const index of indexes){
    const value = descriptors[index][key];
    if(!groups.has(value)) groups.set(value, []);
    groups.get(value).push(index);
  }
  return groups;
}

function intervalsOverlap(leftStart, leftEnd, rightStart, rightEnd){
  return Math.max(leftStart, rightStart) < Math.min(leftEnd, rightEnd);
}

function hasSourceRangeOverlap(left, right){
  return left.occurrences.some(leftOccurrence => right.occurrences.some(rightOccurrence => (
    intervalsOverlap(
      leftOccurrence.inFrame,
      leftOccurrence.outFrame,
      rightOccurrence.inFrame,
      rightOccurrence.outFrame,
    )
  )));
}

function similarDuration(left, right){
  const smaller = Math.min(left, right);
  const larger = Math.max(left, right);
  return larger > 0 && smaller / larger >= 0.8;
}

function withinPatternTolerance(left, right, scale){
  return Math.abs(left - right) <= Math.max(2, Math.ceil(scale * 0.1));
}

function hasOccurrenceSimilarity(left, right){
  // A single occurrence has no relative pattern; matching it by name and duration alone is unsafe.
  if(left.occurrences.length < 2 || left.occurrences.length !== right.occurrences.length) return false;
  if(!similarDuration(left.endFrame - left.startFrame, right.endFrame - right.startFrame)) return false;
  const leftFirst = left.occurrences[0];
  const rightFirst = right.occurrences[0];
  return left.occurrences.every((leftOccurrence, index) => {
    const rightOccurrence = right.occurrences[index];
    const leftTimelineDuration = leftOccurrence.endFrame - leftOccurrence.startFrame;
    const rightTimelineDuration = rightOccurrence.endFrame - rightOccurrence.startFrame;
    const leftSourceDuration = leftOccurrence.outFrame - leftOccurrence.inFrame;
    const rightSourceDuration = rightOccurrence.outFrame - rightOccurrence.inFrame;
    const timelineScale = Math.max(leftTimelineDuration, rightTimelineDuration);
    const sourceScale = Math.max(leftSourceDuration, rightSourceDuration);
    return similarDuration(leftTimelineDuration, rightTimelineDuration) &&
      similarDuration(leftSourceDuration, rightSourceDuration) &&
      withinPatternTolerance(
        leftOccurrence.startFrame - leftFirst.startFrame,
        rightOccurrence.startFrame - rightFirst.startFrame,
        timelineScale,
      ) &&
      withinPatternTolerance(
        leftOccurrence.inFrame - leftFirst.inFrame,
        rightOccurrence.inFrame - rightFirst.inFrame,
        sourceScale,
      );
  });
}

function hasFallbackEvidence(left, right){
  return hasSourceRangeOverlap(left, right) || hasOccurrenceSimilarity(left, right);
}

function matchDescriptors(sources, targets, usedTargets = new Set()){
  const matches = new Map();
  const ambiguous = new Set();
  const sourceIndexes = sources.map((_value, index) => index);
  const availableTargetIndexes = targets
    .map((_value, index) => index)
    .filter(index => !usedTargets.has(index));
  const sourceIdentityGroups = groupIndexes(sources, sourceIndexes, "identityKey");
  const targetIdentityGroups = groupIndexes(targets, availableTargetIndexes, "identityKey");

  for(const identityKey of [...sourceIdentityGroups.keys()].sort()){
    const sourceGroup = sourceIdentityGroups.get(identityKey);
    const targetGroup = targetIdentityGroups.get(identityKey) || [];
    if(sourceGroup.length === 1 && targetGroup.length === 1){
      matches.set(sourceGroup[0], targetGroup[0]);
      usedTargets.add(targetGroup[0]);
    }else if(targetGroup.length){
      // Multiple exact candidates are never guessed; they remain recoverable orphans.
      sourceGroup.forEach(index => ambiguous.add(index));
    }
  }

  const eligibleSources = sourceIndexes.filter(index => !matches.has(index) && !ambiguous.has(index));
  const remainingTargets = availableTargetIndexes.filter(index => !usedTargets.has(index));
  const candidateMap = new Map();
  const inverseCandidates = new Map();
  for(const sourceIndex of eligibleSources){
    const source = sources[sourceIndex];
    const candidates = remainingTargets.filter(targetIndex => (
      targets[targetIndex].nameKey === source.nameKey &&
      targets[targetIndex].identityKey !== source.identityKey
    ));
    candidateMap.set(sourceIndex, candidates);
    for(const targetIndex of candidates){
      if(!inverseCandidates.has(targetIndex)) inverseCandidates.set(targetIndex, []);
      inverseCandidates.get(targetIndex).push(sourceIndex);
    }
  }

  for(const sourceIndex of eligibleSources){
    const candidates = candidateMap.get(sourceIndex) || [];
    if(candidates.length > 1){
      ambiguous.add(sourceIndex);
      continue;
    }
    if(candidates.length !== 1) continue;
    const targetIndex = candidates[0];
    if((inverseCandidates.get(targetIndex) || []).length !== 1){
      ambiguous.add(sourceIndex);
      continue;
    }
    if(!hasFallbackEvidence(sources[sourceIndex], targets[targetIndex])) continue;
    matches.set(sourceIndex, targetIndex);
    usedTargets.add(targetIndex);
  }

  return { matches, ambiguous, usedTargets };
}

function normalizeShotMappings(value, previousById){
  if(value === undefined || value === null) return new Map();
  if(!isPlainObject(value)) throw new TypeError("shotMappings must be an object");
  const mappings = new Map();
  for(const id of Object.keys(value).sort()){
    if(!previousById.has(id)) throw new TypeError("shotMappings contains unknown previous shot id: " + id);
    mappings.set(id, normalizeMapping(value[id], "shotMappings." + id));
  }
  return mappings;
}

function setMapping(output, id, mapping){
  const key = canonicalId(id);
  if(output.has(key)) throw new Error("Multiple mappings resolved to next shot id: " + key);
  output.set(key, cloneJson(mapping, "resolved mapping"));
}

function deterministicOrphans(records){
  const unique = new Map();
  for(const record of records){
    const normalized = {
      descriptor: normalizeDescriptor(record.descriptor, "orphan descriptor"),
      mapping: normalizeMapping(record.mapping, "orphan mapping"),
      reason: ORPHAN_REASONS.has(record.reason) ? record.reason : "unmatched",
    };
    const key = stableStringify(normalized);
    if(!unique.has(key)) unique.set(key, normalized);
  }
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([_key, record]) => record);
}

function reconcileTimelineMappings({
  previousShots = [],
  nextShots = [],
  shotMappings = {},
  orphanedShotMappings = [],
} = {}){
  const previous = normalizeDescriptorList(previousShots, "previousShots");
  const next = normalizeDescriptorList(nextShots, "nextShots");
  const previousById = new Map(previous.map((descriptor, index) => [canonicalId(descriptor.id), index]));
  const mappings = normalizeShotMappings(shotMappings, previousById);
  const existingOrphans = normalizeOrphans(orphanedShotMappings);
  const usedTargets = new Set();
  const activeMatches = matchDescriptors(previous, next, usedTargets);
  const resolvedMappings = new Map();
  const unresolved = [];
  let preserved = 0;

  for(const [oldId, mapping] of mappings){
    const previousIndex = previousById.get(oldId);
    if(activeMatches.matches.has(previousIndex)){
      const nextIndex = activeMatches.matches.get(previousIndex);
      setMapping(resolvedMappings, next[nextIndex].id, mapping);
      preserved += 1;
    }else{
      unresolved.push({
        descriptor: previous[previousIndex],
        mapping,
        reason: activeMatches.ambiguous.has(previousIndex) ? "ambiguous" : "unmatched",
      });
    }
  }

  const orphanDescriptors = existingOrphans.map(record => record.descriptor);
  const orphanMatches = matchDescriptors(orphanDescriptors, next, usedTargets);
  let reattached = 0;
  for(let index = 0; index < existingOrphans.length; index += 1){
    const record = existingOrphans[index];
    if(orphanMatches.matches.has(index)){
      const nextIndex = orphanMatches.matches.get(index);
      setMapping(resolvedMappings, next[nextIndex].id, record.mapping);
      reattached += 1;
    }else{
      unresolved.push({
        descriptor: record.descriptor,
        mapping: record.mapping,
        reason: orphanMatches.ambiguous.has(index) ? "ambiguous" : "unmatched",
      });
    }
  }

  const finalOrphans = deterministicOrphans(unresolved);
  const sortedMappings = Object.fromEntries([...resolvedMappings.entries()]
    .sort(([left], [right]) => left.localeCompare(right)));
  return {
    shotMappings: sortedMappings,
    orphanedShotMappings: finalOrphans,
    summary: {
      preserved,
      newShots: next.length - usedTargets.size,
      orphaned: finalOrphans.length,
      ambiguous: finalOrphans.filter(record => record.reason === "ambiguous").length,
      reattached,
    },
  };
}

module.exports = { reconcileTimelineMappings };
