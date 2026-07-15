(function(root,factory){
  "use strict";
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.PortableXmeml=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const PPRO_TICKS=254016000000;

  function childText(element,tag){
    if(!element)return "";
    for(const child of element.children||[]){
      if(child.tagName===tag)return child.textContent.trim();
    }
    return "";
  }

  function normalizeSourcePath(value){
    let normalized=String(value||"").trim();
    try{normalized=decodeURI(normalized)}catch{}
    return normalized.replace(/^file:\/\/localhost\//i,"/").replace(/\\/g,"/").toLowerCase();
  }

  function parseXmeml(text,{DOMParserClass=globalThis.DOMParser}={}){
    if(typeof DOMParserClass!=="function")throw new Error("DOMParser unavailable");
    const doc=new DOMParserClass().parseFromString(text,"application/xml");
    if(doc.querySelector("parsererror"))throw new Error("XML 파싱 실패");
    const sequence=doc.querySelector("sequence");
    if(!sequence)throw new Error("sequence 노드 없음 (Final Cut XML인지 확인)");

    const rateElement=[...sequence.children].find(child=>child.tagName==="rate");
    const fps=parseInt(childText(rateElement,"timebase"),10)||24;
    const declaredDuration=parseInt(childText(sequence,"duration"),10)||0;
    const ticksPerFrame=PPRO_TICKS/fps;
    const clips=[];
    const warnings=[];
    const fileSources=new Map();

    doc.querySelectorAll("file[id]").forEach(file=>{
      const fileId=file.getAttribute("id")||"";
      const sourcePath=normalizeSourcePath(childText(file,"pathurl"));
      // Premiere repeats file references without pathurl; the complete node owns source identity.
      if(fileId&&sourcePath&&!fileSources.has(fileId))fileSources.set(fileId,sourcePath);
    });

    let contentEnd=0;
    sequence.querySelectorAll("media > video > track").forEach((track,trackIndex)=>{
      [...track.children].forEach(node=>{
        if(node.tagName==="transitionitem"){
          const transitionEnd=parseInt(childText(node,"end"),10);
          if(transitionEnd>0)contentEnd=Math.max(contentEnd,transitionEnd);
          return;
        }
        if(node.tagName!=="clipitem")return;

        let start=parseInt(childText(node,"start"),10);
        let end=parseInt(childText(node,"end"),10);
        const sourceIn=parseInt(childText(node,"in"),10)||0;
        const sourceOut=parseInt(childText(node,"out"),10)||0;
        // Transition-bound clipitems may use -1. Preserve the legacy duration-based recovery.
        if(start===-1&&end>0)start=end-(sourceOut-sourceIn);
        if(end===-1&&start>=0)end=start+(sourceOut-sourceIn);

        const name=childText(node,"name")||"(unnamed)";
        const enabled=childText(node,"enabled").toUpperCase()!=="FALSE";
        const fileNode=[...node.children].find(child=>child.tagName==="file");
        const fileId=fileNode?fileNode.getAttribute("id")||"":"";
        const inlinePath=normalizeSourcePath(childText(fileNode,"pathurl"));
        const sourcePath=inlinePath||fileSources.get(fileId)||"";
        const sourceId=sourcePath?("path:"+sourcePath):(fileId?("file:"+fileId):"");
        if(!(end>start)||start<0){
          warnings.push("skip: "+name);
          return;
        }
        clips.push({
          track:trackIndex+1,
          name,
          start,
          end,
          in:sourceIn,
          out:sourceOut,
          enabled,
          fileId,
          sourceId,
        });
        contentEnd=Math.max(contentEnd,end);
      });
    });

    if(!clips.length)throw new Error("비디오 클립을 찾지 못함");
    const duration=Math.max(declaredDuration,contentEnd);
    let workArea=null;
    const workIn=sequence.getAttribute("MZ.WorkInPoint");
    const workOut=sequence.getAttribute("MZ.WorkOutPoint");
    if(workIn&&workOut){
      const start=Math.round(Number(workIn)/ticksPerFrame);
      const end=Math.min(Math.round(Number(workOut)/ticksPerFrame),duration);
      if(end>start&&start>=0)workArea={in:start,out:end};
    }

    return {
      fps,
      duration,
      name:childText(sequence,"name")||"sequence",
      clips,
      warns:warnings,
      workArea,
    };
  }

  return {PPRO_TICKS,childText,normalizeSourcePath,parseXmeml};
});
