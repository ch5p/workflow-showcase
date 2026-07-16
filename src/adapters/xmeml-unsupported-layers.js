(function(root,factory){
  "use strict";
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.PortableUnsupportedXmeml=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  function childText(element,tag){
    if(!element)return "";
    for(const child of element.children||[]){
      if(child.tagName===tag)return String(child.textContent||"").trim();
    }
    return "";
  }

  function directChild(element,tag){
    return [...(element?.children||[])].find(child=>child.tagName===tag)||null;
  }

  function normalizeLabel(value){
    return String(value||"").normalize("NFKC").toLowerCase().replace(/[\s_-]+/g," ").trim();
  }

  function isUnsupportedAdjustmentLayer(descriptor){
    const mediaSource=normalizeLabel(descriptor?.mediaSource);
    const clipName=normalizeLabel(descriptor?.clipName);
    const fileName=normalizeLabel(descriptor?.fileName);
    const hasRealMediaPath=Boolean(String(descriptor?.pathUrl||"").trim());
    const namedAdjustment=/\badjustment layer\b/.test(clipName)||clipName.includes("조정 레이어");
    const generatedBlackVideo=/\bblack video\b/.test(fileName)||fileName.includes("검정 비디오");

    // Premiere exports Adjustment Layers as pathless Slug media. Require that
    // signature so a normal file merely named "Adjustment Layer" is retained.
    return !hasRealMediaPath&&mediaSource==="slug"&&(
      namedAdjustment||(Boolean(descriptor?.hasFilter)&&generatedBlackVideo)
    );
  }

  function clipKey(descriptor){
    return JSON.stringify([
      Number(descriptor?.track)||0,
      String(descriptor?.name||""),
      Number(descriptor?.start)||0,
      Number(descriptor?.end)||0,
      Number(descriptor?.in)||0,
      Number(descriptor?.out)||0,
      String(descriptor?.fileId||""),
    ]);
  }

  function readFileMetadata(doc){
    const files=new Map();
    doc.querySelectorAll("file[id]").forEach(file=>{
      const id=file.getAttribute("id")||"";
      if(!id)return;
      const current=files.get(id)||{pathUrl:"",mediaSource:"",fileName:""};
      const next={
        pathUrl:childText(file,"pathurl"),
        mediaSource:childText(file,"mediaSource"),
        fileName:childText(file,"name"),
      };
      for(const key of Object.keys(current)){
        if(!current[key]&&next[key])current[key]=next[key];
      }
      files.set(id,current);
    });
    return files;
  }

  function collectUnsupportedClipKeys(text,{DOMParserClass=globalThis.DOMParser}={}){
    if(typeof DOMParserClass!=="function")throw new Error("DOMParser unavailable");
    const doc=new DOMParserClass().parseFromString(text,"application/xml");
    if(doc.querySelector("parsererror"))throw new Error("XML parsing failed");
    const sequence=doc.querySelector("sequence");
    if(!sequence)return new Set();
    const fileMetadata=readFileMetadata(doc);
    const ignored=new Set();

    sequence.querySelectorAll("media > video > track").forEach((track,trackIndex)=>{
      [...track.children].forEach(node=>{
        if(node.tagName!=="clipitem")return;
        const fileNode=directChild(node,"file");
        const fileId=fileNode?.getAttribute("id")||"";
        const storedFile=fileMetadata.get(fileId)||{};
        const descriptor={
          clipName:childText(node,"name"),
          fileName:childText(fileNode,"name")||storedFile.fileName||"",
          mediaSource:childText(fileNode,"mediaSource")||storedFile.mediaSource||"",
          pathUrl:childText(fileNode,"pathurl")||storedFile.pathUrl||"",
          hasFilter:Boolean(directChild(node,"filter")),
        };
        if(!isUnsupportedAdjustmentLayer(descriptor))return;

        let start=parseInt(childText(node,"start"),10);
        let end=parseInt(childText(node,"end"),10);
        const sourceIn=parseInt(childText(node,"in"),10)||0;
        const sourceOut=parseInt(childText(node,"out"),10)||0;
        if(start===-1&&end>0)start=end-(sourceOut-sourceIn);
        if(end===-1&&start>=0)end=start+(sourceOut-sourceIn);
        ignored.add(clipKey({
          track:trackIndex+1,
          name:childText(node,"name")||"(unnamed)",
          start,
          end,
          in:sourceIn,
          out:sourceOut,
          fileId,
        }));
      });
    });
    return ignored;
  }

  function excludeUnsupportedClipKeys(parsed,ignoredKeys){
    if(!ignoredKeys?.size)return parsed;
    const clips=(parsed?.clips||[]).filter(clip=>!ignoredKeys.has(clipKey(clip)));
    return clips.length===(parsed?.clips||[]).length?parsed:{...parsed,clips};
  }

  function excludeUnsupportedLayers(text,parsed,options){
    return excludeUnsupportedClipKeys(parsed,collectUnsupportedClipKeys(text,options));
  }

  return {
    isUnsupportedAdjustmentLayer,
    clipKey,
    collectUnsupportedClipKeys,
    excludeUnsupportedClipKeys,
    excludeUnsupportedLayers,
  };
});
