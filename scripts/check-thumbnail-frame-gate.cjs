"use strict";

const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const root=path.resolve(__dirname,"..");
const preview=fs.readFileSync(path.join(root,"src","output-preview.html"),"utf8");
const classicCss=fs.readFileSync(path.join(root,"src","layouts","classic","classic.css"),"utf8");
assert.equal(preview.includes("const count=14"),false,"Overview must not return to fixed sample cells");
assert.equal(classicCss.includes("repeat(14"),false,"Overview CSS must not return to a fixed sample grid");
assert.equal(preview.includes("overviewFilmstripSlices(segment.start,segment.end"),true,"Overview filmstrip must preserve segment geometry");
assert.equal(preview.includes("slice.start/DATA.duration*100"),true,"Overview slice start must use exact frame geometry");
assert.equal(preview.includes("(slice.end-slice.start)/DATA.duration*100"),true,"Overview slice width must use exact frame geometry");
const coverStart=preview.indexOf("function overviewCoverSourceRect(");
const coverEnd=preview.indexOf("\nfunction drawOverviewThumbnailCover",coverStart);
if(coverStart<0||coverEnd<0)throw new Error("Overview cover geometry source missing");
const coverSandbox={};
vm.createContext(coverSandbox);
vm.runInContext(`${preview.slice(coverStart,coverEnd)}\nglobalThis.cover=overviewCoverSourceRect;`,coverSandbox);
const wide=coverSandbox.cover(160,90,320,40);
assert.ok(Math.abs(wide.width-160)<1e-9&&Math.abs(wide.height-20)<1e-9&&Math.abs(wide.y-35)<1e-9,"Wide overview segments must crop vertically without stretching");
const narrow=coverSandbox.cover(160,90,40,90);
assert.ok(Math.abs(narrow.width-40)<1e-9&&Math.abs(narrow.height-90)<1e-9&&Math.abs(narrow.x-60)<1e-9,"Narrow overview segments must crop horizontally without stretching");
const slicesStart=preview.indexOf("function overviewFilmstripSlices(");
const slicesEnd=preview.indexOf("\nasync function generateOverviewThumbnails",slicesStart);
if(slicesStart<0||slicesEnd<0)throw new Error("Overview filmstrip geometry source missing");
const slicesSandbox={};
vm.createContext(slicesSandbox);
vm.runInContext(`${preview.slice(slicesStart,slicesEnd)}\nglobalThis.slices=overviewFilmstripSlices;`,slicesSandbox);
const longSlices=slicesSandbox.slices(0,72,260,78);
assert.deepEqual(Array.from(longSlices,slice=>Math.round(slice.pixelWidth)),[78,78,78,26],"Long clips must use fixed-scale tiles plus an exact clipped remainder");
assert.equal(longSlices[0].start,0,"Filmstrip must start at the exact clip boundary");
assert.equal(longSlices.at(-1).end,72,"Filmstrip must end at the exact clip boundary");
for(let index=1;index<longSlices.length;index++)assert.equal(longSlices[index-1].end,longSlices[index].start,"Filmstrip slices must stay contiguous");
const shortSlices=slicesSandbox.slices(72,96,60,78);
assert.equal(shortSlices.length,1,"A short clip must remain one cropped fixed-scale tile");
assert.equal(shortSlices[0].start,72);
assert.equal(shortSlices[0].end,96);
assert.equal(shortSlices[0].pixelWidth,60);
const start=preview.indexOf("function seekThumbnailFrame(");
const end=preview.indexOf("\nfunction overviewCoverSourceRect",start);
if(start<0||end<0)throw new Error("Thumbnail frame gate source missing");
const gateSource=preview.slice(start,end);
const retryStart=preview.indexOf("async function seekThumbnailFrameWithRetry(");
const retryEnd=preview.indexOf("\nfunction thumbnailCacheKey",retryStart);
if(retryStart<0||retryEnd<0)throw new Error("Thumbnail retry source missing");
const retrySource=preview.slice(retryStart,retryEnd);

