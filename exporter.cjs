"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const WIDTH = 1280;
const HEIGHT = 1080;

function sleep(milliseconds){
  return new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));
}

function timestampName(){
  const value = new Date();
  const pad = number => String(number).padStart(2, "0");
  return [value.getFullYear(), pad(value.getMonth() + 1), pad(value.getDate())].join("") + "_" +
    [pad(value.getHours()), pad(value.getMinutes()), pad(value.getSeconds())].join("");
}

function resolveFfmpeg(appRoot){
  const bundled = path.join(appRoot, "ffmpeg", "ffmpeg.exe");
  const candidates = fs.existsSync(bundled) ? [bundled, "ffmpeg"] : ["ffmpeg"];
  for(const candidate of candidates){
    const probe = spawnSync(candidate, ["-hide_banner", "-version"], { encoding: "utf8", windowsHide: true });
    if(probe.status === 0) return candidate;
  }
  throw new Error("FFmpeg를 찾을 수 없습니다. 앱의 ffmpeg 폴더 또는 PATH를 확인하세요.");
}

function canUseNvenc(ffmpegPath){
  const result = spawnSync(ffmpegPath, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:s=1280x1080:r=60:d=0.1",
    "-frames:v", "1", "-c:v", "h264_nvenc", "-preset", "p5", "-f", "null", "-",
  ], { encoding: "utf8", windowsHide: true });
  return result.status === 0;
}

function encoderArguments(encoder, bitrateMbps){
  const bitrate = Math.max(1, Number(bitrateMbps) || 12);
  const rate = bitrate + "M";
  const buffer = bitrate * 2 + "M";
  if(encoder === "h264_nvenc"){
    return [
      "-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq",
      "-profile:v", "high", "-rc", "cbr", "-b:v", rate,
      "-maxrate", rate, "-bufsize", buffer,
      "-spatial_aq", "1", "-temporal_aq", "1", "-bf", "3",
    ];
  }
  return [
    "-c:v", "libx264", "-preset", "fast", "-profile:v", "high",
    "-b:v", rate, "-maxrate", rate, "-bufsize", buffer, "-bf", "3",
  ];
}

