"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { fsyncExistingFile, replaceByRenameWithRetry } = require("./durable-file.cjs");
const { assertDirectoryNoLink, resolveOwnedRelativeFile } = require("./owned-path.cjs");
const { resolveRenderSpec } = require("./render-spec.cjs");
const { exporterText } = require("./strings.cjs");
const { assertExportSpace } = require("./storage-policy.cjs");
const { resolveTimelineInput } = require("./timeline-input.cjs");

// One export runs at a time (guarded by `active`), so a module-level language is safe.
let activeLanguage = "en";
const t = key => exporterText(activeLanguage, key);

function sleep(milliseconds){
  return new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));
}

function timestampName(){
  const value = new Date();
  const pad = number => String(number).padStart(2, "0");
  return [value.getFullYear(), pad(value.getMonth() + 1), pad(value.getDate())].join("") + "_" +
    [pad(value.getHours()), pad(value.getMinutes()), pad(value.getSeconds())].join("");
}

function availableExportPaths(outputRoot){
  const baseName = "workflow_showcase_export_" + timestampName();
  for(let index = 0; index < 1000; index += 1){
    const suffix = index ? "_" + String(index + 1).padStart(2, "0") : "";
    const outputPath = path.join(outputRoot, baseName + suffix + ".mp4");
    const temporaryPath = path.join(outputRoot, baseName + suffix + ".part.mp4");
    if(!fs.existsSync(outputPath) && !fs.existsSync(temporaryPath)){
      return { outputPath, temporaryPath };
    }
  }
  throw new Error(t("output_name_failed"));
}

function finalizeCompletedExport(temporaryPath, outputPath){
  fsyncExistingFile(temporaryPath);
  return replaceByRenameWithRetry(temporaryPath, outputPath, { label: "Completed Export" });
}

function resolveFfmpeg(appRoot){
  const bundled = path.join(appRoot, "ffmpeg", "ffmpeg.exe");
  const candidates = fs.existsSync(bundled) ? [bundled, "ffmpeg"] : ["ffmpeg"];
  for(const candidate of candidates){
    const probe = spawnSync(candidate, ["-hide_banner", "-version"], { encoding: "utf8", windowsHide: true });
    if(probe.status === 0) return candidate;
  }
  throw new Error(t("ffmpeg_missing"));
}