class FakeThumbnailVideo{
  constructor(){
    this.duration=12;
    this.readyState=3;
    this._currentTime=0;
    this.listeners=new Map();
    this.callbacks=new Map();
    this.nextCallbackId=0;
  }
  get currentTime(){ return this._currentTime; }
  set currentTime(value){
    this._currentTime=value;
    queueMicrotask(()=>this.emit("seeked"));
  }
  addEventListener(type,listener,options={}){
    if(!this.listeners.has(type))this.listeners.set(type,[]);
    this.listeners.get(type).push({listener,once:Boolean(options.once)});
  }
  removeEventListener(type,listener){
    this.listeners.set(type,(this.listeners.get(type)||[]).filter(record=>record.listener!==listener));
  }
  emit(type){
    const records=[...(this.listeners.get(type)||[])];
    for(const record of records){
      if(record.once)this.removeEventListener(type,record.listener);
      record.listener();
    }
  }
  requestVideoFrameCallback(callback){
    const id=++this.nextCallbackId;
    this.callbacks.set(id,callback);
    return id;
  }
  cancelVideoFrameCallback(id){ this.callbacks.delete(id); }
  emitDecodedFrame(mediaTime){
    const callbacks=[...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach(callback=>callback(0,{mediaTime}));
  }
}

function createHarness(){
  const thumbnailVideo=new FakeThumbnailVideo();
  const sandbox={thumbnailVideo,DATA:{fps:24},setTimeout,clearTimeout};
  vm.createContext(sandbox);
  vm.runInContext(`let thumbnailGeneration=1,thumbnailSeekToken=0,thumbnailRetryTimer=0,lastThumbnailSeekDiagnostic=null,thumbnailFrameCache=new Map();${gateSource}\nglobalThis.seek=seekThumbnailFrame;globalThis.setGeneration=value=>{thumbnailGeneration=value;};`,sandbox);
  return {thumbnailVideo,seek:sandbox.seek,setGeneration:sandbox.setGeneration};
}

function createRetryHarness(outcomes,staleAfterFirst=false){
  const sandbox={events:[],calls:0,setTimeout:callback=>{callback();return 1;}};
  vm.createContext(sandbox);
  vm.runInContext(`
    let thumbnailGeneration=1,lastThumbnailSeekDiagnostic={reason:"timeout"};
    const outcomes=${JSON.stringify(outcomes)};
    async function seekThumbnailFrame(){
      globalThis.calls++;
      const result=outcomes.shift();
      if(${JSON.stringify(staleAfterFirst)})thumbnailGeneration=2;
      return result;
    }
    function logThumbnailEvent(event,detail){globalThis.events.push({event,detail});}
    ${retrySource}
    globalThis.retry=seekThumbnailFrameWithRetry;
  `,sandbox);
  return sandbox;
}

async function flush(){ await new Promise(resolve=>setImmediate(resolve)); }

async function assertFrameGate(){
  let harness=createHarness();
  let result=harness.seek(1,1);
  let settled=false;
  result.then(()=>{settled=true});
  await flush();
  harness.thumbnailVideo.emitDecodedFrame(9);
  await flush();
  assert.equal(settled,false,"A decoded frame at the wrong mediaTime must not complete the capture");
  harness.thumbnailVideo.emitDecodedFrame(1);
  assert.equal(await result,true,"The gate must keep waiting until the requested frame is decoded");

  harness=createHarness();
  result=harness.seek(1,1);
  await flush();
  harness.thumbnailVideo.emitDecodedFrame(1);
  assert.equal(await result,true,"The requested decoded frame must be accepted");

  harness=createHarness();
  result=harness.seek(109/24,1);
  await flush();
  harness.thumbnailVideo.emitDecodedFrame(108/24);
  assert.equal(await result,true,"Chromium's preceding presentation timestamp at an exact frame boundary must be accepted");

  harness=createHarness();
  result=harness.seek(1,1);
  await flush();
  harness.setGeneration(2);
  harness.thumbnailVideo.emitDecodedFrame(1);
  assert.equal(await result,false,"A stale thumbnail generation must be rejected");

  harness=createHarness();
  harness.thumbnailVideo._currentTime=1;
  result=harness.seek(1,1);
  await flush();
  harness.thumbnailVideo.emitDecodedFrame(1);
  assert.equal(await result,true,"A retry at the current media time must force a fresh decoded-frame callback");

  let retryHarness=createRetryHarness([false,false,true]);
  assert.equal(await retryHarness.retry(1,1,{phase:"timeline"},3),true,"A transient seek failure must recover within the retry budget");
  assert.equal(retryHarness.calls,3,"Retry must stop immediately after a validated frame");
  assert.equal(retryHarness.events.length,2,"Only failed attempts should be logged");

  retryHarness=createRetryHarness([false,true]);
  assert.equal(await retryHarness.retry(1,1,{phase:"timeline"}),true,"The default retry budget must recover on the second attempt");
  assert.equal(retryHarness.calls,2,"The default retry budget must be capped at two attempts");

  retryHarness=createRetryHarness([false,false,true],true);
  assert.equal(await retryHarness.retry(1,1,{phase:"timeline"},3),false,"Retry must stop when a newer thumbnail generation takes ownership");
  assert.equal(retryHarness.calls,1,"A stale generation must not keep seeking");
}

assertFrameGate().then(()=>console.log("THUMBNAIL_FRAME_GATE_OK"));
