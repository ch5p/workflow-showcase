(function(root,factory){
  "use strict";
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.PortableDurationMath=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const EPSILON_SECONDS=1e-6;

  function resolveDurationDelta({videoSeconds,durationFrames,fps}={}){
    const video=Number(videoSeconds);
    const frames=Number(durationFrames);
    const frameRate=Number(fps);
    if(!Number.isFinite(video)||video<=0||!Number.isFinite(frames)||frames<0||
        !Number.isFinite(frameRate)||frameRate<=0){
      return null;
    }
    const xmlSeconds=frames/frameRate;
    const deltaSeconds=video-xmlSeconds;
    const frameSeconds=1/frameRate;
    return {
      xmlSeconds,
      deltaSeconds,
      frameSeconds,
      visible: Math.abs(deltaSeconds)>=frameSeconds-EPSILON_SECONDS,
    };
  }

  return { resolveDurationDelta };
});
