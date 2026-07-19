"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { fsyncExistingFile, replaceByRenameWithRetry, writeTextAtomically } = require("./durable-file.cjs");
const { assertDirectoryNoLink, ensureDirectoryNoLink } = require("./owned-path.cjs");
const { assertExportSpace } = require("./storage-policy.cjs");

const INTRO_WIDTH = 1280;
const INTRO_HEIGHT = 1080;
const DEFAULT_BITRATE_MBPS = 12;
const TEMP_PREFIX = "workflow-showcase-intro-";
const DEFAULT_SETTINGS = Object.freeze({
  prompt: "Three rescuers, one moment. Firefighter, swiftwater, paramedic — intercut at their limits. 15s, 24fps.",
  reply: "Understood. Rise from boots to eyes, fragment burst, then the reverse descent to gripping hands. Rolling now.",
  typingSeconds: 1,
  soundEnabled: true,
});

function introError(message, code = "INTRO_DEMO_FAILED", detail = {}){
  const error = new Error(message);
  error.code = code;
  Object.assign(error, detail);
  return error;
}

function escapeRegExp(value){
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function selectedPathIdentity(sourcePath){
  if(typeof sourcePath !== "string" || !sourcePath) return { basename: "selected-export.mp4", variants: [] };
  const windowsPath = /^[a-z]:[\\/]/i.test(sourcePath) || /^\\\\/.test(sourcePath);
  const normalized = windowsPath ? path.win32.normalize(sourcePath) : path.resolve(sourcePath);
  const basename = (windowsPath ? path.win32.basename(normalized) : path.basename(normalized)) || "selected-export.mp4";
  const variants = new Set([sourcePath, normalized]);
  const addSeparatorVariants = value => {
    if(!value) return;
    variants.add(value);
    variants.add(value.replace(/\\/g, "/"));
    variants.add(value.replace(/\//g, "\\"));
  };
  for(const value of [...variants]) addSeparatorVariants(value);
  if(normalized.startsWith("\\\\?\\")) addSeparatorVariants(normalized.slice(4));
  else if(/^[a-z]:\\/i.test(normalized)) addSeparatorVariants("\\\\?\\" + normalized);
  try{
    const fileUrl = pathToFileURL(normalized).href;
    variants.add(fileUrl);
    try{ variants.add(decodeURIComponent(fileUrl)); }catch{}
  }catch{}
  const forward = normalized.replace(/\\/g, "/");
  if(/^[a-z]:\//i.test(forward)){
    variants.add("file:///" + forward);
    variants.add("file:///" + forward.split("/").map(segment => encodeURIComponent(segment)).join("/").replace(/^([a-z])%3A/i, "$1:"));
  }
  return {
    basename,
    variants: [...variants]
      .filter(value => typeof value === "string" && value.length > basename.length)
      .sort((left, right) => right.length - left.length),
  };
}

function redactSelectedSourcePath(value, sourcePath){
  let text = String(value ?? "");
  const identity = selectedPathIdentity(sourcePath);
  for(const candidate of identity.variants){
    text = text.replace(new RegExp(escapeRegExp(candidate), "gi"), identity.basename);
  }
  return text;
}

function redactSelectedSourceError(error, sourcePath, fallbackCode = "INTRO_DEMO_FAILED"){
  const message = redactSelectedSourcePath(error?.message || String(error), sourcePath);
  const safe = introError(message, error?.code || fallbackCode);
  for(const key of ["requiredBytes", "availableBytes", "partPath", "outputFps", "sourceFps"]){
    if(error?.[key] !== undefined){
      safe[key] = typeof error[key] === "string"
        ? redactSelectedSourcePath(error[key], sourcePath)
        : error[key];
    }
  }
  return safe;
}

function redactSelectedSourceDetail(detail, sourcePath){
  if(typeof detail === "string") return redactSelectedSourcePath(detail, sourcePath);
  if(Array.isArray(detail)) return detail.map(value => redactSelectedSourceDetail(value, sourcePath));
  if(!detail || typeof detail !== "object") return detail;
  return Object.fromEntries(Object.entries(detail).map(([key, value]) => [
    key,
    redactSelectedSourceDetail(value, sourcePath),
  ]));
}

function cancelledError(){
  return introError("INTRO build was cancelled", "INTRO_CANCELLED");
}

function rationalNumber(value){
  const [left, right] = String(value || "0/1").split("/").map(Number);
  return Number.isFinite(left) && Number.isFinite(right) && right ? left / right : 0;
}

function inspectMainMetadata(metadata){
  const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
  const video = streams.find(stream => stream?.codec_type === "video");
  const audio = streams.find(stream => stream?.codec_type === "audio") || null;
  if(!video || String(video.codec_name).toLowerCase() !== "h264"){
    throw introError("Selected Export must contain H.264 video", "INTRO_MAIN_INCOMPATIBLE");
  }
  if(Number(video.width) !== INTRO_WIDTH || Number(video.height) !== INTRO_HEIGHT){
    throw introError("Selected Export must be 1280x1080", "INTRO_MAIN_INCOMPATIBLE");
  }
  if(String(video.pix_fmt).toLowerCase() !== "yuv420p"){
    throw introError("Selected Export must use yuv420p", "INTRO_MAIN_INCOMPATIBLE");
  }
  const fps = rationalNumber(video.avg_frame_rate) || rationalNumber(video.r_frame_rate);
  if(!Number.isFinite(fps) || fps < 1 || fps > 120 || Math.abs(fps - Math.round(fps)) > 0.001){
    throw introError("Selected Export must use an integer frame rate between 1 and 120", "INTRO_MAIN_INCOMPATIBLE");
  }
  const duration = Number(metadata?.format?.duration ?? video.duration);
  if(!Number.isFinite(duration) || duration <= 0){
    throw introError("Selected Export duration is invalid", "INTRO_MAIN_INCOMPATIBLE");
  }
  return {
    durationSeconds: duration,
    fps: Math.round(fps),
    width: INTRO_WIDTH,
    height: INTRO_HEIGHT,
    videoCodec: "h264",
    pixelFormat: "yuv420p",
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name ? String(audio.codec_name) : null,
  };
}

function normalizeText(value, fallback, label){
  if(value === undefined) return fallback;
  if(typeof value !== "string") throw introError(label + " must be text", "INTRO_ARGUMENT_INVALID");
  const normalized = value.replace(/\s+/g, " ").trim();
  if(normalized.length > 500) throw introError(label + " is too long", "INTRO_ARGUMENT_INVALID");
  return normalized;
}

function normalizeIntroSettings(settings = {}){
  const source = settings && typeof settings === "object" ? settings : {};
  const typingSeconds = Number(source.typingSeconds ?? DEFAULT_SETTINGS.typingSeconds);
  if(typingSeconds !== 1 && typingSeconds !== 2){
    throw introError("typingSeconds must be 1 or 2", "INTRO_ARGUMENT_INVALID");
  }
  if(source.soundEnabled !== undefined && typeof source.soundEnabled !== "boolean"){
    throw introError("soundEnabled must be a boolean", "INTRO_ARGUMENT_INVALID");
  }
  return {
    prompt: normalizeText(source.prompt, DEFAULT_SETTINGS.prompt, "prompt"),
    reply: normalizeText(source.reply, DEFAULT_SETTINGS.reply, "reply"),
    typingSeconds,
    soundEnabled: source.soundEnabled !== false,
  };
}

function buildIntroAudioFilter(timeline, duration, soundEnabled = true){
  const totalDuration = Number(duration);
  if(!Number.isFinite(totalDuration) || totalDuration <= 0){
    throw introError("INTRO audio duration is invalid", "INTRO_TIMELINE_INVALID");
  }
  const bed = `anullsrc=r=48000:cl=stereo:d=${totalDuration.toFixed(6)}[bed]`;
  if(soundEnabled === false) return `${bed};[bed]anull[aout]`;
  const focus = Number(timeline?.focus);
  const sendPress = Number(timeline?.send) - 0.1;
  if(!Number.isFinite(focus) || focus < 0 || !Number.isFinite(sendPress) || sendPress < 0){
    throw introError("INTRO audio timing is invalid", "INTRO_TIMELINE_INVALID");
  }
  const parts = [
    `[1:a]atrim=start=0.075,asetpts=PTS-STARTPTS,asplit=2[focus0][send0]`,
    `[focus0]adelay=${Math.round(focus * 1000)}|${Math.round(focus * 1000)}[focus]`,
    `[send0]adelay=${Math.round(sendPress * 1000)}|${Math.round(sendPress * 1000)}[send]`,
  ];
  const keyEvents = Array.isArray(timeline?.keyEvents) ? timeline.keyEvents.map((event, index) => {
    const time = Number(event?.time);
    const sampleOffset = Number(event?.sampleOffset);
    const sampleDuration = Number(event?.sampleDuration);
    if(!Number.isFinite(time) || time < 0 || time > totalDuration ||
       !Number.isFinite(sampleOffset) || sampleOffset < 0 ||
       !Number.isFinite(sampleDuration) || sampleDuration <= 0 || sampleDuration > 0.2){
      throw introError(`INTRO key event ${index} is invalid`, "INTRO_TIMELINE_INVALID");
    }
    return { time, sampleOffset, sampleDuration };
  }) : [];
  const mixLabels = ["[bed]", "[focus]", "[send]"];
  if(keyEvents.length){
    const splitLabels = keyEvents.map((_, index) => `[keysrc${index}]`).join("");
    parts.push(keyEvents.length === 1 ? `[2:a]anull[keysrc0]` : `[2:a]asplit=${keyEvents.length}${splitLabels}`);
    keyEvents.forEach((event, index) => {
      const label = `[key${index}]`;
      parts.push(
        `[keysrc${index}]atrim=start=${event.sampleOffset.toFixed(6)}:duration=${event.sampleDuration.toFixed(6)},` +
        `asetpts=PTS-STARTPTS,adelay=${Math.round(event.time * 1000)}|${Math.round(event.time * 1000)}${label}`
      );
      mixLabels.push(label);
    });
  }
  parts.push(bed);
  parts.push(`${mixLabels.join("")}amix=inputs=${mixLabels.length}:normalize=0:duration=first,alimiter=limit=.95[aout]`);
  return parts.join(";");
}

function normalizeOutputSpec(outputSpec = {}, mainMeta = null, { requireFpsMatch = true } = {}){
  const source = outputSpec && typeof outputSpec === "object" ? outputSpec : {};
  const width = Number(source.width ?? INTRO_WIDTH);
  const height = Number(source.height ?? INTRO_HEIGHT);
  const fps = Number(source.fps ?? mainMeta?.fps ?? 60);
  const bitrateMbps = Number(source.bitrateMbps ?? DEFAULT_BITRATE_MBPS);
  if(width !== INTRO_WIDTH || height !== INTRO_HEIGHT){
    throw introError("INTRO outputSpec must be 1280x1080", "INTRO_OUTPUT_SPEC_INVALID");
  }
  if(!Number.isInteger(fps) || fps < 1 || fps > 120){
    throw introError("INTRO outputSpec fps must be an integer between 1 and 120", "INTRO_OUTPUT_SPEC_INVALID");
  }
  if(!Number.isFinite(bitrateMbps) || bitrateMbps <= 0){
    throw introError("INTRO outputSpec bitrateMbps must be positive", "INTRO_OUTPUT_SPEC_INVALID");
  }
  if(source.codec && String(source.codec).toLowerCase() !== "h264"){
    throw introError("INTRO outputSpec codec must be h264", "INTRO_OUTPUT_SPEC_INVALID");
  }
  if(source.outputPixelFormat && String(source.outputPixelFormat).toLowerCase() !== "yuv420p"){
    throw introError("INTRO outputSpec outputPixelFormat must be yuv420p", "INTRO_OUTPUT_SPEC_INVALID");
  }
  if(requireFpsMatch && mainMeta && fps !== mainMeta.fps){
    throw introError(
      "INTRO outputSpec fps (" + fps + ") does not match the selected Export (" + mainMeta.fps + ")",
      "INTRO_MAIN_INCOMPATIBLE",
      { outputFps: fps, sourceFps: mainMeta.fps }
    );
  }
  return {
    width: INTRO_WIDTH,
    height: INTRO_HEIGHT,
    fps,
    bitrateMbps,
    inputPixelFormat: "bgra",
    outputPixelFormat: "yuv420p",
    colorSpace: "bt709",
    codec: "h264",
    container: "mp4",
  };
}

function timestampName(date = new Date()){
  const pad = value => String(value).padStart(2, "0");
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("") + "_" +
    [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("");
}

function availableDemoPaths(outputRoot, { date = new Date(), existsSync = fs.existsSync } = {}){
  const baseName = "workflow_showcase_demo_" + timestampName(date);
  for(let index = 0; index < 1000; index += 1){
    const suffix = index ? "_" + String(index + 1).padStart(2, "0") : "";
    const outputName = baseName + suffix + ".mp4";
    const outputPath = path.join(outputRoot, outputName);
    const temporaryPath = path.join(outputRoot, baseName + suffix + ".part.mp4");
    if(!existsSync(outputPath) && !existsSync(temporaryPath)){
      return { outputName, outputPath, temporaryPath };
    }
  }
  throw introError("Unable to reserve a unique INTRO output name", "INTRO_OUTPUT_NAME_FAILED");
}

function questionToneFromLuma(value){
  const luma = value === null || value === undefined || value === ""
    ? null
    : (Number.isFinite(Number(value)) ? Number(value) : null);
  if(luma !== null && luma < 138){
    return { questionColor: "#ffffff", questionShadow: "0 2px 5px rgba(0,0,0,.55)", luma };
  }
  return { questionColor: "#151a18", questionShadow: "0 1px 3px rgba(255,255,255,.42)", luma };
}

function validateFinalMetadata(metadata, { expectedDuration, fps }){
  const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
  const video = streams.find(stream => stream?.codec_type === "video");
  const audio = streams.find(stream => stream?.codec_type === "audio");
  const durationSeconds = Number(metadata?.format?.duration);
  const expectedDurationSeconds = Number(expectedDuration);
  const expectedFps = Number(fps);
  if(!video || String(video.codec_name).toLowerCase() !== "h264" ||
    Number(video.width) !== INTRO_WIDTH || Number(video.height) !== INTRO_HEIGHT ||
    String(video.pix_fmt).toLowerCase() !== "yuv420p"){
    throw introError("Final INTRO demo video metadata is invalid", "INTRO_VERIFY_FAILED");
  }
  if(!audio || String(audio.codec_name).toLowerCase() !== "aac" ||
    Number(audio.sample_rate) !== 48000 || Number(audio.channels) !== 2){
    throw introError("Final INTRO demo audio metadata is invalid", "INTRO_VERIFY_FAILED");
  }
  if(!Number.isFinite(expectedFps) || expectedFps <= 0 ||
    !Number.isFinite(expectedDurationSeconds) || expectedDurationSeconds <= 0 ||
    !Number.isFinite(durationSeconds) ||
    Math.abs(durationSeconds - expectedDurationSeconds) > Math.max(0.2, 2 / expectedFps)){
    throw introError("Final INTRO demo duration is outside tolerance", "INTRO_VERIFY_FAILED");
  }
  // TS stream-copy preserves encoded frames, but concat timestamps make ffprobe's avg/r FPS unreliable.
  return { durationSeconds, videoCodec: "h264", audioCodec: "aac" };
}

function encoderArguments(bitrateMbps){
  const bitrate = Math.max(1, Number(bitrateMbps) || DEFAULT_BITRATE_MBPS);
  return [
    "-c:v", "libx264", "-preset", "medium", "-profile:v", "high",
    "-b:v", bitrate + "M", "-maxrate", bitrate + "M", "-bufsize", bitrate * 2 + "M",
  ];
}

function escapeConcatPath(value){
  return String(value).replace(/\\/g, "/").replace(/'/g, "'\\''");
}

function inspectRegularMp4(filePath, { fileSystem = fs } = {}){
  if(typeof filePath !== "string" || !filePath){
    throw introError("Selected Export path is invalid", "INTRO_ARGUMENT_INVALID");
  }
  const resolved = path.resolve(filePath);
  let stat;
  try{ stat = fileSystem.lstatSync(resolved); }
  catch(error){
    if(error?.code === "ENOENT") throw introError("Selected Export does not exist", "INTRO_MAIN_MISSING");
    const message = error?.message
      ? redactSelectedSourcePath(error.message, resolved)
      : "Unable to inspect " + path.basename(resolved);
    throw introError(message, error?.code || "INTRO_FILE_INSPECTION_FAILED");
  }
  if(stat.isSymbolicLink() || !stat.isFile()){
    throw introError("Selected Export must be a regular non-symlink file", "INTRO_FILE_UNSAFE");
  }
  if(path.extname(resolved).toLowerCase() !== ".mp4"){
    throw introError("Selected Export must be an MP4 file", "INTRO_MAIN_INCOMPATIBLE");
  }
  return { path: resolved, stat };
}

function mainAudioArguments(mainPath, normalizedPath, mainMeta){
  const duration = Number(mainMeta?.durationSeconds);
  if(!Number.isFinite(duration) || duration <= 0){
    throw introError("Selected Export duration is invalid", "INTRO_MAIN_INCOMPATIBLE");
  }
  const args = ["-y", "-hide_banner", "-loglevel", "warning", "-i", mainPath];
  if(mainMeta.hasAudio){
    args.push("-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
  }else{
    args.push(
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"
    );
  }
  args.push("-t", duration.toFixed(6), "-movflags", "+faststart", normalizedPath);
  return args;
}

function transportStreamArguments(inputPath, outputPath){
  return [
    "-y", "-hide_banner", "-loglevel", "warning", "-i", inputPath,
    "-map", "0:v:0", "-map", "0:a:0", "-c", "copy",
    "-bsf:v", "h264_mp4toannexb", "-f", "mpegts", outputPath,
  ];
}

function concatPlan(introTs, mainTs, temporaryPath, tempRoot){
  const listPath = path.join(tempRoot, "concat.txt");
  return {
    listPath,
    listText: "file '" + escapeConcatPath(introTs) + "'\nfile '" + escapeConcatPath(mainTs) + "'\n",
    args: [
      "-n", "-hide_banner", "-loglevel", "warning", "-f", "concat", "-safe", "0", "-i", listPath,
      "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-bsf:a", "aac_adtstoasc",
      "-movflags", "+faststart", temporaryPath,
    ],
  };
}

function cancelTrackedOperation(operation){
  if(!operation) return false;
  operation.cancelled = true;
  for(const child of operation.children || []){
    try{ if(child.exitCode === null && !child.killed) child.kill("SIGKILL"); }catch{}
  }
  const renderWindow = operation.renderWindow;
  if(renderWindow && typeof renderWindow.isDestroyed === "function" && !renderWindow.isDestroyed()){
    try{ renderWindow.destroy(); }catch{}
  }
  return true;
}

function removeIncompletePart(temporaryPath, { fileSystem = fs } = {}){
  if(!temporaryPath || !fileSystem.existsSync(temporaryPath)) return false;
  const stat = fileSystem.lstatSync(temporaryPath);
  if(stat.isSymbolicLink() || !stat.isFile()) return false;
  fileSystem.unlinkSync(temporaryPath);
  return true;
}

function finalizeVerifiedPart(temporaryPath, outputPath, {
  fileSystem = fs,
  fsyncFile = (filePath, selectedFileSystem) => fsyncExistingFile(filePath, selectedFileSystem),
  replaceFile = (stagedPath, targetPath, options) => replaceByRenameWithRetry(stagedPath, targetPath, options),
} = {}){
  try{
    fsyncFile(temporaryPath, fileSystem);
    return replaceFile(temporaryPath, outputPath, { label: "Completed INTRO demo", fileSystem });
  }catch(error){
    const partPreserved = fileSystem.existsSync(temporaryPath);
    throw introError(
      partPreserved
        ? "The verified INTRO demo part was preserved because the final rename failed"
        : "The INTRO demo could not be finalized",
      partPreserved ? "INTRO_FINALIZE_DEFERRED" : "INTRO_FINALIZE_FAILED",
      { cause: error, ...(partPreserved ? { partPath: temporaryPath } : {}) }
    );
  }
}

function createIntroDemoController({ BrowserWindow, dialog, appRoot, outputRoot, sourceRecordPath = null, logEvent = () => {} } = {}){
  if(typeof BrowserWindow !== "function") throw new TypeError("BrowserWindow is required");
  if(!dialog || typeof dialog.showOpenDialog !== "function") throw new TypeError("dialog is required");
  if(typeof appRoot !== "string" || !appRoot) throw new TypeError("appRoot is required");
  if(typeof outputRoot !== "string" || !outputRoot) throw new TypeError("outputRoot is required");
  const resolvedAppRoot = path.resolve(appRoot);
  const resolvedOutputRoot = path.resolve(outputRoot);
  const introHtml = path.join(resolvedAppRoot, "src", "intro-preroll.html");
  const clickWav = path.join(resolvedAppRoot, "src", "assets", "intro-click.wav");
  const keyboardWav = path.join(resolvedAppRoot, "src", "assets", "intro-keyboard.wav");
  const resolvedSourceRecordPath = typeof sourceRecordPath === "string" && sourceRecordPath
    ? path.resolve(sourceRecordPath)
    : null;
  let sessionExport = null;
  let sessionExportJobId = null;
  let sourceRecordRestoreAttempt = null;
  let previewEntry = null;
  let active = null;
  let disposed = false;
  let tools = null;

  function safeLog(event, detail = {}){
    const sourcePath = active?.sourcePath || sessionExport?.path || "";
    try{ logEvent(event, redactSelectedSourceDetail(detail, sourcePath)); }catch{}
  }

  function assertUsable(){
    if(disposed) throw introError("INTRO controller has been disposed", "INTRO_DISPOSED");
  }

  function regularFile(filePath, label, missingCode = "INTRO_FILE_MISSING"){
    const resolved = path.resolve(String(filePath || ""));
    let stat;
    try{ stat = fs.lstatSync(resolved); }
    catch(error){
      if(error?.code === "ENOENT") throw introError(label + " does not exist", missingCode);
      throw error;
    }
    if(stat.isSymbolicLink() || !stat.isFile()){
      throw introError(label + " must be a regular non-symlink file", "INTRO_FILE_UNSAFE");
    }
    return { path: resolved, stat };
  }

  function directOutputExport(filePath){
    const outputDirectory = assertDirectoryNoLink(resolvedOutputRoot, "INTRO output");
    const resolved = path.resolve(String(filePath || ""));
    const outputName = path.basename(resolved);
    if(path.dirname(resolved) !== outputDirectory ||
       !/^workflow_showcase_export_\d{8}_\d{6}(?:_\d{2})?\.mp4$/i.test(outputName)){
      throw introError("Recorded INTRO source must be an app-created Showcase Export", "INTRO_RECORDED_SOURCE_INVALID");
    }
    return { resolved, outputName };
  }

  function writeSourceRecord(selected, jobId){
    if(!resolvedSourceRecordPath || typeof jobId !== "string" || !jobId) return false;
    const direct = directOutputExport(selected.path);
    assertDirectoryNoLink(path.dirname(resolvedSourceRecordPath), "INTRO source record folder");
    const record = {
      version: 1,
      jobId,
      outputName: direct.outputName,
      sizeBytes: selected.size,
      modifiedMs: selected.modifiedMs,
    };
    writeTextAtomically(
      resolvedSourceRecordPath,
      JSON.stringify(record, null, 2) + "\n",
      { label: "INTRO source record" }
    );
    safeLog("intro_source_recorded", { output: direct.outputName, jobId });
    return true;
  }

  function restoreSourceRecord(jobId){
    if(!resolvedSourceRecordPath || typeof jobId !== "string" || !jobId || !fs.existsSync(resolvedSourceRecordPath)) return null;
    sourceRecordRestoreAttempt = jobId;
    try{
      assertDirectoryNoLink(path.dirname(resolvedSourceRecordPath), "INTRO source record folder");
      regularFile(resolvedSourceRecordPath, "INTRO source record", "INTRO_RECORDED_SOURCE_MISSING");
      const record = JSON.parse(fs.readFileSync(resolvedSourceRecordPath, "utf8"));
      if(record?.version !== 1 || typeof record.jobId !== "string" || typeof record.outputName !== "string" ||
         !Number.isSafeInteger(record.sizeBytes) || !Number.isFinite(record.modifiedMs)){
        throw introError("Recorded INTRO source metadata is invalid", "INTRO_RECORDED_SOURCE_INVALID");
      }
      if(record.jobId !== jobId) return null;
      const direct = directOutputExport(path.join(resolvedOutputRoot, record.outputName));
      if(direct.outputName !== record.outputName){
        throw introError("Recorded INTRO source name is invalid", "INTRO_RECORDED_SOURCE_INVALID");
      }
      const selected = inspectSelected(direct.resolved);
      if(selected.size !== record.sizeBytes || Math.abs(selected.modifiedMs - record.modifiedMs) > 1){
        throw introError("Recorded INTRO source changed after Export", "INTRO_RECORDED_SOURCE_CHANGED");
      }
      sessionExport = selected;
      sessionExportJobId = jobId;
      safeLog("intro_source_restored", { output: record.outputName, jobId });
      return selected;
    }catch(error){
      safeLog("intro_recorded_source_rejected", {
        code: error.code || "INTRO_RECORDED_SOURCE_INVALID",
        message: error.message,
      });
      return null;
    }
  }

  function resolveTool(name){
    const bundled = path.join(resolvedAppRoot, "ffmpeg", name + ".exe");
    const candidates = fs.existsSync(bundled) ? [bundled, name] : [name];
    for(const candidate of candidates){
      if(path.isAbsolute(candidate)){
        try{ regularFile(candidate, name, "INTRO_TOOL_MISSING"); }
        catch{ continue; }
      }
      const probe = spawnSync(candidate, ["-hide_banner", "-version"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
      });
      if(probe.status === 0) return candidate;
    }
    throw introError(name + " is not available", "INTRO_TOOL_MISSING");
  }

  function getTools(){
    if(!tools) tools = { ffmpegPath: resolveTool("ffmpeg"), ffprobePath: resolveTool("ffprobe") };
    return tools;
  }

  function ffprobeJson(ffprobePath, filePath, { selectedSourcePath = "" } = {}){
    const result = spawnSync(ffprobePath, [
      "-v", "error", "-show_streams", "-show_format", "-of", "json", filePath,
    ], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 20000 });
    if(result.status !== 0){
      const diagnostic = [result.stderr, result.error?.message].filter(Boolean).join("\n");
      const safeDiagnostic = redactSelectedSourcePath(diagnostic, selectedSourcePath);
      throw introError(
        "ffprobe failed for " + path.basename(filePath) + (safeDiagnostic ? "\n" + safeDiagnostic : ""),
        "INTRO_PROBE_FAILED"
      );
    }
    try{ return JSON.parse(result.stdout); }
    catch(error){ throw introError("ffprobe returned invalid metadata", "INTRO_PROBE_FAILED", { cause: error }); }
  }

  function inspectSelected(filePath){
    const inspected = inspectRegularMp4(filePath);
    const metadata = inspectMainMetadata(ffprobeJson(getTools().ffprobePath, inspected.path, {
      selectedSourcePath: inspected.path,
    }));
    return {
      path: inspected.path,
      name: path.basename(inspected.path),
      size: inspected.stat.size,
      modifiedMs: inspected.stat.mtimeMs,
      metadata,
    };
  }

  function publicSource(entry, outputSpec){
    if(!entry) return null;
    const ready = !outputSpec || outputSpec.fps === entry.metadata.fps;
    return {
      ready,
      name: entry.name,
      durationSeconds: entry.metadata.durationSeconds,
      fps: entry.metadata.fps,
      width: entry.metadata.width,
      height: entry.metadata.height,
      videoCodec: entry.metadata.videoCodec,
      pixelFormat: entry.metadata.pixelFormat,
      hasAudio: entry.metadata.hasAudio,
      ...(ready ? {} : {
        code: "INTRO_MAIN_INCOMPATIBLE",
        message: "Selected Export fps does not match outputSpec fps",
      }),
    };
  }

  function createOperation(sender = null){
    return {
      sender,
      cancelled: false,
      children: new Set(),
      renderWindow: null,
      tempRoot: null,
      lastState: null,
      sourcePath: null,
    };
  }

  function assertNotCancelled(operation){
    if(operation?.cancelled || disposed) throw cancelledError();
  }

  function killOperation(operation){
    return cancelTrackedOperation(operation);
  }

  function runTracked(operation, command, args, {
    label = path.basename(command),
    stdin = "ignore",
    stdout = "ignore",
    errorCode = "INTRO_COMMAND_FAILED",
  } = {}){
    assertNotCancelled(operation);
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: resolvedAppRoot,
        windowsHide: true,
        stdio: [stdin, stdout, "pipe"],
      });
      operation.children.add(child);
      let stderr = "";
      const stdoutChunks = [];
      let settled = false;
      child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-32000); });
      child.stdout?.on("data", chunk => stdoutChunks.push(Buffer.from(chunk)));
      const finish = (error, result) => {
        if(settled) return;
        settled = true;
        operation.children.delete(child);
        if(error) reject(error);
        else resolve(result);
      };
      child.once("error", error => finish(operation.cancelled ? cancelledError() : introError(
        label + " failed to start: " + redactSelectedSourcePath(error.message, operation.sourcePath),
        errorCode
      )));
      child.once("close", code => {
        if(operation.cancelled || disposed) return finish(cancelledError());
        const safeStderr = redactSelectedSourcePath(stderr, operation.sourcePath);
        if(code !== 0) return finish(introError(
          label + " failed (" + code + ")" + (safeStderr ? "\n" + safeStderr : ""),
          errorCode
        ));
        finish(null, { stdout: Buffer.concat(stdoutChunks), stderr: safeStderr });
      });
    });
  }

  function writeEncoderFrame(operation, encoder, bitmap){
    assertNotCancelled(operation);
    if(encoder.exitCode !== null || encoder.stdin.destroyed){
      throw introError("INTRO encoder closed before all frames were written", "INTRO_ENCODE_FAILED");
    }
    let accepted;
    try{ accepted = encoder.stdin.write(bitmap); }
    catch(error){
      if(operation.cancelled) throw cancelledError();
      throw introError(
        "INTRO encoder input failed: " + redactSelectedSourcePath(error.message, operation.sourcePath),
        "INTRO_ENCODE_FAILED"
      );
    }
    if(accepted) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        encoder.stdin.removeListener("drain", onDrain);
        encoder.stdin.removeListener("error", onError);
        encoder.removeListener("close", onClose);
      };
      const finish = error => {
        if(settled) return;
        settled = true;
        cleanup();
        if(error) reject(error);
        else resolve();
      };
      const onDrain = () => finish();
      const onError = error => finish(operation.cancelled
        ? cancelledError()
        : introError(
          "INTRO encoder input failed: " + redactSelectedSourcePath(error.message, operation.sourcePath),
          "INTRO_ENCODE_FAILED"
        ));
      const onClose = () => finish(operation.cancelled
        ? cancelledError()
        : introError("INTRO encoder closed before all frames were written", "INTRO_ENCODE_FAILED"));
      encoder.stdin.once("drain", onDrain);
      encoder.stdin.once("error", onError);
      encoder.once("close", onClose);
      if(encoder.exitCode !== null || encoder.stdin.destroyed) onClose();
    });
  }

  function emit(operation, state, progress, detail = {}){
    const payload = { state, progress: Math.max(0, Math.min(1, Number(progress) || 0)), ...detail };
    try{
      if(operation?.sender && !operation.sender.isDestroyed()) operation.sender.send("intro:progress", payload);
    }catch{}
    if(operation?.lastState !== state){
      operation.lastState = state;
      safeLog("intro_build_progress", { state, progress: payload.progress });
    }
    return payload;
  }

  function safeRemoveTemp(tempRoot){
    if(!tempRoot) return false;
    const resolved = path.resolve(tempRoot);
    const tempBase = path.resolve(os.tmpdir());
    const relative = path.relative(tempBase, resolved);
    if(!relative || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(resolved).startsWith(TEMP_PREFIX)){
      safeLog("intro_temp_cleanup_refused", { name: path.basename(resolved) });
      return false;
    }
    try{
      if(fs.existsSync(resolved)){
        const stat = fs.lstatSync(resolved);
        if(stat.isSymbolicLink()) fs.unlinkSync(resolved);
        else if(stat.isDirectory()) fs.rmSync(resolved, { recursive: true, force: true });
      }
      return true;
    }catch(error){
      safeLog("intro_temp_cleanup_failed", { code: error.code || "CLEANUP_FAILED" });
      return false;
    }
  }

  function safeRemoveIncompletePart(temporaryPath){
    try{
      return removeIncompletePart(temporaryPath);
    }catch(error){
      safeLog("intro_part_cleanup_failed", { code: error.code || "CLEANUP_FAILED", part: path.basename(temporaryPath) });
      return false;
    }
  }

  async function extractPreview(operation, selected, tempRoot){
    assertNotCancelled(operation);
    operation.sourcePath = selected.path;
    const sharpPath = path.join(tempRoot, "background-sharp.png");
    const blurredPath = path.join(tempRoot, "background-blurred.png");
    const ffmpegPath = getTools().ffmpegPath;
    await runTracked(operation, ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "warning", "-i", selected.path,
      "-frames:v", "1",
      "-vf", "scale=1280:1080:force_original_aspect_ratio=increase,crop=1280:1080", sharpPath,
    ], { label: "INTRO sharp-frame extraction" });
    regularFile(sharpPath, "INTRO sharp background");
    assertNotCancelled(operation);
    await runTracked(operation, ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "warning", "-i", sharpPath,
      "-frames:v", "1", "-vf", "gblur=sigma=18:steps=2", blurredPath,
    ], { label: "INTRO background blur" });
    regularFile(blurredPath, "INTRO blurred background");
    const toneResult = await runTracked(operation, ffmpegPath, [
      "-v", "error", "-i", blurredPath,
      "-vf", "crop=900:76:190:300,scale=1:1,format=gray",
      "-frames:v", "1", "-f", "rawvideo", "pipe:1",
    ], { label: "INTRO tone inspection", stdout: "pipe" });
    const tone = questionToneFromLuma(toneResult.stdout.length ? toneResult.stdout[0] : null);
    return {
      sharpPath,
      blurredPath,
      sharpUrl: pathToFileURL(sharpPath).href,
      blurredUrl: pathToFileURL(blurredPath).href,
      ...tone,
    };
  }

  function clearPreview(){
    const previous = previewEntry;
    previewEntry = null;
    if(!previous) return;
    killOperation(previous.operation);
    if(previous.promise) void previous.promise.catch(() => {});
    else safeRemoveTemp(previous.tempRoot);
  }

  async function ensurePreview(){
    if(!sessionExport) return null;
    const selected = sessionExport;
    const key = [selected.path, selected.modifiedMs, selected.size].join("|");
    if(previewEntry?.key === key){
      if(previewEntry.result) return previewEntry.result;
      return previewEntry.promise;
    }
    clearPreview();
    const operation = createOperation();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    const entry = { key, operation, tempRoot, result: null, promise: null };
    previewEntry = entry;
    entry.promise = (async () => {
      try{
        const result = await extractPreview(operation, selected, tempRoot);
        assertNotCancelled(operation);
        if(previewEntry !== entry) throw cancelledError();
        entry.result = result;
        safeLog("intro_source_prepared", {
          source: selected.name,
          durationSeconds: selected.metadata.durationSeconds,
          fps: selected.metadata.fps,
        });
        return result;
      }catch(error){
        const failure = redactSelectedSourceError(error, selected.path);
        safeRemoveTemp(tempRoot);
        if(previewEntry === entry) previewEntry = null;
        if(failure.code !== "INTRO_CANCELLED"){
          safeLog("intro_source_prepare_failed", {
            source: selected.name,
            code: failure.code,
            message: failure.message,
          });
        }
        throw failure;
      }finally{
        entry.promise = null;
      }
    })();
    void entry.promise.catch(() => {});
    return entry.promise;
  }

  function ensureOutputRoot(){
    const parent = path.dirname(resolvedOutputRoot);
    assertDirectoryNoLink(parent, "INTRO output parent");
    if(fs.existsSync(resolvedOutputRoot)) return assertDirectoryNoLink(resolvedOutputRoot, "INTRO output");
    return ensureDirectoryNoLink(resolvedOutputRoot, "INTRO output");
  }

  function inspectAssets(){
    regularFile(introHtml, "INTRO preroll HTML");
    regularFile(clickWav, "INTRO click audio");
    regularFile(keyboardWav, "INTRO keyboard audio");
  }

  async function renderIntro(operation, { preview, settings, spec, introPath }){
    inspectAssets();
    const renderWindow = new BrowserWindow({
      width: INTRO_WIDTH,
      height: INTRO_HEIGHT,
      useContentSize: true,
      show: false,
      paintWhenInitiallyHidden: true,
      backgroundColor: "#ffffff",
      webPreferences: {
        offscreen: { useSharedTexture: false, deviceScaleFactor: 1 },
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    operation.renderWindow = renderWindow;
    renderWindow.webContents.setAudioMuted(true);
    renderWindow.webContents.setFrameRate(spec.fps);
    renderWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    renderWindow.webContents.on("will-navigate", event => event.preventDefault());
    let encoder = null;
    let encoderClosed = null;
    let encoderSpawnError = null;
    let stderr = "";
    try{
      await renderWindow.loadFile(introHtml);
      assertNotCancelled(operation);
      const config = {
        prompt: settings.prompt,
        reply: settings.reply,
        typingSeconds: settings.typingSeconds,
        backgroundImage: preview.blurredUrl,
        backgroundSharpImage: preview.sharpUrl,
        questionColor: preview.questionColor,
        questionShadow: preview.questionShadow,
        audioEnabled: false,
      };
      await renderWindow.webContents.executeJavaScript(
        `window.introPreroll.configure(${JSON.stringify(config)})`
      );
      const timeline = await renderWindow.webContents.executeJavaScript("window.introPreroll.getTimeline()");
      const duration = Number(timeline?.end);
      if(!Number.isFinite(duration) || duration <= 0){
        throw introError("INTRO preroll returned an invalid timeline", "INTRO_TIMELINE_INVALID");
      }
      const totalFrames = Math.ceil(duration * spec.fps);
      const audioFilter = buildIntroAudioFilter(timeline, duration, settings.soundEnabled);
      const ffmpegArgs = [
        "-y", "-hide_banner", "-loglevel", "warning",
        "-f", "rawvideo", "-pixel_format", "bgra", "-video_size", "1280x1080",
        "-framerate", String(spec.fps), "-i", "pipe:0",
        "-i", clickWav, "-i", keyboardWav,
        "-filter_complex", audioFilter, "-map", "0:v:0", "-map", "[aout]",
        "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
        ...encoderArguments(spec.bitrateMbps),
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-t", duration.toFixed(6), "-movflags", "+faststart", introPath,
      ];
      encoder = spawn(getTools().ffmpegPath, ffmpegArgs, {
        cwd: resolvedAppRoot,
        windowsHide: true,
        stdio: ["pipe", "ignore", "pipe"],
      });
      operation.children.add(encoder);
      encoderClosed = new Promise(resolve => {
        encoder.once("error", error => { encoderSpawnError = error; });
        encoder.once("close", code => resolve(code));
      });
      encoder.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-32000); });
      encoder.stdin.on("error", () => {});
      for(let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1){
        assertNotCancelled(operation);
        const seconds = Math.min(duration, frameIndex / spec.fps);
        await renderWindow.webContents.executeJavaScript(`window.introPreroll.renderAt(${JSON.stringify(seconds)})`);
        const image = await renderWindow.webContents.capturePage();
        const size = image.getSize();
        if(size.width !== INTRO_WIDTH || size.height !== INTRO_HEIGHT){
          throw introError("INTRO frame size changed", "INTRO_FRAME_INVALID");
        }
        const bitmap = image.toBitmap();
        if(bitmap.length !== INTRO_WIDTH * INTRO_HEIGHT * 4){
          throw introError("INTRO frame buffer is invalid", "INTRO_FRAME_INVALID");
        }
        await writeEncoderFrame(operation, encoder, bitmap);
        if(frameIndex % Math.max(1, Math.round(spec.fps / 5)) === 0 || frameIndex === totalFrames - 1){
          emit(operation, "rendering_intro", 0.12 + 0.43 * ((frameIndex + 1) / totalFrames), {
            frame: frameIndex + 1,
            totalFrames,
          });
        }
      }
      encoder.stdin.end();
      const exitCode = await encoderClosed;
      operation.children.delete(encoder);
      if(operation.cancelled) throw cancelledError();
      if(encoderSpawnError){
        throw introError(
          "INTRO encoder failed to start: " + redactSelectedSourcePath(encoderSpawnError.message, operation.sourcePath),
          "INTRO_ENCODE_FAILED"
        );
      }
      if(exitCode !== 0){
        const safeStderr = redactSelectedSourcePath(stderr, operation.sourcePath);
        throw introError(
          "INTRO encoder failed (" + exitCode + ")" + (safeStderr ? "\n" + safeStderr : ""),
          "INTRO_ENCODE_FAILED"
        );
      }
      regularFile(introPath, "Rendered INTRO");
      return { duration, totalFrames, timeline };
    }finally{
      if(encoder && encoder.exitCode === null && !encoder.killed){
        try{ encoder.kill("SIGKILL"); }catch{}
      }
      if(encoderClosed){
        try{ await encoderClosed; }catch{}
      }
      if(encoder) operation.children.delete(encoder);
      if(!renderWindow.isDestroyed()) renderWindow.destroy();
      if(operation.renderWindow === renderWindow) operation.renderWindow = null;
    }
  }

  async function normalizeMainAudio(operation, mainPath, normalizedPath, mainMeta){
    await runTracked(operation, getTools().ffmpegPath, mainAudioArguments(mainPath, normalizedPath, mainMeta), {
      label: "Main audio normalization",
    });
  }

  async function toTransportStream(operation, inputPath, outputPath, label){
    await runTracked(operation, getTools().ffmpegPath, transportStreamArguments(inputPath, outputPath), { label });
  }

  async function concatSegments(operation, introTs, mainTs, temporaryPath, tempRoot){
    const plan = concatPlan(introTs, mainTs, temporaryPath, tempRoot);
    fs.writeFileSync(
      plan.listPath,
      plan.listText,
      { encoding: "utf8", flag: "wx" }
    );
    await runTracked(operation, getTools().ffmpegPath, plan.args, { label: "INTRO lossless video concatenation" });
  }

  async function verifyResult(operation, temporaryPath, expectedDuration, transitionSeconds, fps){
    const metadata = ffprobeJson(getTools().ffprobePath, temporaryPath);
    const result = validateFinalMetadata(metadata, { expectedDuration, fps });
    await runTracked(operation, getTools().ffmpegPath, [
      "-v", "error", "-ss", Math.max(0, transitionSeconds - 0.15).toFixed(6), "-i", temporaryPath,
      "-t", "0.35", "-map", "0:v:0", "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null",
    ], { label: "INTRO transition decode verification", errorCode: "INTRO_VERIFY_FAILED" });
    return result;
  }

  function setSessionExport(filePath, jobId = null){
    assertUsable();
    if(active) throw introError("An INTRO build is already running", "INTRO_ALREADY_RUNNING");
    if(filePath === undefined || filePath === null || filePath === ""){
      clearPreview();
      sessionExport = null;
      sessionExportJobId = null;
      safeLog("intro_source_selection_cleared");
      return null;
    }
    let next;
    try{
      next = inspectSelected(filePath);
    }catch(error){
      const selectedPath = typeof filePath === "string" ? filePath : "";
      const failure = redactSelectedSourceError(error, selectedPath);
      safeLog("intro_source_prepare_failed", {
        source: path.basename(String(filePath)),
        code: failure.code,
        message: failure.message,
      });
      throw failure;
    }
    clearPreview();
    sessionExport = next;
    sessionExportJobId = typeof jobId === "string" && jobId ? jobId : null;
    safeLog("intro_source_selected", {
      name: next.name,
      durationSeconds: next.metadata.durationSeconds,
      fps: next.metadata.fps,
    });
    return publicSource(next);
  }

  function recordCompletedExport(filePath, jobId){
    const selected = setSessionExport(filePath, jobId);
    writeSourceRecord(sessionExport, jobId);
    sourceRecordRestoreAttempt = jobId;
    return selected;
  }

  async function getSummary(context = {}){
    assertUsable();
    const request = context && typeof context === "object" ? context : {};
    const settings = normalizeIntroSettings(request.settings || {});
    const language = request.language === "ko" ? "ko" : "en";
    const jobId = request.jobId ?? null;
    const revision = request.revision ?? null;
    if(sessionExport && sessionExportJobId && jobId && sessionExportJobId !== jobId){
      clearPreview();
      sessionExport = null;
      sessionExportJobId = null;
    }
    if(!sessionExport && sourceRecordRestoreAttempt !== jobId) restoreSourceRecord(jobId);
    if(!sessionExport){
      return {
        jobId,
        revision,
        settings,
        language,
        outputSpec: normalizeOutputSpec(request.outputSpec || {}),
        source: null,
        preview: null,
        building: Boolean(active),
      };
    }
    const refreshed = inspectSelected(sessionExport.path);
    if(refreshed.size !== sessionExport.size || refreshed.modifiedMs !== sessionExport.modifiedMs){
      clearPreview();
      sessionExport = refreshed;
    }else{
      sessionExport = { ...sessionExport, metadata: refreshed.metadata };
    }
    const outputSpec = normalizeOutputSpec(request.outputSpec || {}, sessionExport.metadata, { requireFpsMatch: false });
    let preview = previewEntry?.result || null;
    if(!active) preview = await ensurePreview();
    return {
      jobId,
      revision,
      settings,
      language,
      outputSpec,
      source: publicSource(sessionExport, outputSpec),
      preview: preview ? {
        blurredUrl: preview.blurredUrl,
        sharpUrl: preview.sharpUrl,
        questionColor: preview.questionColor,
        questionShadow: preview.questionShadow,
      } : null,
      building: Boolean(active),
    };
  }

  async function selectExport(owner, context = {}){
    assertUsable();
    if(active) throw introError("An INTRO build is already running", "INTRO_ALREADY_RUNNING");
    const options = {
      title: "Select Workflow Showcase Export",
      properties: ["openFile"],
      filters: [{ name: "H.264 MP4 Export", extensions: ["mp4"] }],
    };
    const result = owner && typeof owner.isDestroyed === "function" && !owner.isDestroyed()
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if(result.canceled || !result.filePaths?.[0]){
      safeLog("intro_source_selection_cancelled");
      return null;
    }
    setSessionExport(result.filePaths[0], context?.jobId);
    try{ writeSourceRecord(sessionExport, context?.jobId); }
    catch(error){
      if(error?.code !== "INTRO_RECORDED_SOURCE_INVALID") throw error;
      safeLog("intro_manual_source_session_only", { source: sessionExport?.name || null });
    }
    return getSummary(context);
  }

  async function start(sender, payload = {}){
    assertUsable();
    if(active) throw introError("An INTRO build is already running", "INTRO_ALREADY_RUNNING");
    const operation = createOperation(sender);
    active = operation;
    let selected = null;
    let paths = null;
    let verifiedPart = false;
    emit(operation, "preparing", 0);
    try{
      if(!sessionExport) throw introError("Select a Workflow Showcase Export first", "INTRO_MAIN_MISSING");
      operation.sourcePath = sessionExport.path;
      const settings = normalizeIntroSettings(payload?.settings || {});
      selected = inspectSelected(sessionExport.path);
      sessionExport = selected;
      const spec = normalizeOutputSpec(payload?.outputSpec || {}, selected.metadata);
      ensureOutputRoot();
      inspectAssets();
      getTools();
      paths = availableDemoPaths(resolvedOutputRoot);
      operation.tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
      operation.temporaryPath = paths.temporaryPath;
      emit(operation, "preparing", 0, { outputName: paths.outputName });
      safeLog("intro_build_started", {
        source: selected.name,
        output: paths.outputName,
        fps: spec.fps,
        bitrateMbps: spec.bitrateMbps,
        soundEnabled: settings.soundEnabled,
      });
      assertNotCancelled(operation);
      emit(operation, "extracting", 0.04);
      const preview = await extractPreview(operation, selected, operation.tempRoot);
      safeLog("intro_source_prepared", {
        source: selected.name,
        durationSeconds: selected.metadata.durationSeconds,
        fps: selected.metadata.fps,
      });
      emit(operation, "rendering_intro", 0.12);
      const introPath = path.join(operation.tempRoot, "intro.mp4");
      const normalizedMain = path.join(operation.tempRoot, "main-normalized.mp4");
      const introTs = path.join(operation.tempRoot, "intro.ts");
      const mainTs = path.join(operation.tempRoot, "main.ts");
      const intro = await renderIntro(operation, { preview, settings, spec, introPath });
      assertNotCancelled(operation);
      let space;
      try{
        space = assertExportSpace({
          destinationPath: resolvedOutputRoot,
          durationSeconds: intro.duration + selected.metadata.durationSeconds,
          bitrateMbps: spec.bitrateMbps,
        });
      }catch(error){
        if(error?.code !== "INSUFFICIENT_DISK_SPACE") throw error;
        throw introError(error.message, error.code, {
          requiredBytes: error.requiredBytes,
          availableBytes: error.availableBytes,
        });
      }
      safeLog("intro_space_checked", {
        estimatedBytes: space.estimatedBytes,
        reserveBytes: space.reserveBytes,
        availableBytes: space.availableBytes.toString(),
      });
      emit(operation, "normalizing_audio", 0.58);
      await normalizeMainAudio(operation, selected.path, normalizedMain, selected.metadata);
      emit(operation, "converting_intro", 0.66);
      await toTransportStream(operation, introPath, introTs, "INTRO transport conversion");
      emit(operation, "converting_main", 0.73);
      await toTransportStream(operation, normalizedMain, mainTs, "Main transport conversion");
      emit(operation, "concatenating", 0.81);
      await concatSegments(operation, introTs, mainTs, paths.temporaryPath, operation.tempRoot);
      emit(operation, "verifying", 0.91);
      const result = await verifyResult(
        operation,
        paths.temporaryPath,
        intro.duration + selected.metadata.durationSeconds,
        intro.duration,
        spec.fps
      );
      verifiedPart = true;
      emit(operation, "finalizing", 0.98);
      try{
        finalizeVerifiedPart(paths.temporaryPath, paths.outputPath);
      }catch(error){
        const partPreserved = fs.existsSync(paths.temporaryPath);
        safeLog("intro_finalize_failed", {
          code: error.code || "FINALIZE_FAILED",
          part: partPreserved ? path.basename(paths.temporaryPath) : null,
        });
        throw error;
      }
      emit(operation, "complete", 1, { outputPath: paths.outputPath, outputName: paths.outputName });
      safeLog("intro_build_completed", {
        output: paths.outputName,
        durationSeconds: result.durationSeconds,
        introDurationSeconds: intro.duration,
        mainDurationSeconds: selected.metadata.durationSeconds,
      });
      return {
        ok: true,
        outputPath: paths.outputPath,
        outputName: paths.outputName,
        durationSeconds: result.durationSeconds,
        introDurationSeconds: intro.duration,
        mainDurationSeconds: selected.metadata.durationSeconds,
        totalFrames: intro.totalFrames,
        videoCodec: result.videoCodec,
        audioCodec: result.audioCodec,
      };
    }catch(error){
      const failure = redactSelectedSourceError(error, operation.sourcePath);
      if(operation.cancelled || failure.code === "INTRO_CANCELLED"){
        verifiedPart = false;
        if(paths) safeRemoveIncompletePart(paths.temporaryPath);
        emit(operation, "cancelled", 0);
        safeLog("intro_build_cancelled", { source: selected?.name || sessionExport?.name || null });
        return { ok: false, cancelled: true };
      }
      if(paths && !verifiedPart) safeRemoveIncompletePart(paths.temporaryPath);
      emit(operation, "error", 0, {
        code: failure.code,
        message: failure.message,
        partPreserved: Boolean(paths && verifiedPart && fs.existsSync(paths.temporaryPath)),
      });
      safeLog("intro_build_failed", {
        code: failure.code,
        message: failure.message,
        partPreserved: paths && verifiedPart && fs.existsSync(paths.temporaryPath)
          ? path.basename(paths.temporaryPath)
          : null,
      });
      throw failure;
    }finally{
      killOperation(operation);
      safeRemoveTemp(operation.tempRoot);
      if(active === operation) active = null;
    }
  }

  function cancel(){
    if(!active) return false;
    emit(active, "cancelling", 0);
    killOperation(active);
    clearPreview();
    return true;
  }

  function dispose(){
    if(disposed) return false;
    disposed = true;
    if(active) killOperation(active);
    clearPreview();
    sessionExport = null;
    sessionExportJobId = null;
    sourceRecordRestoreAttempt = null;
    return true;
  }

  return {
    setSessionExport,
    recordCompletedExport,
    getSummary,
    selectExport,
    start,
    cancel,
    isRunning: () => Boolean(active),
    dispose,
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  availableDemoPaths,
  buildIntroAudioFilter,
  cancelTrackedOperation,
  concatPlan,
  createIntroDemoController,
  finalizeVerifiedPart,
  inspectMainMetadata,
  inspectRegularMp4,
  introError,
  mainAudioArguments,
  normalizeIntroSettings,
  normalizeOutputSpec,
  questionToneFromLuma,
  rationalNumber,
  redactSelectedSourceDetail,
  redactSelectedSourceError,
  redactSelectedSourcePath,
  removeIncompletePart,
  timestampName,
  transportStreamArguments,
  validateFinalMetadata,
};