function createExportController({ BrowserWindow, appRoot, jobRoot, outputRoot, logEvent }){
  let active = null;

  function emit(sender, payload){
    if(!sender?.isDestroyed()) sender.send("export:progress", payload);
  }

  function jobFile(relativePath){
    return path.join(jobRoot, relativePath || "");
  }

  function referenceState(job, parsed){
    return {
      references: (job.references || []).map(reference => ({
        id: reference.id,
        type: reference.type,
        src: pathToFileURL(jobFile(reference.relativePath)).href,
        label: reference.label,
      })),
      globalReferenceIds: job.globalReferenceIds || [],
      shotMappings: job.shotMappings || {},
      shots: parsed.shots.map(shot => ({
        id: String(shot.id),
        startFrame: shot.startFrame,
        endFrame: shot.endFrame,
      })),
    };
  }

  async function captureAttempt({ sender, job, ffmpegPath, encoder, temporaryPath }){
    const fps = Math.max(1, Number(job.output?.fps) || 60);
    const bitrateMbps = Math.max(1, Number(job.output?.bitrateMbps) || 12);
    const xmlPath = jobFile(job.xml.relativePath);
    const videoPath = jobFile(job.video.relativePath);
    const xmlText = fs.readFileSync(xmlPath, "utf8");
    const renderWindow = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      useContentSize: true,
      show: false,
      paintWhenInitiallyHidden: true,
      backgroundColor: "#ffffff",
      webPreferences: {
        offscreen: { useSharedTexture: false, deviceScaleFactor: 1 },
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    active.renderWindow = renderWindow;
    renderWindow.webContents.setAudioMuted(true);
    renderWindow.webContents.setFrameRate(fps);

    let latestFrame = null;
    let firstFrameResolve = null;
    const firstFrame = new Promise(resolve => { firstFrameResolve = resolve; });
    renderWindow.webContents.on("paint", (_event, _dirtyRect, image) => {
      const size = image.getSize();
      if(size.width !== WIDTH || size.height !== HEIGHT) return;
      const bitmap = image.toBitmap();
      if(bitmap.length !== WIDTH * HEIGHT * 4) return;
      latestFrame = bitmap;
      if(firstFrameResolve){
        firstFrameResolve();
        firstFrameResolve = null;
      }
    });

    let ffmpeg = null;
    let ffmpegError = "";
    try{
      await renderWindow.loadFile(path.join(appRoot, "src", "output-preview.html"), { query: { scale: "1" } });
      const videoUrl = pathToFileURL(videoPath).href;
      const parsed = await renderWindow.webContents.executeJavaScript(
        `window.portablePreview.loadXml(${JSON.stringify(xmlText)})`
      );
      await renderWindow.webContents.executeJavaScript(
        `window.portablePreview.setVideo(${JSON.stringify(videoUrl)}); window.portablePreview.waitForVideoReady()`
      );
      const references = referenceState(job, parsed);
      const projectTitle = job.projectTitle === undefined || job.projectTitle === null ? "SEEDANCE 2.0" : job.projectTitle;
      await renderWindow.webContents.executeJavaScript(
        `window.portablePreview.setProjectTitle(${JSON.stringify(projectTitle)}); window.portablePreview.setCalloutConfig(${JSON.stringify(job.callout || {})}); window.portablePreview.setReferences(${JSON.stringify(references)}); window.portablePreview.prepareRealtimeExport()`
      );
      renderWindow.webContents.invalidate();
      await Promise.race([
        firstFrame,
        sleep(5000).then(() => { throw new Error("offscreen 첫 프레임 시간 초과"); }),
      ]);

      const fullDurationSeconds = parsed.durationFrames / parsed.fps;
      const testSeconds = Number(process.env.PORTABLE_EXPORT_TEST_SECONDS);
      const durationSeconds = Number.isFinite(testSeconds)&&testSeconds>0
        ? Math.min(fullDurationSeconds,testSeconds)
        : fullDurationSeconds;
      const totalFrames = Math.ceil(durationSeconds * fps);
      const ffmpegArgs = [
        "-y", "-hide_banner", "-loglevel", "warning",
        "-f", "rawvideo", "-pixel_format", "bgra",
        "-video_size", WIDTH + "x" + HEIGHT, "-framerate", String(fps), "-i", "pipe:0",
        "-i", videoPath,
        "-map", "0:v:0", "-map", "1:a?", "-t", durationSeconds.toFixed(6),
        "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
        ...encoderArguments(encoder, bitrateMbps),
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        "-c:a", "copy", "-movflags", "+faststart", temporaryPath,
      ];
      ffmpeg = spawn(ffmpegPath, ffmpegArgs, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
      active.ffmpeg = ffmpeg;
      ffmpeg.stderr.on("data", chunk => {
        ffmpegError = (ffmpegError + chunk.toString()).slice(-24000);
      });
      ffmpeg.stdin.on("error", () => {});

      await renderWindow.webContents.executeJavaScript("window.portablePreview.startRealtimeExport()");
      const startedAt = performance.now();
      for(let frameIndex = 0; frameIndex < totalFrames; frameIndex++){
        if(active.cancelled) throw new Error("EXPORT_CANCELLED");
        const targetTime = startedAt + frameIndex / fps * 1000;
        await sleep(targetTime - performance.now());
        if(!latestFrame) throw new Error("offscreen 프레임이 비어 있습니다.");
        if(!ffmpeg.stdin.write(latestFrame)) await once(ffmpeg.stdin, "drain");
        if(frameIndex % Math.max(1, Math.round(fps / 5)) === 0 || frameIndex === totalFrames - 1){
          emit(sender, {
            state: "recording",
            progress: (frameIndex + 1) / totalFrames,
            frame: frameIndex + 1,
            totalFrames,
            encoder,
          });
        }
      }
      await renderWindow.webContents.executeJavaScript("window.portablePreview.stopRealtimeExport()");
      emit(sender, { state: "finalizing", progress: 1, encoder });
      ffmpeg.stdin.end();
      const [exitCode] = await once(ffmpeg, "close");
      active.ffmpeg = null;
      if(exitCode !== 0) throw new Error("FFmpeg 실패 (" + exitCode + ")\n" + ffmpegError);
      return { durationSeconds, totalFrames };
    }finally{
      if(ffmpeg && ffmpeg.exitCode == null && !ffmpeg.killed) ffmpeg.kill();
      if(!renderWindow.isDestroyed()) renderWindow.destroy();
      active.renderWindow = null;
      active.ffmpeg = null;
    }
  }

  async function start(sender, job){
    if(active) throw new Error("이미 익스포트가 진행 중입니다.");
    if(!job.xml?.relativePath || !fs.existsSync(jobFile(job.xml.relativePath))) throw new Error("XML이 없습니다.");
    if(!job.video?.relativePath || !fs.existsSync(jobFile(job.video.relativePath))) throw new Error("영상이 없습니다.");
    fs.mkdirSync(outputRoot, { recursive: true });
    const ffmpegPath = resolveFfmpeg(appRoot);
    const baseName = "character_workflow_export_" + timestampName();
    const outputPath = path.join(outputRoot, baseName + ".mp4");
    const temporaryPath = path.join(outputRoot, baseName + ".part.mp4");
    active = { cancelled: false, ffmpeg: null, renderWindow: null };
    const preferredEncoder = canUseNvenc(ffmpegPath) ? "h264_nvenc" : "libx264";
    emit(sender, { state: "preparing", progress: 0, encoder: preferredEncoder });
    logEvent("export_started", {
      encoder: preferredEncoder,
      fps: job.output?.fps || 60,
      bitrateMbps: job.output?.bitrateMbps || 12,
      output: path.basename(outputPath),
    });
    try{
      let encoder = preferredEncoder;
      let result;
      try{
        result = await captureAttempt({ sender, job, ffmpegPath, encoder, temporaryPath });
      }catch(error){
        if(active.cancelled || error.message === "EXPORT_CANCELLED") throw error;
        if(encoder !== "h264_nvenc") throw error;
        if(fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
        encoder = "libx264";
        emit(sender, { state: "fallback", progress: 0, encoder });
        logEvent("export_encoder_fallback", { message: error.message });
        result = await captureAttempt({ sender, job, ffmpegPath, encoder, temporaryPath });
      }
      fs.renameSync(temporaryPath, outputPath);
      emit(sender, { state: "complete", progress: 1, encoder, outputPath });
      logEvent("export_completed", {
        encoder,
        output: path.basename(outputPath),
        durationSeconds: result.durationSeconds,
        totalFrames: result.totalFrames,
      });
      return { ok: true, encoder, outputPath, ...result };
    }catch(error){
      if(fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
      if(active?.cancelled || error.message === "EXPORT_CANCELLED"){
        emit(sender, { state: "cancelled", progress: 0 });
        logEvent("export_cancelled");
        return { ok: false, cancelled: true };
      }
      emit(sender, { state: "error", progress: 0, message: error.message });
      logEvent("export_failed", { message: error.message });
      throw error;
    }finally{
      active = null;
    }
  }

  function cancel(){
    if(!active) return false;
    active.cancelled = true;
    if(active.ffmpeg && active.ffmpeg.exitCode == null) active.ffmpeg.kill();
    if(active.renderWindow && !active.renderWindow.isDestroyed()) active.renderWindow.destroy();
    return true;
  }

  return { start, cancel, isRunning: () => Boolean(active) };
}

module.exports = { createExportController };
