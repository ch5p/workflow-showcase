(function(root,factory){
  "use strict";
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.PortableCapCutDraft=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const FORMAT="capcut-draft";
  const SNAPSHOT_SCHEMA_VERSION=1;
  const SUPPORTED_MAJOR_VERSION=9;
  const MICROSECONDS_PER_SECOND=1000000;

  function isPlainObject(value){
    return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
  }

  function safeText(value,fallback=""){
    const text=String(value??"")
      .replace(/[\x00-\x1f\x7f]/g,"_")
      .replace(/\s+/g," ")
      .trim();
    return text||fallback;
  }

  function baseName(value){
    const normalized=String(value||"").replace(/\\/g,"/").replace(/\/+$/g,"");
    return safeText(normalized.split("/").pop(),"(unnamed)").slice(0,255);
  }

  function normalizeSourceIdentity(value){
    let normalized=String(value||"").trim();
    try{normalized=decodeURI(normalized)}catch{}
    return normalized.replace(/^file:\/\/localhost\//i,"/").replace(/\\/g,"/").toLowerCase();
  }

  function portableFingerprint(prefix,value){
    const text=String(value||"").normalize("NFKC").toLowerCase();
    let left=0x811c9dc5;
    let right=0x9e3779b9;
    for(let index=0;index<text.length;index++){
      const code=text.charCodeAt(index);
      left=Math.imul(left^code,0x01000193)>>>0;
      right=Math.imul(right^(code+index),0x85ebca6b)>>>0;
    }
    return prefix+"-"+left.toString(16).padStart(8,"0")+right.toString(16).padStart(8,"0");
  }

  function parseJson(text,label){
    if(typeof text!=="string"||!text.trim())throw new Error(label+" is empty");
    try{return JSON.parse(text)}catch{throw new Error(label+" is not valid JSON")}
  }

  function editorVersionOf(data){
    return safeText(data?.platform?.app_version||data?.last_modified_platform?.app_version,"unknown");
  }

  function assertSupportedDraft(data){
    if(!isPlainObject(data))throw new Error("CapCut draft root must be an object");
    const appSource=safeText(data?.platform?.app_source||data?.last_modified_platform?.app_source).toLowerCase();
    if(appSource!=="cc")throw new Error("The selected JSON is not a CapCut Desktop draft");
    const editorVersion=editorVersionOf(data);
    const major=Number.parseInt(editorVersion.split(".")[0],10);
    if(major!==SUPPORTED_MAJOR_VERSION){
      throw new Error("Unsupported CapCut Desktop version: "+editorVersion+" (expected 9.x)");
    }
    return editorVersion;
  }

  function frameFromMicroseconds(value,fps){
    const microseconds=Number(value);
    if(!Number.isFinite(microseconds))return NaN;
    return Math.round(microseconds*fps/MICROSECONDS_PER_SECOND);
  }

  function materialSourceKey(material){
    const source=normalizeSourceIdentity(material?.path||material?.media_path||"");
    if(source)return "path:"+source;
    const fallback=safeText(material?.origin_material_id||material?.local_material_id||material?.unique_id||material?.id);
    return fallback?"material:"+fallback:"";
  }

  function materialName(material){
    return baseName(material?.path||material?.media_path||material?.material_name||material?.id);
  }

  function validateNormalizedTimeline(timeline){
    if(!isPlainObject(timeline))throw new Error("Normalized CapCut timeline is invalid");
    const fps=Number(timeline.fps);
    const duration=Number(timeline.duration);
    if(!Number.isFinite(fps)||fps<=0||fps>240)throw new Error("CapCut timeline FPS is invalid");
    if(!Number.isSafeInteger(duration)||duration<=0)throw new Error("CapCut timeline duration is invalid");
    if(!Array.isArray(timeline.clips)||!timeline.clips.length)throw new Error("CapCut timeline has no supported video clips");
    for(const clip of timeline.clips){
      for(const key of ["track","start","end","in","out"]){
        if(!Number.isSafeInteger(clip?.[key]))throw new Error("CapCut clip "+key+" must be an integer frame");
      }
      if(clip.track<=0||clip.start<0||clip.end<=clip.start||clip.end>duration||clip.in<0||clip.out<clip.in){
        throw new Error("CapCut clip frame range is invalid");
      }
      if(typeof clip.name!=="string"||typeof clip.fileId!=="string"||typeof clip.sourceId!=="string"||!clip.sourceId){
        throw new Error("CapCut clip identity is invalid");
      }
    }
    if(!Array.isArray(timeline.warns))throw new Error("CapCut warnings must be an array");
    if(timeline.workArea!==null)throw new Error("CapCut work area is not supported in this adapter version");
    return timeline;
  }

  function inspectCapCutDraft(text,{projectName=""}={}){
    const data=parseJson(text,"CapCut draft_content.json");
    const editorVersion=assertSupportedDraft(data);
    const fps=Number(data.fps);
    if(!Number.isFinite(fps)||fps<=0||fps>240)throw new Error("CapCut project FPS is invalid");
    const declaredDuration=frameFromMicroseconds(data.duration,fps);
    if(!Number.isSafeInteger(declaredDuration)||declaredDuration<=0)throw new Error("CapCut project duration is invalid");

    const videos=Array.isArray(data?.materials?.videos)?data.materials.videos:[];
    const materials=new Map(videos.filter(isPlainObject).map(material=>[String(material.id||""),material]));
    const tracks=Array.isArray(data.tracks)?data.tracks:[];
    const clips=[];
    const warns=[];
    let contentEnd=0;

    tracks.forEach((track,trackIndex)=>{
      if(track?.type!=="video")return;
      const segments=Array.isArray(track.segments)?track.segments:[];
      segments.forEach((segment,segmentIndex)=>{
        const materialId=String(segment?.material_id||"");
        const material=materials.get(materialId);
        if(!material){
          warns.push("skip missing video material at track "+(trackIndex+1)+", segment "+(segmentIndex+1));
          return;
        }
        if(String(material.type||"video").toLowerCase()!=="video"||segment.is_placeholder===true){
          warns.push("skip unsupported non-video material: "+materialName(material));
          return;
        }
        const targetStartUs=Number(segment?.target_timerange?.start);
        const targetDurationUs=Number(segment?.target_timerange?.duration);
        const sourceStartUs=Number(segment?.source_timerange?.start)||0;
        const sourceDurationUs=Number(segment?.source_timerange?.duration);
        const start=frameFromMicroseconds(targetStartUs,fps);
        const end=frameFromMicroseconds(targetStartUs+targetDurationUs,fps);
        const sourceIn=frameFromMicroseconds(sourceStartUs,fps);
        const sourceOut=frameFromMicroseconds(sourceStartUs+sourceDurationUs,fps);
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||!Number.isSafeInteger(sourceIn)||
            !Number.isSafeInteger(sourceOut)||start<0||end<=start||sourceIn<0||sourceOut<sourceIn){
          warns.push("skip invalid video range: "+materialName(material));
          return;
        }
        const sourceKey=materialSourceKey(material);
        if(!sourceKey){
          warns.push("skip video without stable source identity: "+materialName(material));
          return;
        }
        const renderIndex=Number(segment.render_index);
        const trackRenderIndex=Number(segment.track_render_index);
        const resolvedTrack=Number.isSafeInteger(renderIndex)&&renderIndex>=0
          ?renderIndex+1
          :Number.isSafeInteger(trackRenderIndex)&&trackRenderIndex>=0?trackRenderIndex+1:trackIndex+1;
        clips.push({
          track:resolvedTrack,
          name:materialName(material),
          start,
          end,
          in:sourceIn,
          out:sourceOut,
          enabled:segment.visible!==false,
          fileId:materialId,
          sourceId:portableFingerprint("capcut-src",sourceKey),
        });
        contentEnd=Math.max(contentEnd,end);
      });
    });

    const duration=Math.max(declaredDuration,contentEnd);
    const timeline=validateNormalizedTimeline({
      fps,
      duration,
      name:safeText(projectName||data.name,"CapCut project"),
      clips,
      warns,
      workArea:null,
    });
    return {editorVersion,timeline};
  }

  function parseCapCutDraft(text,options){
    return inspectCapCutDraft(text,options).timeline;
  }

  function createCapCutSnapshot(text,{projectName="",sourceName="draft_content.json"}={}){
    const inspected=inspectCapCutDraft(text,{projectName});
    return {
      schemaVersion:SNAPSHOT_SCHEMA_VERSION,
      format:FORMAT,
      editorVersion:inspected.editorVersion,
      sourceName:safeText(sourceName,"draft_content.json"),
      timeline:inspected.timeline,
    };
  }

  function parseCapCutSnapshot(text){
    const snapshot=parseJson(text,"Workflow Showcase CapCut snapshot");
    if(!isPlainObject(snapshot)||snapshot.schemaVersion!==SNAPSHOT_SCHEMA_VERSION||snapshot.format!==FORMAT){
      throw new Error("Unsupported Workflow Showcase CapCut snapshot");
    }
    const editorVersion=safeText(snapshot.editorVersion,"unknown");
    const major=Number.parseInt(editorVersion.split(".")[0],10);
    if(major!==SUPPORTED_MAJOR_VERSION)throw new Error("Unsupported CapCut snapshot version: "+editorVersion);
    return validateNormalizedTimeline(snapshot.timeline);
  }

  return {
    FORMAT,
    SNAPSHOT_SCHEMA_VERSION,
    SUPPORTED_MAJOR_VERSION,
    frameFromMicroseconds,
    normalizeSourceIdentity,
    portableFingerprint,
    inspectCapCutDraft,
    parseCapCutDraft,
    createCapCutSnapshot,
    parseCapCutSnapshot,
    validateNormalizedTimeline,
  };
});
