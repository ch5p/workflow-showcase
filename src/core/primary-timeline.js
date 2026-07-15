(function(root,factory){
  "use strict";
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.PortablePrimaryTimeline=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  function buildPrimarySegments(data){
    const duration=Number(data?.duration)||0;
    const clips=Array.isArray(data?.clips)?data.clips:[];
    const boundaries=[...new Set([0,duration,...clips.flatMap(clip=>[clip.start,clip.end])])]
      .filter(frame=>Number.isFinite(frame)&&frame>=0&&frame<=duration)
      .sort((left,right)=>left-right);
    const segments=[];
    for(let index=0;index<boundaries.length-1;index++){
      const start=boundaries[index];
      const end=boundaries[index+1];
      if(end<=start)continue;
      const primary=clips
        .filter(clip=>clip.enabled!==false&&clip.start<end&&clip.end>start)
        .sort((left,right)=>right.track-left.track)[0];
      if(!primary)continue;
      const previous=segments[segments.length-1];
      if(previous&&previous.clip===primary&&previous.end===start)previous.end=end;
      else segments.push({start,end,clip:primary});
    }
    return segments;
  }

  return {buildPrimarySegments,buildFocusSegments:buildPrimarySegments};
});
