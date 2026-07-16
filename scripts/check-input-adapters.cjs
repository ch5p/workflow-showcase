"use strict";

const assert=require("node:assert/strict");
const {
  isUnsupportedAdjustmentLayer,
  clipKey,
  collectUnsupportedClipKeys,
  excludeUnsupportedLayers,
}=require("../src/adapters/xmeml-unsupported-layers.js");
const {inspectTimeline}=require("../src/core/shot-model.js");

assert.equal(isUnsupportedAdjustmentLayer({
  clipName:"조정 레이어 (Adjustment Layer)",
  fileName:"Black Video",
  mediaSource:"Slug",
  pathUrl:"",
  hasFilter:true,
}),true);
assert.equal(isUnsupportedAdjustmentLayer({
  clipName:"Renamed grade",
  fileName:"Black Video",
  mediaSource:"Slug",
  pathUrl:"",
  hasFilter:true,
}),true);
assert.equal(isUnsupportedAdjustmentLayer({
  clipName:"Adjustment Layer",
  fileName:"adjustment-layer.mp4",
  mediaSource:"File",
  pathUrl:"file://localhost/C:/media/adjustment-layer.mp4",
  hasFilter:true,
}),false);
assert.equal(isUnsupportedAdjustmentLayer({
  clipName:"Black background",
  fileName:"Black Video",
  mediaSource:"Slug",
  pathUrl:"",
  hasFilter:false,
}),false);

const baseClips=[
  {track:1,name:"clip-a.mp4",start:0,end:72,in:0,out:72,enabled:true,fileId:"file-a",sourceId:"file:file-a"},
  {track:1,name:"clip-b.mp4",start:72,end:144,in:0,out:72,enabled:true,fileId:"file-b",sourceId:"file:file-b"},
  {track:1,name:"clip-a.mp4",start:144,end:216,in:0,out:72,enabled:true,fileId:"file-a",sourceId:"file:file-a"},
  {track:1,name:"clip-c.mp4",start:216,end:288,in:0,out:72,enabled:true,fileId:"file-c",sourceId:"file:file-c"},
  {track:2,name:"overlay-d.mp4",start:48,end:120,in:0,out:72,enabled:true,fileId:"file-d",sourceId:"file:file-d"},
];
const adjustment={
  track:3,name:"조정 레이어 (Adjustment Layer)",start:0,end:288,in:0,out:288,
  enabled:true,fileId:"adjustment-1",sourceId:"file:adjustment-1",
};
const parsed={fps:24,duration:288,name:"adjustment-test",clips:[...baseClips,adjustment],warns:[],workArea:null};
function element(tag,text="",attributes={},children=[]){
  return {
    tagName:tag,
    textContent:text||children.map(child=>child.textContent).join(""),
    children,
    getAttribute(name){return attributes[name]||null;},
  };
}
function field(tag,value){return element(tag,String(value));}
function clipNode(clip,{fileName,mediaSource,pathUrl="",hasFilter=false}={}){
  const fileChildren=[field("name",fileName||clip.name),field("mediaSource",mediaSource||"File")];
  if(pathUrl)fileChildren.push(field("pathurl",pathUrl));
  const children=[
    field("name",clip.name),field("start",clip.start),field("end",clip.end),
    field("in",clip.in),field("out",clip.out),
    element("file","",{id:clip.fileId},fileChildren),
  ];
  if(hasFilter)children.push(element("filter","Lumetri"));
  return element("clipitem","",{},children);
}
const baseNode=clipNode(baseClips[0],{
  fileName:"clip-a.mp4",mediaSource:"File",pathUrl:"file://localhost/C:/media/clip-a.mp4",hasFilter:true,
});
const adjustmentNode=clipNode(adjustment,{
  fileName:"Black Video",mediaSource:"Slug",hasFilter:true,
});
const track1=element("track","",{},[baseNode]);
const track2=element("track","",{},[]);
const track3=element("track","",{},[adjustmentNode]);
const sequence=element("sequence");
sequence.querySelectorAll=selector=>selector==="media > video > track"?[track1,track2,track3]:[];
const files=[...baseNode.children,...adjustmentNode.children].filter(child=>child.tagName==="file");
const fakeDocument={
  querySelector(selector){return selector==="sequence"?sequence:null;},
  querySelectorAll(selector){return selector==="file[id]"?files:[];},
};
class FakeDOMParser{
  parseFromString(){return fakeDocument;}
}

const ignoredKeys=collectUnsupportedClipKeys("<xmeml/>",{DOMParserClass:FakeDOMParser});
const filtered=excludeUnsupportedLayers("<xmeml/>",parsed,{DOMParserClass:FakeDOMParser});
const inspection=inspectTimeline(filtered);

assert.equal(ignoredKeys.has(clipKey(adjustment)),true);
assert.equal(ignoredKeys.has(clipKey(baseClips[0])),false);
assert.equal(parsed.clips.length,6);
assert.equal(filtered.clips.length,5);
assert.equal(inspection.edits,5);
assert.equal(inspection.shots.length,4);
assert.equal(JSON.stringify(filtered).includes("Lumetri"),false);

console.log("INPUT_ADAPTERS_CHECK_OK");
