"use strict";

(() => {
  const bridge=window.portableApi;
  const ui=window.wireframeApi;
  const iframe=document.getElementById("renderPreview");
  let job=null;
  let timeline=null;
  let initialized=false;
  let saveTimer=0;
  let titleSaveTimer=0;
  let calloutSaveTimer=0;
  const DEFAULT_CALLOUT={enabled:true,position:"left",style:"line",startSeconds:.08,durationSeconds:3.5,subtitle:"REFERENCE MAP · EDIT WORKFLOW"};

  function preview(){ return iframe.contentWindow?.portablePreview||null; }
  function waitForPreview(){
    if(preview()) return Promise.resolve(preview());
    return new Promise(resolve=>iframe.addEventListener("load",()=>resolve(preview()),{once:true}));
  }
  function tc(frame,fps){
    const value=Math.max(0,Math.round(frame));
    const ff=value%fps;
    const seconds=Math.floor(value/fps);
    const ss=seconds%60;
    const mm=Math.floor(seconds/60)%60;
    const hh=Math.floor(seconds/3600);
    return [hh,mm,ss,ff].map(value=>String(value).padStart(2,"0")).join(":");
  }
  function setStatus(){
    document.getElementById("jobName").textContent=job?.xml?"CURRENT JOB / "+job.xml.name:"CURRENT JOB / NO XML";
    document.getElementById("xmlStatus").textContent=timeline?"XML READY":"XML NEEDED";
    document.getElementById("fpsStatus").textContent=timeline?timeline.fps+" FPS":"-- FPS";
    document.getElementById("editCountStatus").textContent=(timeline?.edits||0)+" EDITS";
    document.getElementById("shotCountStatus").textContent=(timeline?.shots.length||0)+" SHOTS";
  }
  function previewReferenceState(snapshot=ui.snapshot()){
    return {
      references:(job?.references||[]).map(reference=>({
        id:reference.id,
        type:reference.type,
        src:reference.url,
        label:reference.label,
      })),
      globalReferenceIds:snapshot.globalReferenceIds,
      shotMappings:snapshot.shotMappings,
      shots:(timeline?.shots||[]).map(shot=>({id:String(shot.id),startFrame:shot.startFrame,endFrame:shot.endFrame})),
    };
  }
  function applyPreviewReferences(snapshot){
    preview()?.setReferences(previewReferenceState(snapshot));
  }
  function normalizeProjectTitle(projectTitle){
    if(projectTitle===undefined||projectTitle===null)return "SEEDANCE 2.0";
    return String(projectTitle).replace(/\s+/g," ").trim().slice(0,40);
  }
  function applyProjectTitle(projectTitle=job?.projectTitle){
    const title=normalizeProjectTitle(projectTitle);
    if(job)job.projectTitle=title;
    preview()?.setProjectTitle(title);
    const input=document.getElementById("overlayProjectTitle");
    if(input&&document.activeElement!==input)input.value=title;
    return title;
  }
  async function persistProjectTitle(){
    if(!bridge||!job)return;
    clearTimeout(titleSaveTimer);
    titleSaveTimer=0;
    const input=document.getElementById("overlayProjectTitle");
    const title=applyProjectTitle(input?input.value:job.projectTitle);
    if(input&&document.activeElement!==input)input.value=title;
    job=await bridge.saveJob({projectTitle:title});
  }
  function scheduleProjectTitleSave(value){
    const title=normalizeProjectTitle(value);
    if(job)job.projectTitle=title;
    preview()?.setProjectTitle(title);
    clearTimeout(titleSaveTimer);
    titleSaveTimer=setTimeout(()=>persistProjectTitle().catch(reportError),160);
  }
  function normalizeCallout(value){
    const source=value&&typeof value==="object"?value:{};
    const number=(candidate,fallback,min,max)=>{
      const parsed=Number(candidate);
      return Number.isFinite(parsed)?Math.max(min,Math.min(max,parsed)):fallback;
    };
    return {
      enabled:source.enabled===undefined?DEFAULT_CALLOUT.enabled:Boolean(source.enabled),
      position:source.position==="right"?"right":"left",
      style:["line","label","minimal"].includes(source.style)?source.style:"line",
      startSeconds:number(source.startSeconds,DEFAULT_CALLOUT.startSeconds,0,60),
      durationSeconds:number(source.durationSeconds,DEFAULT_CALLOUT.durationSeconds,.5,30),
      subtitle:source.subtitle===undefined?DEFAULT_CALLOUT.subtitle:String(source.subtitle).replace(/\s+/g," ").trim().slice(0,60),
    };
  }
  function readCalloutControls(){
    return normalizeCallout({
      enabled:document.getElementById("calloutEnabled")?.checked,
      position:document.getElementById("calloutPosition")?.value,
      style:document.getElementById("calloutStyle")?.value,
      startSeconds:document.getElementById("calloutStart")?.value,
      durationSeconds:document.getElementById("calloutDuration")?.value,
      subtitle:document.getElementById("calloutSubtitle")?.value,
    });
  }
  function applyCalloutSettings(value=job?.callout,{syncControls=true}={}){
    const callout=normalizeCallout(value);
    if(job)job.callout=callout;
    preview()?.setCalloutConfig(callout);
    document.getElementById("calloutSettingsState").textContent=(callout.enabled?"ON":"OFF")+" · "+callout.style.toUpperCase();
    if(syncControls){
      document.getElementById("calloutEnabled").checked=callout.enabled;
      document.getElementById("calloutPosition").value=callout.position;
      document.getElementById("calloutStyle").value=callout.style;
      document.getElementById("calloutStart").value=String(callout.startSeconds);
      document.getElementById("calloutDuration").value=String(callout.durationSeconds);
      document.getElementById("calloutSubtitle").value=callout.subtitle;
    }
    return callout;
  }
  async function persistCalloutSettings(syncControls=false){
    if(!bridge||!job)return;
    clearTimeout(calloutSaveTimer);
    calloutSaveTimer=0;
    const callout=applyCalloutSettings(readCalloutControls(),{syncControls});
    job=await bridge.saveJob({callout});
  }
  function scheduleCalloutSave(){
    const callout=applyCalloutSettings(readCalloutControls(),{syncControls:false});
    clearTimeout(calloutSaveTimer);
    calloutSaveTimer=setTimeout(()=>persistCalloutSettings().catch(reportError),160);
    return callout;
  }
  function mountTimeline(parsed){
    timeline=parsed;
    const shots=parsed.shots.map(shot=>({
      id:shot.id,
      edits:shot.edits,
      start:shot.startFrame/parsed.fps,
      end:shot.endFrame/parsed.fps,
      range:tc(shot.startFrame,parsed.fps)+"–"+tc(shot.endFrame,parsed.fps),
    }));
    ui.replaceShots(shots,job?.shotMappings||{});
    setStatus();
    applyPreviewReferences();
    applyProjectTitle();
    applyCalloutSettings();
  }
  async function parseXml(text){
    const target=await waitForPreview();
    if(!target) throw new Error("Preview bridge is not ready");
    mountTimeline(target.loadXml(text));
  }
  async function loadXmlText(text){
    await parseXml(text);
    return {fps:timeline.fps,edits:timeline.edits,shots:timeline.shots.length};
  }
  async function saveMapping(){
    if(!initialized||!bridge)return;
    const snapshot=ui.snapshot();
    applyPreviewReferences(snapshot);
    job=await bridge.saveJob({
      globalReferenceIds:snapshot.globalReferenceIds,
      shotMappings:snapshot.shotMappings,
      projectTitle:job?.projectTitle,
      callout:job?.callout,
    });
  }
  function scheduleSave(){
    if(!initialized)return;
    clearTimeout(saveTimer);
    saveTimer=setTimeout(()=>saveMapping().catch(reportError),120);
  }
  async function reportError(error){
    const message=error?.message||String(error);
    ui.showToast("ERROR · CHECK APP LOG");
    await bridge?.log("renderer_error",{message});
  }
  async function loadXml(){
    try{
      const result=await bridge.selectXml();
      if(!result)return;
      job=result.job;
      await parseXml(result.text);
      ui.showToast("XML LOADED");
    }catch(error){ reportError(error); }
  }
  async function loadVideo(){
    try{
      const next=await bridge.selectVideo();
      if(!next)return;
      job=next;
      (await waitForPreview())?.setVideo(job.video.url);
      ui.showToast("VIDEO LOADED");
    }catch(error){ reportError(error); }
  }
  async function addReferences(){
    try{
      const next=await bridge.addReferences();
      if(!next)return;
      job=next;
      ui.replaceAssets(job.references,job.globalReferenceIds);
      applyPreviewReferences();
      ui.showToast("REFERENCES ADDED");
    }catch(error){ reportError(error); }
  }
  async function addDroppedReferences(files){
    try{
      if(!files?.length)return;
      const paths=Array.from(files,file=>bridge.getPathForFile(file)).filter(Boolean);
      if(!paths.length)return;
      const next=await bridge.addDroppedReferences(paths);
      if(!next)return;
      job=next;
      ui.replaceAssets(job.references,job.globalReferenceIds);
      applyPreviewReferences();
      ui.showToast("REFERENCES ADDED");
    }catch(error){ reportError(error); }
  }
  async function deleteReference(id){
    try{
      if(!id||!bridge?.deleteReference)return;
      clearTimeout(saveTimer);
      const result=await bridge.deleteReference(id);
      if(!result?.job)return;
      job=result.job;
      ui.replaceAssets(job.references,job.globalReferenceIds);
      ui.applyShotMappings(job.shotMappings||{});
      applyPreviewReferences(ui.snapshot());
      ui.showToast(result.warning?"REFERENCE REMOVED · FILE CLEANUP FAILED":"REFERENCE DELETED");
    }catch(error){ reportError(error); }
  }
  async function exportVideo(){
    ui.setOverlayOpen(false);
    try{
      await persistProjectTitle();
      await persistCalloutSettings(true);
      const durationSeconds=timeline?.durationFrames&&timeline?.fps?timeline.durationFrames/timeline.fps:0;
      await bridge.openExportDialog({
        durationSeconds,
        sourceFps:timeline?.fps||0,
        editCount:timeline?.edits||0,
      });
    }catch(error){ await reportError(error) }
  }
  function syncActiveShot(id){ ui.syncShotSelection(Number(id)); }
  async function initialize(){
    if(!bridge){
      ui.showToast("OPEN WITH ELECTRON");
      return;
    }
    try{
      job=await bridge.getJob();
      ui.replaceAssets(job.references,job.globalReferenceIds);
      const target=await waitForPreview();
      if(job.video?.url)target?.setVideo(job.video.url);
      const xml=job.xml?await bridge.readXml():null;
      if(xml)await parseXml(xml);
      else{
        timeline=null;
        ui.replaceShots([],job.shotMappings||{});
        setStatus();
        applyPreviewReferences();
        applyProjectTitle();
        applyCalloutSettings();
      }
      initialized=true;
      await bridge.log("renderer_ready",{
        hasXml:Boolean(job.xml),
        hasVideo:Boolean(job.video),
        referenceCount:job.references.length,
      });
    }catch(error){ reportError(error); }
  }

  window.portableMvp={loadXml,loadVideo,addReferences,addDroppedReferences,deleteReference,loadXmlText,syncActiveShot,exportVideo};
  bridge?.onProjectTitleUpdated(projectTitle=>applyProjectTitle(projectTitle));
  window.addEventListener("wireframechange",scheduleSave);
  const projectTitleInput=document.getElementById("overlayProjectTitle");
  projectTitleInput?.addEventListener("input",event=>scheduleProjectTitleSave(event.currentTarget.value));
  projectTitleInput?.addEventListener("blur",()=>persistProjectTitle().catch(reportError));
  projectTitleInput?.addEventListener("keydown",event=>{
    if(event.key==="Enter")event.currentTarget.blur();
  });
  for(const id of ["calloutEnabled","calloutPosition","calloutStyle","calloutStart","calloutDuration","calloutSubtitle"]){
    const control=document.getElementById(id);
    control?.addEventListener("input",scheduleCalloutSave);
    control?.addEventListener("change",scheduleCalloutSave);
    if(["calloutStart","calloutDuration","calloutSubtitle"].includes(id)){
      control?.addEventListener("blur",()=>persistCalloutSettings(true).catch(reportError));
    }
  }
  initialize();
})();
