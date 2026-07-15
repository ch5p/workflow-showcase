(function(root,factory){
  "use strict";
  const primary=typeof module==="object"&&module.exports
    ?require("./primary-timeline.js")
    :root.PortablePrimaryTimeline;
  const api=factory(primary);
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.PortableShotModel=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(primary){
  "use strict";

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

  function inspectTimeline(parsed){
    if(!primary?.buildPrimarySegments)throw new Error("PRIMARY timeline core unavailable");
    const segments=primary.buildPrimarySegments(parsed);
    if(!segments.length)throw new Error("활성 비디오 구간을 찾지 못함");
    const groups=new Map();
    segments.forEach(segment=>{
      const clip=segment.clip;
      const sourceKey=clip.sourceId||[clip.name,clip.in,clip.out].join("|");
      if(!groups.has(sourceKey)){
        groups.set(sourceKey,{
          id:groups.size+1,
          identityKey:portableFingerprint("src",sourceKey),
          nameKey:portableFingerprint("name",clip.name),
          edits:0,
          startFrame:segment.start,
          endFrame:segment.end,
          occurrences:[],
        });
      }
      const group=groups.get(sourceKey);
      const inFrame=clip.in+Math.max(0,segment.start-clip.start);
      group.edits+=1;
      group.startFrame=Math.min(group.startFrame,segment.start);
      group.endFrame=Math.max(group.endFrame,segment.end);
      group.occurrences.push({
        startFrame:segment.start,
        endFrame:segment.end,
        inFrame,
        outFrame:inFrame+(segment.end-segment.start),
      });
    });
    return {
      fps:parsed.fps,
      durationFrames:parsed.duration,
      name:parsed.name,
      edits:segments.length,
      shots:[...groups.values()],
    };
  }

  return {portableFingerprint,inspectTimeline};
});
