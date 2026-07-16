"use strict";

(() => {
  const bridge=window.portableApi;
  const ui=window.wireframeApi;
  const iframe=document.getElementById("renderPreview");
  let job=null;
  let timeline=null;
  let language="en";
  let initialized=false;
  let transitioning=false;
  let runtimeBlocked=false;
  let activeInputOperation=null;
  let lifecycleGeneration=0;
  let saveTimer=0;
  let titleSaveTimer=0;
  let calloutSaveTimer=0;
  let pendingSavePromise=Promise.resolve();
  const DEFAULT_CALLOUT={enabled:true,position:"left",style:"line",startSeconds:.08,durationSeconds:3.5,subtitle:"WORKFLOW SHOWCASE · EDIT WORKFLOW"};
  const INPUT_EXTENSIONS={xml:new Set([".xml"]),video:new Set([".mp4",".mov",".m4v"])};

  function preview(){ return iframe.contentWindow?.portablePreview||null; }
  function applyLanguage(next){
    language=next==="ko"?"ko":"en";
    try{window.applyEditorLanguage?.(language)}catch{}
    try{preview()?.setLanguage?.(language)}catch{}
  }
  async function setLanguage(next){
    applyLanguage(next);
    await saveJobPatch({ui:{language:language}});
    return language;
  }
  function waitForPreview(){
    if(preview())return Promise.resolve(preview());
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
    document.getElementById("jobName").textContent=job?.demo
      ?"SAMPLE JOB / "+(job.xml?.name||"NO XML")
      :(job?.xml?"CURRENT JOB / "+job.xml.name:"CURRENT JOB / NO XML");
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
  function applyPreviewReferences(snapshot){ preview()?.setReferences(previewReferenceState(snapshot)); }
  function normalizeProjectTitle(projectTitle){
    if(projectTitle===undefined||projectTitle===null)return "UNTITLED PROJECT";
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
  function clearSaveTimers(){
    clearTimeout(saveTimer);saveTimer=0;
    clearTimeout(titleSaveTimer);titleSaveTimer=0;
    clearTimeout(calloutSaveTimer);calloutSaveTimer=0;
  }
  async function safeRendererLog(event,detail={}){
    try{await bridge?.log(event,detail)}catch{}
  }
  function logPreviewEvent(event,detail={}){
    return safeRendererLog(event,detail);
  }
  async function performSaveJobPatch(patch,retry=true){
    if(!bridge||!job||transitioning||runtimeBlocked)return job;
    const expectedJobId=job.jobId;
    const expectedRevision=job.revision;
    const generation=lifecycleGeneration;
    const next=await bridge.saveJob({...patch,expectedJobId,expectedRevision});
    if(generation!==lifecycleGeneration||transitioning||runtimeBlocked)return job;
    if(next?.saveRejected==="JOB_STALE"){
      await safeRendererLog("renderer_stale_save_ignored",{expectedJobId});
      const {saveRejected,...current}=next;
      job=current;
      const sameJob=current.jobId===expectedJobId;
      if(!sameJob){
        lifecycleGeneration++;
        clearSaveTimers();
        await blockRuntime("CURRENT JOB CHANGED · USE ↻",new Error("Current Job identity changed on disk"));
        return current;
      }
      if(retry&&generation===lifecycleGeneration&&!transitioning&&!runtimeBlocked){
        return performSaveJobPatch(patch,false);
      }
      return current;
    }
    job=next;
    return next;
  }
  function saveJobPatch(patch){
    const queued=pendingSavePromise.then(
      ()=>performSaveJobPatch(patch),
      ()=>performSaveJobPatch(patch),
    );
    pendingSavePromise=queued.catch(()=>{});
    return queued;
  }
  async function persistProjectTitle(){
    if(!bridge||!job||transitioning||runtimeBlocked)return;
    clearTimeout(titleSaveTimer);titleSaveTimer=0;
    const input=document.getElementById("overlayProjectTitle");
    const title=applyProjectTitle(input?input.value:job.projectTitle);
    if(input&&document.activeElement!==input)input.value=title;
    await saveJobPatch({projectTitle:title});
  }
  function scheduleProjectTitleSave(value){
    if(transitioning||runtimeBlocked||activeInputOperation)return;
    const title=normalizeProjectTitle(value);
    if(job)job.projectTitle=title;
    preview()?.setProjectTitle(title);
    clearTimeout(titleSaveTimer);
    titleSaveTimer=setTimeout(()=>persistProjectTitle().catch(reportError),160);
  }
  async function persistCalloutSettings(syncControls=false){
    if(!bridge||!job||transitioning||runtimeBlocked)return;
    clearTimeout(calloutSaveTimer);calloutSaveTimer=0;
    const callout=applyCalloutSettings(readCalloutControls(),{syncControls});
    await saveJobPatch({callout});
  }
  function scheduleCalloutSave(){
    if(transitioning||runtimeBlocked||activeInputOperation)return job?.callout;
    const callout=applyCalloutSettings(readCalloutControls(),{syncControls:false});
    clearTimeout(calloutSaveTimer);
    calloutSaveTimer=setTimeout(()=>persistCalloutSettings().catch(reportError),160);
    return callout;
  }
  function mountTimeline(parsed,{emitChange=false}={}){
    timeline=parsed;
    const shots=parsed.shots.map(shot=>({
      id:shot.id,
      edits:shot.edits,
      start:shot.startFrame/parsed.fps,
      end:shot.endFrame/parsed.fps,
      range:tc(shot.startFrame,parsed.fps)+"–"+tc(shot.endFrame,parsed.fps),
    }));
    ui.replaceShots(shots,job?.shotMappings||{},emitChange);
    setStatus();
    applyPreviewReferences();
    applyProjectTitle();
    applyCalloutSettings();
  }
  async function parseXml(text,{emitChange=false}={}){
    const target=await waitForPreview();
    if(!target)throw new Error("Preview bridge is not ready");
    mountTimeline(target.loadXml(text),{emitChange});
  }
  async function loadXmlText(text){
    await parseXml(text,{emitChange:false});
    return {fps:timeline.fps,durationFrames:timeline.durationFrames,edits:timeline.edits,shots:timeline.shots.length};
  }
  async function saveMapping(){
    if(!initialized||!bridge||transitioning||runtimeBlocked)return;
    const snapshot=ui.snapshot();
    applyPreviewReferences(snapshot);
    await saveJobPatch({
      globalReferenceIds:snapshot.globalReferenceIds,
      shotMappings:snapshot.shotMappings,
      projectTitle:job?.projectTitle,
      callout:job?.callout,
    });
  }
  function scheduleSave(){
    if(!initialized||transitioning||runtimeBlocked||activeInputOperation)return;
    clearTimeout(saveTimer);
    saveTimer=setTimeout(()=>saveMapping().catch(reportError),120);
  }
  async function reportError(error,toastMessage){
    const message=error?.message||String(error);
    ui.showToast(toastMessage||error?.toastMessage||"ERROR · CHECK APP LOG");
    await safeRendererLog("renderer_error",{message});
  }
  function inputError(message){
    const error=new Error(message);
    error.toastMessage=message;
    return error;
  }
  function droppedPath(files,kind){
    const list=Array.from(files||[]);
    if(list.length!==1)throw inputError((kind==="xml"?"XML":"VIDEO")+" · DROP ONE FILE");
    const file=list[0];
    const name=String(file.name||"");
    const dot=name.lastIndexOf(".");
    const extension=dot>=0?name.slice(dot).toLowerCase():"";
    if(!INPUT_EXTENSIONS[kind].has(extension)){
      throw inputError(kind==="xml"?"XML ONLY · .XML":"VIDEO ONLY · MP4/MOV/M4V");
    }
    const sourcePath=bridge.getPathForFile(file);
    if(!sourcePath)throw inputError("DROP PATH UNAVAILABLE");
    return sourcePath;
  }
  function beginInputOperation(kind){
    if(activeInputOperation||transitioning||runtimeBlocked)return false;
    activeInputOperation=kind;
    for(const id of ["loadXml","loadVideo"]){
      const root=document.getElementById(id);
      if(!root)continue;
      root.disabled=true;
      root.classList.add("importing");
      root.classList.remove("dropInvalid","dragOver");
      root.setAttribute("aria-busy","true");
    }
    return true;
  }
  function endInputOperation(){
    activeInputOperation=null;
    for(const id of ["loadXml","loadVideo"]){
      const root=document.getElementById(id);
      if(!root)continue;
      root.disabled=runtimeBlocked;
      root.classList.remove("importing","dragOver");
      root.setAttribute("aria-busy","false");
    }
  }
  function markInputInvalid(id){
    const root=document.getElementById(id);
    if(!root)return;
    root.classList.remove("importing","dragOver");
    root.classList.add("dropInvalid");
    root.setAttribute("aria-busy","false");
    setTimeout(()=>root.classList.remove("dropInvalid"),900);
  }
  async function flushPendingState(){
    await pendingSavePromise.catch(()=>{});
    if(!initialized||!job||transitioning||runtimeBlocked)return;
    clearSaveTimers();
    const snapshot=ui.snapshot();
    const input=document.getElementById("overlayProjectTitle");
    const title=applyProjectTitle(input?input.value:job.projectTitle);
    const callout=applyCalloutSettings(readCalloutControls(),{syncControls:true});
    applyPreviewReferences(snapshot);
    await saveJobPatch({
      globalReferenceIds:snapshot.globalReferenceIds,
      shotMappings:snapshot.shotMappings,
      projectTitle:title,
      callout,
    });
  }
  async function blockRuntime(message,error){
    runtimeBlocked=true;
    initialized=false;
    transitioning=false;
    clearSaveTimers();
    for(const id of ["loadXml","loadVideo"]){
      const root=document.getElementById(id);
      if(root){root.disabled=true;root.classList.remove("importing","dragOver");root.setAttribute("aria-busy","false")}
    }
    ui.showToast(message);
    await safeRendererLog("job_runtime_blocked",{message:error?.message||String(error||message)});
  }
  async function hydrateJobState(nextJob,{xmlText=null}={}){
    job=nextJob;
    const target=await waitForPreview();
    ui.replaceAssets(job.references||[],job.globalReferenceIds||[]);
    await target?.clearVideo?.();
    if(job.video?.url)target?.setVideo(job.video.url);
    const text=xmlText??(job.xml?await bridge.readXml():null);
    if(text)await parseXml(text,{emitChange:false});
    else{
      timeline=null;
      ui.replaceShots([],job.shotMappings||{},false);
      setStatus();
      applyPreviewReferences();
      applyProjectTitle();
      applyCalloutSettings();
    }
  }
  async function restoreCurrentJobView(){
    const current=await bridge.getJob();
    await hydrateJobState(current);
  }
  async function releaseCurrentJobView(){
    const target=await waitForPreview();
    if(target?.releaseMedia)await target.releaseMedia({references:true});
    else{
      await target?.clearVideo?.();
      target?.setReferences?.({references:[],globalReferenceIds:[],shotMappings:{},shots:[]});
    }
    target?.setProjectTitle?.("");
    target?.setCalloutConfig?.(DEFAULT_CALLOUT);
    ui.replaceAssets([],[]);
    ui.replaceShots([],{},false);
    timeline=null;
    setStatus();
    const titleInput=document.getElementById("overlayProjectTitle");
    if(titleInput)titleInput.value="";
  }
  async function importXmlCandidate(prepareCandidate){
    let prepared=null;
    let validationPassed=false;
    let viewReleased=false;
    let committed=false;
    let mode=null;
    try{
      prepared=await prepareCandidate();
      if(!prepared)return false;
      const target=await waitForPreview();
      if(!target?.inspectXml)throw new Error("Preview XML inspector is not ready");
      const candidateTimeline=target.inspectXml(prepared.text);
      validationPassed=true;
      mode=await bridge.chooseXmlImportMode(prepared.token);
      if(!mode){
        ui.showToast("XML LOAD CANCELLED");
        return false;
      }
      const expectedJobId=job?.jobId;
      const expectedRevision=job?.revision;
      const previousTimelineShots=timeline?.shots||[];
      transitioning=true;
      initialized=false;
      lifecycleGeneration++;
      clearSaveTimers();
      if(mode==="new"){
        viewReleased=true;
        await releaseCurrentJobView();
      }
      const result=await bridge.commitXmlImport({
        token:prepared.token,
        expectedJobId,
        expectedRevision,
        previousTimelineShots,
        nextTimelineShots:candidateTimeline.shots,
      });
      committed=true;
      try{
        if(result.mode==="update"){
          job=result.job;
          await parseXml(prepared.text,{emitChange:false});
        }else{
          await hydrateJobState(result.job,{xmlText:prepared.text});
        }
      }catch(firstHydrateError){
        try{
          await restoreCurrentJobView();
          await safeRendererLog("job_view_recovered_after_commit",{jobId:result.job.jobId,mode:result.mode});
          ui.showToast((result.mode==="update"?"XML UPDATED":"NEW JOB SAVED")+" · VIEW RECOVERED");
          return true;
        }catch(retryError){
          firstHydrateError.toastMessage=(result.mode==="update"?"XML UPDATED":"NEW JOB SAVED")+" · RESTART APP";
          await blockRuntime(firstHydrateError.toastMessage,retryError);
          throw firstHydrateError;
        }
      }
      if(result.mode==="update"){
        const summary=result.summary||{};
        const reattached=Number(summary.reattached)||0;
        ui.showToast(
          "XML UPDATED · "+(Number(summary.preserved)||0)+" KEPT · "+
          (Number(summary.newShots)||0)+" NEW · "+(Number(summary.orphaned)||0)+" ORPHAN"+
          (reattached?" · "+reattached+" RESTORED":""),
        );
        await safeRendererLog("renderer_xml_update_applied",summary);
      }else ui.showToast("NEW JOB LOADED");
      return true;
    }catch(error){
      if(prepared&&!committed){
        try{await bridge.discardPreparedXml(prepared.token,validationPassed?"commit-failed":"validation-failed")}catch(discardError){}
      }
      const recoveryRequired=/JOB_RECOVERY_REQUIRED|rollback failed/i.test(error?.message||"");
      if(recoveryRequired){
        await blockRuntime("JOB RECOVERY REQUIRED · RESTART APP",error);
      }else if(viewReleased&&!committed){
        try{await restoreCurrentJobView()}catch(restoreError){
          await blockRuntime("CURRENT JOB VIEW FAILED · RESTART APP",restoreError);
        }
      }
      if(!error.toastMessage){
        error.toastMessage=runtimeBlocked
          ?"JOB RECOVERY REQUIRED · RESTART APP"
          :(validationPassed
            ?(mode==="new"?"NEW JOB FAILED · CURRENT JOB RESTORED":"XML UPDATE FAILED · CURRENT JOB KEPT")
            :"XML REJECTED · CURRENT JOB KEPT");
      }
      throw error;
    }finally{
      if(transitioning){
        transitioning=false;
        initialized=!runtimeBlocked;
      }
    }
  }
  async function loadXml(){
    if(!beginInputOperation("xml"))return true;
    try{
      await flushPendingState();
      await importXmlCandidate(()=>bridge.selectXml());
    }catch(error){await reportError(error)}
    finally{endInputOperation()}
    return true;
  }
  async function loadDroppedXml(files){
    if(!beginInputOperation("xml"))return true;
    try{
      await flushPendingState();
      const sourcePath=droppedPath(files,"xml");
      await importXmlCandidate(()=>bridge.prepareDroppedXml(sourcePath));
    }catch(error){markInputInvalid("loadXml");await reportError(error)}
    finally{endInputOperation()}
    return true;
  }
  async function applyVideoImport(prepareVideo){
    if(!job)throw new Error("Current Job is not ready");
    let prepared=null;
    let committed=false;
    let viewReleased=false;
    let preflightPassed=false;
    const previousJob=job;
    try{
      prepared=await prepareVideo();
      if(!prepared)return false;
      const target=await waitForPreview();
      if(!prepared.candidateUrl||typeof target?.preflightVideo!=="function"){
        throw new Error("Video preflight is unavailable");
      }
      try{
        const metadata=await target.preflightVideo(prepared.candidateUrl);
        preflightPassed=true;
        await safeRendererLog("video_import_preflight_passed",{
          durationSeconds:metadata.duration,
          width:metadata.width,
          height:metadata.height,
        });
      }catch(error){
        await safeRendererLog("video_import_preflight_failed",{message:error.message});
        error.toastMessage="VIDEO REJECTED · CURRENT VIDEO KEPT";
        throw error;
      }
      const expectedJobId=job.jobId;
      const expectedRevision=job.revision;
      transitioning=true;
      initialized=false;
      lifecycleGeneration++;
      clearSaveTimers();
      if(target?.releaseMedia)await target.releaseMedia({references:false});
      else await target?.clearVideo?.();
      viewReleased=true;
      const next=await bridge.commitVideo({token:prepared.token,expectedJobId,expectedRevision});
      committed=true;
      job=next;
      target?.setVideo(job.video.url);
      ui.showToast("VIDEO LOADED");
      return true;
    }catch(error){
      if(prepared&&!committed){
        try{await bridge.discardPreparedVideo(prepared.token,preflightPassed?"commit-failed":"preflight-failed")}catch{}
      }
      const recoveryRequired=/JOB_RECOVERY_REQUIRED|rollback failed/i.test(error?.message||"");
      if(recoveryRequired){
        await blockRuntime("JOB RECOVERY REQUIRED · RESTART APP",error);
      }else if(viewReleased){
        try{
          if(committed)await restoreCurrentJobView();
          else{
            job=previousJob;
            if(previousJob.video?.url)(await waitForPreview())?.setVideo(previousJob.video.url);
          }
        }catch(restoreError){
          await blockRuntime("CURRENT JOB VIEW FAILED · RESTART APP",restoreError);
        }
      }
      if(!error.toastMessage){
        error.toastMessage=runtimeBlocked
          ?"JOB RECOVERY REQUIRED · RESTART APP"
          :(committed?"VIDEO SAVED · VIEW RECOVERED":"VIDEO IMPORT FAILED · CURRENT VIDEO RESTORED");
      }
      throw error;
    }finally{
      if(transitioning){
        transitioning=false;
        initialized=!runtimeBlocked;
      }
    }
  }
  async function loadVideo(){
    if(!beginInputOperation("video"))return true;
    try{
      await flushPendingState();
      await applyVideoImport(()=>bridge.selectVideo());
    }
    catch(error){await reportError(error,"VIDEO IMPORT FAILED · CHECK APP LOG")}
    finally{endInputOperation()}
    return true;
  }
  async function loadDroppedVideo(files){
    if(!beginInputOperation("video"))return true;
    try{
      await flushPendingState();
      const sourcePath=droppedPath(files,"video");
      await applyVideoImport(()=>bridge.prepareDroppedVideo(sourcePath));
    }catch(error){markInputInvalid("loadVideo");await reportError(error,error?.toastMessage||"VIDEO IMPORT FAILED · CHECK APP LOG")}
    finally{endInputOperation()}
    return true;
  }
  async function addReferences(){
    if(transitioning||runtimeBlocked)return;
    try{
      await flushPendingState();
      const previousCount=job?.references?.length||0;
      const next=await bridge.addReferences(job?.jobId,job?.revision);
      if(!next)return;
      lifecycleGeneration++;
      job=next;
      ui.replaceAssets(job.references,job.globalReferenceIds);
      applyPreviewReferences();
      ui.showToast(job.references.length>previousCount?"REFERENCES ADDED":"NO SUPPORTED FILES");
    }catch(error){reportError(error)}
  }
  async function addDroppedReferences(files){
    if(transitioning||runtimeBlocked)return;
    try{
      if(!files?.length)return;
      await flushPendingState();
      const paths=Array.from(files,file=>bridge.getPathForFile(file)).filter(Boolean);
      if(!paths.length)return;
      const previousCount=job?.references?.length||0;
      const next=await bridge.addDroppedReferences(paths,job?.jobId,job?.revision);
      if(!next)return;
      lifecycleGeneration++;
      job=next;
      ui.replaceAssets(job.references,job.globalReferenceIds);
      applyPreviewReferences();
      ui.showToast(job.references.length>previousCount?"REFERENCES ADDED":"NO SUPPORTED FILES");
    }catch(error){reportError(error)}
  }
  async function deleteReference(id){
    if(transitioning||runtimeBlocked)return;
    try{
      if(!id||!bridge?.deleteReference)return;
      await flushPendingState();
      clearTimeout(saveTimer);saveTimer=0;
      const result=await bridge.deleteReference(id,job?.jobId,job?.revision);
      if(!result?.job)return;
      lifecycleGeneration++;
      job=result.job;
      ui.replaceAssets(job.references,job.globalReferenceIds);
      ui.applyShotMappings(job.shotMappings||{});
      applyPreviewReferences(ui.snapshot());
      ui.showToast(result.warning?"REFERENCE REMOVED · FILE CLEANUP FAILED":"REFERENCE DELETED");
    }catch(error){reportError(error)}
  }
  async function backupCurrentJob(){
    if(transitioning||runtimeBlocked)return false;
    if(!bridge?.backupCurrentJob){
      ui.showToast("OPEN WITH ELECTRON");
      return false;
    }
    try{
      await flushPendingState();
      const result=await bridge.backupCurrentJob(job?.jobId,job?.revision);
      if(result)ui.showToast("BACKUP SAVED · "+result.backupName);
      return result;
    }catch(error){
      await reportError(error,"BACKUP FAILED · CHECK APP LOG");
      return false;
    }
  }
  async function exportVideo(){
    if(transitioning||runtimeBlocked)return;
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
    }catch(error){await reportError(error)}
  }
  async function reloadCurrentJob(){
    if(transitioning||activeInputOperation){
      ui.showToast("WAIT FOR CURRENT ACTION");
      return false;
    }
    clearSaveTimers();
    lifecycleGeneration++;
    initialized=false;
    try{
      await bridge?.reloadCurrentJob();
      return true;
    }catch(error){
      initialized=!runtimeBlocked;
      await reportError(error,"CURRENT JOB RELOAD FAILED");
      return false;
    }
  }
  function syncActiveShot(id){ ui.syncShotSelection(Number(id)); }
  async function initialize(){
    if(!bridge){ui.showToast("OPEN WITH ELECTRON");return}
    try{
      const [current,renderSpec,bootLanguage]=await Promise.all([
        bridge.getJob(),
        bridge.getRenderSpec(),
        bridge.getLanguage?.().catch(()=>"en")??"en",
      ]);
      const target=await waitForPreview();
      target?.setRenderSpec?.(renderSpec);
      ui.setRenderSpec?.(renderSpec);
      applyLanguage(bootLanguage);
      await hydrateJobState(current);
      initialized=true;
      await safeRendererLog("renderer_ready",{
        jobId:job.jobId,
        hasXml:Boolean(job.xml),
        hasVideo:Boolean(job.video),
        referenceCount:job.references.length,
      });
    }catch(error){reportError(error)}
  }

  window.portableMvp={
    loadXml,loadDroppedXml,loadVideo,loadDroppedVideo,
    addReferences,addDroppedReferences,deleteReference,backupCurrentJob,loadXmlText,syncActiveShot,exportVideo,reloadCurrentJob,logPreviewEvent,
    getLanguage:()=>language,setLanguage,
  };
  bridge?.onProjectTitleUpdated(projectTitle=>{if(!transitioning&&!runtimeBlocked)applyProjectTitle(projectTitle)});
  window.addEventListener("wireframechange",scheduleSave);
  const projectTitleInput=document.getElementById("overlayProjectTitle");
  projectTitleInput?.addEventListener("input",event=>scheduleProjectTitleSave(event.currentTarget.value));
  projectTitleInput?.addEventListener("blur",()=>persistProjectTitle().catch(reportError));
  projectTitleInput?.addEventListener("keydown",event=>{if(event.key==="Enter")event.currentTarget.blur()});
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
