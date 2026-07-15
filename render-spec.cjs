"use strict";

const CLASSIC_RENDER_SPEC=Object.freeze({
  layout:"classic",
  width:1280,
  height:1080,
  fps:60,
  bitrateMbps:12,
  inputPixelFormat:"bgra",
  outputPixelFormat:"yuv420p",
  colorSpace:"bt709",
  codec:"h264",
  container:"mp4",
});

function finitePositive(value,fallback){
  const number=Number(value);
  return Number.isFinite(number)&&number>0?number:fallback;
}

function resolveRenderSpec(output={}){
  const fps=Math.max(1,Math.round(finitePositive(output.fps,CLASSIC_RENDER_SPEC.fps)));
  const bitrateMbps=Math.max(1,finitePositive(output.bitrateMbps,CLASSIC_RENDER_SPEC.bitrateMbps));
  return Object.freeze({...CLASSIC_RENDER_SPEC,fps,bitrateMbps});
}

function publicRenderSpec(output={}){
  const spec=resolveRenderSpec(output);
  return {
    layout:spec.layout,
    width:spec.width,
    height:spec.height,
    fps:spec.fps,
    bitrateMbps:spec.bitrateMbps,
  };
}

module.exports={CLASSIC_RENDER_SPEC,resolveRenderSpec,publicRenderSpec};