function canUseNvenc(ffmpegPath,spec=resolveRenderSpec()){
  const result = spawnSync(ffmpegPath, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:s="+spec.width+"x"+spec.height+":r="+spec.fps+":d=0.1",
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

function buildCompositeFilter(spec,durationSeconds){
  const videoHeight = 720;
  if(spec.width !== 1280 || spec.height !== 1080){
    throw new Error("Classic composite Export requires the 1280x1080 render surface.");
  }
  const duration = Math.max(0.001, Number(durationSeconds) || 0.001).toFixed(6);
  const background = "0x0d0e10";
  return [
    `[1:v]setpts=PTS-STARTPTS,scale=${spec.width}:${videoHeight}:force_original_aspect_ratio=decrease,pad=${spec.width}:${spec.height}:(ow-iw)/2:(${videoHeight}-ih)/2:color=${background},fps=${spec.fps},tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},setsar=1[base]`,
    `[0:v]format=${spec.inputPixelFormat}[ui]`,
    `[base][ui]overlay=0:0:shortest=1:format=auto:alpha=premultiplied,format=${spec.outputPixelFormat}[vout]`,
  ].join(";");
}

function createExportController({ BrowserWindow, appRoot, jobRoot, outputRoot, logEvent }){
  let active = null;
  const sourceRoot = path.join(jobRoot, "source");
  const referencesRoot = path.join(jobRoot, "references");

  function emit(sender, payload){
    if(!sender?.isDestroyed()) sender.send("export:progress", payload);
  }

  function sourceFile(relativePath, label, mustExist = true){
    return resolveOwnedRelativeFile({
      jobRoot,
      ownedRoot: sourceRoot,
      relativePath,
      label,
      mustExist,
    });
  }

  function referenceFile(relativePath){
    return resolveOwnedRelativeFile({
      jobRoot,
      ownedRoot: referencesRoot,
      relativePath,
      label: "Export reference",
      mustExist: true,
    });
  }

  function referenceState(job, parsed){
    return {
      references: (job.references || []).map(reference => ({
        id: reference.id,
        type: reference.type,
        src: pathToFileURL(referenceFile(reference.relativePath)).href,
        label: reference.label,
      })),
      globalReferenceIds: job.globalReferenceIds || [],
      shotMappings: job.shotMappings || {},
      referenceMotion: job.referenceMotion === "pop3d" ? "pop3d" : "classic",
      shots: parsed.shots.map(shot => ({
        id: String(shot.id),
        startFrame: shot.startFrame,
        endFrame: shot.endFrame,
      })),
    };
  }

  async function captureAttempt({ sender, job, ffmpegPath, encoder, temporaryPath, language }){
    const spec = resolveRenderSpec(job.output);
    const fps = spec.fps;
    const bitrateMbps = spec.bitrateMbps;
    const timelineInput=resolveTimelineInput(job);
    if(!timelineInput)throw new Error(t("timeline_missing"));
    const timelinePath=sourceFile(timelineInput.relativePath,"Export timeline");
    const videoPath = sourceFile(job.video.relativePath, "Export video");
    const timelineText=fs.readFileSync(timelinePath,"utf8");
    const renderWindow = new BrowserWindow({
      width: spec.width,
      height: spec.height,
      useContentSize: true,
      show: false,
      transparent: true,
      paintWhenInitiallyHidden: true,
      backgroundColor: "#00000000",
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
    let latestPaintVersion = 0;
    let firstFrameResolve = null;
    const firstFrame = new Promise(resolve => { firstFrameResolve = resolve; });
    renderWindow.webContents.on("paint", (_event, _dirtyRect, image) => {
      const size = image.getSize();
      if(size.width !== spec.width || size.height !== spec.height) return;
      const bitmap = image.toBitmap();
      if(bitmap.length !== spec.width * spec.height * 4) return;
      latestFrame = bitmap;
      latestPaintVersion += 1;
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
        `window.portablePreview.setLanguage(${JSON.stringify(language)}); window.portablePreview.setRenderSpec(${JSON.stringify(spec)}); window.portablePreview.loadTimeline(${JSON.stringify(timelineInput.format)},${JSON.stringify(timelineText)})`
      );
      await renderWindow.webContents.executeJavaScript(
        `window.portablePreview.setVideo(${JSON.stringify(videoUrl)}); window.portablePreview.waitForVideoReady()`
      );
      const references = referenceState(job, parsed);
      const projectTitle = job.projectTitle === undefined || job.projectTitle === null ? "UNTITLED PROJECT" : job.projectTitle;
      await renderWindow.webContents.executeJavaScript(
        `window.portablePreview.setProjectTitle(${JSON.stringify(projectTitle)}); window.portablePreview.setCalloutConfig(${JSON.stringify(job.callout || {})}); window.portablePreview.setEditDisplayConfig(${JSON.stringify({ numberTicker: Boolean(job.editNumberTicker) })}); window.portablePreview.setReferences(${JSON.stringify(references)}); window.portablePreview.prepareCompositeExport()`
      );
      renderWindow.webContents.invalidate();
      await Promise.race([
        firstFrame,
        sleep(5000).then(() => { throw new Error(t("first_frame_timeout")); }),
      ]);

      const fullDurationSeconds = parsed.durationFrames / parsed.fps;
      const testSeconds = Number(process.env.PORTABLE_EXPORT_TEST_SECONDS);
      const durationSeconds = Number.isFinite(testSeconds)&&testSeconds>0
        ? Math.min(fullDurationSeconds,testSeconds)
        : fullDurationSeconds;
      let space;
      try{
        space = assertExportSpace({
          destinationPath: outputRoot,
          durationSeconds,
          bitrateMbps,
        });
      }catch(error){
        if(error.code !== "INSUFFICIENT_DISK_SPACE") throw error;
        const failure = new Error(t("disk_space_insufficient"));
        failure.code = error.code;
        failure.requiredBytes = error.requiredBytes;
        failure.availableBytes = error.availableBytes;
        throw failure;
      }
      logEvent("export_space_checked", {
        estimatedBytes: space.estimatedBytes,
        reserveBytes: space.reserveBytes,
        availableBytes: space.availableBytes.toString(),
      });
      const totalFrames = Math.ceil(durationSeconds * fps);
      const compositeFilter = buildCompositeFilter(spec,durationSeconds);
      const ffmpegArgs = [
        "-y", "-hide_banner", "-loglevel", "warning",
        "-f", "rawvideo", "-pixel_format", spec.inputPixelFormat,
        "-video_size", spec.width + "x" + spec.height, "-framerate", String(fps), "-i", "pipe:0",
        "-i", videoPath,
        "-filter_complex", compositeFilter,
        "-map", "[vout]", "-map", "1:a?", "-t", durationSeconds.toFixed(6),
        ...encoderArguments(encoder, bitrateMbps),
        "-color_primaries", spec.colorSpace, "-color_trc", spec.colorSpace, "-colorspace", spec.colorSpace,
        "-c:a", "copy", "-movflags", "+faststart", temporaryPath,
      ];
      ffmpeg = spawn(ffmpegPath, ffmpegArgs, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
      active.ffmpeg = ffmpeg;
      ffmpeg.stderr.on("data", chunk => {
        ffmpegError = (ffmpegError + chunk.toString()).slice(-24000);
      });
      ffmpeg.stdin.on("error", () => {});

      await renderWindow.webContents.executeJavaScript("window.portablePreview.startCompositeExport()");
      const startedAt = performance.now();
      let lastWrittenPaintVersion = -1;
      let repeatedUiFrames = 0;
      for(let frameIndex = 0; frameIndex < totalFrames; frameIndex++){
        if(active.cancelled) throw new Error("EXPORT_CANCELLED");
        const targetTime = startedAt + frameIndex / fps * 1000;
        await sleep(targetTime - performance.now());
        if(!latestFrame) throw new Error(t("frame_empty"));
        if(latestPaintVersion === lastWrittenPaintVersion) repeatedUiFrames += 1;
        lastWrittenPaintVersion = latestPaintVersion;
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
      await renderWindow.webContents.executeJavaScript("window.portablePreview.stopCompositeExport()");
      emit(sender, { state: "finalizing", progress: 1, encoder });
      ffmpeg.stdin.end();
      const [exitCode] = await once(ffmpeg, "close");
      active.ffmpeg = null;
      if(exitCode !== 0) throw new Error(t("ffmpeg_failed") + " (" + exitCode + ")\n" + ffmpegError);
      return { durationSeconds, totalFrames, repeatedUiFrames, observedPaintFrames: latestPaintVersion };
    }finally{
      if(ffmpeg && ffmpeg.exitCode == null && !ffmpeg.killed) ffmpeg.kill();
      if(!renderWindow.isDestroyed()) renderWindow.destroy();
      active.renderWindow = null;
      active.ffmpeg = null;
    }
  }

  async function start(sender, job, language){
    const requestedLanguage = language === "ko" ? "ko" : "en";
    if(active) throw new Error(exporterText(requestedLanguage, "already_running"));
    activeLanguage = requestedLanguage;
    const timelineInput=resolveTimelineInput(job);
    if(!timelineInput?.relativePath)throw new Error(t("timeline_missing"));
    if(!job.video?.relativePath) throw new Error(t("video_missing"));
    sourceFile(timelineInput.relativePath,"Export timeline");
    sourceFile(job.video.relativePath, "Export video");
    assertDirectoryNoLink(outputRoot, "Export output");
    const ffmpegPath = resolveFfmpeg(appRoot);
    const { outputPath, temporaryPath } = availableExportPaths(outputRoot);
    active = { cancelled: false, ffmpeg: null, renderWindow: null };
    const spec = resolveRenderSpec(job.output);
    const preferredEncoder = canUseNvenc(ffmpegPath,spec) ? "h264_nvenc" : "libx264";
    emit(sender, { state: "preparing", progress: 0, encoder: preferredEncoder });
    logEvent("export_started", {
      encoder: preferredEncoder,
      width: spec.width,
      height: spec.height,
      fps: spec.fps,
      bitrateMbps: spec.bitrateMbps,
      composition: "ffmpeg_source_plus_ui",
      output: path.basename(outputPath),
    });
    let encodingCompleted = false;
    try{
      let encoder = preferredEncoder;
      let result;
      try{
        result = await captureAttempt({ sender, job, ffmpegPath, encoder, temporaryPath, language: requestedLanguage });
      }catch(error){
        if(active.cancelled || error.message === "EXPORT_CANCELLED") throw error;
        if(encoder !== "h264_nvenc") throw error;
        if(fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
        encoder = "libx264";
        emit(sender, { state: "fallback", progress: 0, encoder });
        logEvent("export_encoder_fallback", { message: error.message });
        result = await captureAttempt({ sender, job, ffmpegPath, encoder, temporaryPath, language: requestedLanguage });
      }
      encodingCompleted = true;
      try{
        finalizeCompletedExport(temporaryPath, outputPath);
      }catch(error){
        const partPreserved = fs.existsSync(temporaryPath);
        logEvent("export_finalize_failed", {
          code: error.code || "FINALIZE_FAILED",
          part: partPreserved ? path.basename(temporaryPath) : null,
        });
        const failure = new Error(partPreserved
          ? t("finalize_rename")
          : t("finalize_verify"));
        failure.code = "EXPORT_FINALIZE_DEFERRED";
        failure.cause = error;
        if(partPreserved) failure.partPath = temporaryPath;
        throw failure;
      }
      emit(sender, { state: "complete", progress: 1, encoder, outputPath });
      logEvent("export_completed", {
        encoder,
        output: path.basename(outputPath),
        durationSeconds: result.durationSeconds,
        totalFrames: result.totalFrames,
        composition: "ffmpeg_source_plus_ui",
        repeatedUiFrames: result.repeatedUiFrames,
        observedPaintFrames: result.observedPaintFrames,
      });
      return { ok: true, encoder, outputPath, ...result };
    }catch(error){
      if(!encodingCompleted && fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
      if(active?.cancelled || error.message === "EXPORT_CANCELLED"){
        emit(sender, { state: "cancelled", progress: 0 });
        logEvent("export_cancelled");
        return { ok: false, cancelled: true };
      }
      emit(sender, { state: "error", progress: 0, message: error.message });
      logEvent("export_failed", {
        code: error.code || "EXPORT_FAILED",
        message: error.message,
        requiredBytes: error.requiredBytes || null,
        availableBytes: error.availableBytes || null,
        partPreserved: encodingCompleted && fs.existsSync(temporaryPath) ? path.basename(temporaryPath) : null,
      });
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

module.exports = { availableExportPaths, buildCompositeFilter, createExportController, finalizeCompletedExport };
