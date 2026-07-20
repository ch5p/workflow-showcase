"use strict";

const TIMELINE_FORMATS=Object.freeze({
  xmeml:Object.freeze({
    format:"xmeml",
    displayName:"Premiere / FCP7 XML",
    extension:".xml",
    sourceExtensions:Object.freeze([".xml"]),
    candidateName:"candidate.xml",
    canonicalName:"timeline.xml",
    relativePath:"source/timeline.xml",
    maxBytes:64*1024*1024,
    eventPrefix:"job_xml",
  }),
  "capcut-draft":Object.freeze({
    format:"capcut-draft",
    displayName:"CapCut Desktop 9.x",
    extension:".json",
    sourceExtensions:Object.freeze([".json"]),
    candidateName:"candidate.capcut.json",
    canonicalName:"timeline.capcut.json",
    relativePath:"source/timeline.capcut.json",
    maxBytes:64*1024*1024,
    eventPrefix:"job_timeline",
  }),
});

function timelineSpec(format="xmeml"){
  const normalized=String(format||"xmeml").trim().toLowerCase();
  const spec=TIMELINE_FORMATS[normalized];
  if(!spec)throw new Error("Unsupported timeline input format: "+normalized);
  return spec;
}

function resolveTimelineInput(job){
  if(job?.timelineInput&&typeof job.timelineInput==="object"){
    const spec=timelineSpec(job.timelineInput.format);
    return {
      format:spec.format,
      name:String(job.timelineInput.name||spec.displayName),
      relativePath:String(job.timelineInput.relativePath||spec.relativePath),
      editorVersion:job.timelineInput.editorVersion?String(job.timelineInput.editorVersion):undefined,
    };
  }
  if(job?.xml&&typeof job.xml==="object"){
    return {
      format:"xmeml",
      name:String(job.xml.name||"timeline.xml"),
      relativePath:String(job.xml.relativePath||TIMELINE_FORMATS.xmeml.relativePath),
      editorVersion:undefined,
    };
  }
  return null;
}

function createTimelineRecord(format,name,{editorVersion}={}){
  const spec=timelineSpec(format);
  const record={
    format:spec.format,
    name:String(name||spec.displayName),
    relativePath:spec.relativePath,
  };
  if(editorVersion)record.editorVersion=String(editorVersion);
  return record;
}

function timelineJobFields(record){
  if(!record)return {timelineInput:null,xml:null};
  const spec=timelineSpec(record.format);
  const timelineInput={
    format:spec.format,
    name:String(record.name||spec.displayName),
    relativePath:spec.relativePath,
  };
  if(record.editorVersion)timelineInput.editorVersion=String(record.editorVersion);
  return {
    timelineInput,
    xml:spec.format==="xmeml"
      ?{name:timelineInput.name,relativePath:timelineInput.relativePath}
      :null,
  };
}

module.exports={
  TIMELINE_FORMATS,
  timelineSpec,
  resolveTimelineInput,
  createTimelineRecord,
  timelineJobFields,
};
