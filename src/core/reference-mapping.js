(function(root,factory){
  "use strict";
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.PortableReferenceMapping=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const MODES=new Set(["INHERIT","ADD","REPLACE","HIDE"]);

  function normalizeMode(value){
    const mode=String(value||"INHERIT").toUpperCase();
    return MODES.has(mode)?mode:"INHERIT";
  }

  function mappingForShot(mappings,shotId){
    const raw=mappings?.[String(shotId)]||{};
    return {
      mode:normalizeMode(raw.mode),
      refs:Array.isArray(raw.refs)?[...raw.refs]:[],
      leadInSeconds:Number(raw.leadInSeconds)===1?1:0,
    };
  }

  function resolveVisibleReferenceIds(globalReferenceIds,mapping){
    const globals=Array.isArray(globalReferenceIds)?globalReferenceIds:[];
    const normalized=mappingForShot({shot:mapping},"shot");
    if(normalized.mode==="HIDE")return [];
    if(normalized.mode==="REPLACE")return normalized.refs;
    if(normalized.mode==="ADD")return [...new Set([...globals,...normalized.refs])];
    return [...globals];
  }

  function hydrateShots(nextShots,mappings={}){
    return (Array.isArray(nextShots)?nextShots:[]).map(shot=>({
      ...shot,
      ...mappingForShot(mappings,shot.id),
    }));
  }

  function snapshotMappings(shots,globalReferenceIds=[]){
    const shotMappings={};
    (Array.isArray(shots)?shots:[]).forEach(shot=>{
      const mode=normalizeMode(shot.mode);
      const refs=Array.isArray(shot.refs)?[...shot.refs]:[];
      const hasLeadIn=Number(shot.leadInSeconds)===1;
      if(mode!=="INHERIT"||refs.length||hasLeadIn){
        const mapping={mode,refs};
        if(hasLeadIn)mapping.leadInSeconds=1;
        shotMappings[String(shot.id)]=mapping;
      }
    });
    return {
      globalReferenceIds:Array.isArray(globalReferenceIds)?[...globalReferenceIds]:[],
      shotMappings,
    };
  }

  return {MODES,normalizeMode,mappingForShot,resolveVisibleReferenceIds,hydrateShots,snapshotMappings};
});
