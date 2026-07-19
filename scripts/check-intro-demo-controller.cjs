"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DEFAULT_SETTINGS,
  availableDemoPaths,
  buildIntroAudioFilter,
  cancelTrackedOperation,
  concatPlan,
  createIntroDemoController,
  finalizeVerifiedPart,
  inspectMainMetadata,
  inspectRegularMp4,
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
} = require("../intro-demo-controller.cjs");

function expectCode(callback, code){
  assert.throws(callback, error => error?.code === code, "Expected error code " + code);
}

function metadata({
  codec = "h264",
  width = 1280,
  height = 1080,
  pixelFormat = "yuv420p",
  fps = "60/1",
  duration = "12.5",
  audio = true,
  audioCodec = "aac",
} = {}){
  return {
    streams: [
      {
        codec_type: "video",
        codec_name: codec,
        width,
        height,
        pix_fmt: pixelFormat,
        avg_frame_rate: fps,
        r_frame_rate: fps,
      },
      ...(audio ? [{
        codec_type: "audio",
        codec_name: audioCodec,
        sample_rate: "48000",
        channels: 2,
      }] : []),
    ],
    format: { duration },
  };
}

async function main(){
  assert.equal(rationalNumber("60000/1000"), 60);
  assert.equal(rationalNumber("0/0"), 0);

  const inspected = inspectMainMetadata(metadata());
  assert.deepEqual(inspected, {
    durationSeconds: 12.5,
    fps: 60,
    width: 1280,
    height: 1080,
    videoCodec: "h264",
    pixelFormat: "yuv420p",
    hasAudio: true,
    audioCodec: "aac",
  });
  const fallbackRate = metadata({ fps: "24/1", audio: false });
  fallbackRate.streams[0].avg_frame_rate = "0/0";
  assert.equal(inspectMainMetadata(fallbackRate).fps, 24);
  assert.equal(inspectMainMetadata(fallbackRate).hasAudio, false);
  expectCode(() => inspectMainMetadata(metadata({ codec: "hevc" })), "INTRO_MAIN_INCOMPATIBLE");
  expectCode(() => inspectMainMetadata(metadata({ width: 1920 })), "INTRO_MAIN_INCOMPATIBLE");
  expectCode(() => inspectMainMetadata(metadata({ pixelFormat: "yuv444p" })), "INTRO_MAIN_INCOMPATIBLE");
  expectCode(() => inspectMainMetadata(metadata({ fps: "30000/1001" })), "INTRO_MAIN_INCOMPATIBLE");

  const selectedAbsolutePath = ["C:", "Users", "Private Person", "Exports", "Rescue Demo.MP4"].join("\\");
  const selectedBasename = "Rescue Demo.MP4";
  const forwardSelectedPath = selectedAbsolutePath.replace(/\\/g, "/");
  const encodedSelectedUrl = "file:///" + forwardSelectedPath.split("/").map(segment => encodeURIComponent(segment)).join("/").replace(/^C%3A/i, "C:");
  const sensitiveDiagnostics = [
    "Invalid data in " + selectedAbsolutePath,
    "Permission denied: " + selectedAbsolutePath.toUpperCase(),
    "Could not open " + forwardSelectedPath,
    "Could not open " + encodedSelectedUrl,
    "Could not inspect \\\\?\\" + selectedAbsolutePath,
  ];
  for(const diagnostic of sensitiveDiagnostics){
    const redacted = redactSelectedSourcePath(diagnostic, selectedAbsolutePath);
    assert.match(redacted, /Rescue Demo\.MP4/i);
    assert.doesNotMatch(redacted, /Private Person/i);
    assert.doesNotMatch(redacted, /file:\/\/\//i);
    assert.doesNotMatch(redacted, /\\\\\?\\/i);
  }
  const rawSourceError = new Error("EACCES: cannot read " + selectedAbsolutePath + "; invalid header retained");
  rawSourceError.code = "EACCES";
  rawSourceError.cause = new Error("raw cause " + selectedAbsolutePath);
  rawSourceError.partPath = selectedAbsolutePath;
  const safeSourceError = redactSelectedSourceError(rawSourceError, selectedAbsolutePath);
  assert.equal(safeSourceError.code, "EACCES");
  assert.match(safeSourceError.message, /invalid header retained/);
  assert.match(safeSourceError.message, new RegExp(selectedBasename.replace(".", "\\.")));
  assert.doesNotMatch(safeSourceError.message, /Private Person/i);
  assert.equal(Object.prototype.hasOwnProperty.call(safeSourceError, "cause"), false);
  assert.equal(safeSourceError.partPath, selectedBasename);
  const safeDetail = redactSelectedSourceDetail({
    message: "ffprobe stderr: " + selectedAbsolutePath + " has invalid moov atom",
    code: "INTRO_PROBE_FAILED",
    nested: { attempted: selectedAbsolutePath.toUpperCase() },
  }, selectedAbsolutePath);
  assert.equal(safeDetail.code, "INTRO_PROBE_FAILED");
  assert.match(safeDetail.message, /Rescue Demo\.MP4 has invalid moov atom/);
  assert.doesNotMatch(safeDetail.message, /Private Person/i);
  assert.equal(safeDetail.nested.attempted, selectedBasename);

  const regularStat = { isSymbolicLink: () => false, isFile: () => true };
  assert.equal(inspectRegularMp4("selected.mp4", {
    fileSystem: { lstatSync: () => regularStat },
  }).path, path.resolve("selected.mp4"));
  expectCode(() => inspectRegularMp4("missing.mp4", {
    fileSystem: { lstatSync: () => { const error = new Error("missing"); error.code = "ENOENT"; throw error; } },
  }), "INTRO_MAIN_MISSING");
  expectCode(() => inspectRegularMp4("linked.mp4", {
    fileSystem: { lstatSync: () => ({ isSymbolicLink: () => true, isFile: () => true }) },
  }), "INTRO_FILE_UNSAFE");
  expectCode(() => inspectRegularMp4("selected.mov", {
    fileSystem: { lstatSync: () => regularStat },
  }), "INTRO_MAIN_INCOMPATIBLE");
  let privateFileError = null;
  try{
    inspectRegularMp4(selectedAbsolutePath, {
      fileSystem: {
        lstatSync: () => {
          const error = new Error("EACCES: lstat '" + forwardSelectedPath.toUpperCase() + "'");
          error.code = "EACCES";
          throw error;
        },
      },
    });
  }catch(error){ privateFileError = error; }
  assert.equal(privateFileError?.code, "EACCES");
  assert.match(privateFileError?.message || "", /Rescue Demo\.MP4/);
  assert.doesNotMatch(privateFileError?.message || "", /PRIVATE PERSON/i);

  assert.deepEqual(Object.keys(DEFAULT_SETTINGS).sort(), ["prompt", "reply", "soundEnabled", "typingSeconds"]);
  assert.deepEqual(normalizeIntroSettings({
    prompt: "  Keep\nthis\tcompact  ",
    reply: "",
    typingSeconds: 2,
    soundEnabled: false,
    ignored: "not persisted",
  }), {
    prompt: "Keep this compact",
    reply: "",
    typingSeconds: 2,
    soundEnabled: false,
  });
  assert.deepEqual(normalizeIntroSettings(), DEFAULT_SETTINGS);
  expectCode(() => normalizeIntroSettings({ prompt: "x".repeat(501) }), "INTRO_ARGUMENT_INVALID");
  expectCode(() => normalizeIntroSettings({ reply: null }), "INTRO_ARGUMENT_INVALID");
  expectCode(() => normalizeIntroSettings({ typingSeconds: 1.5 }), "INTRO_ARGUMENT_INVALID");
  expectCode(() => normalizeIntroSettings({ soundEnabled: "yes" }), "INTRO_ARGUMENT_INVALID");
  const audioTimeline = {
    focus: .55,
    send: 2.8,
    keyEvents: [{ time: 1.1, sampleOffset: .31, sampleDuration: .075 }],
  };
  const audioFilter = buildIntroAudioFilter(audioTimeline, 4, true);
  assert.match(audioFilter, /\[2:a\]anull\[keysrc0\]/);
  assert.match(audioFilter, /adelay=1100\|1100\[key0\]/);
  assert.match(audioFilter, /amix=inputs=4/);
  assert.equal(buildIntroAudioFilter(audioTimeline, 4, false), "anullsrc=r=48000:cl=stereo:d=4.000000[bed];[bed]anull[aout]");

  const spec = normalizeOutputSpec({ fps: 60, bitrateMbps: 14 }, inspected);
  assert.equal(spec.width, 1280);
  assert.equal(spec.height, 1080);
  assert.equal(spec.fps, 60);
  assert.equal(spec.bitrateMbps, 14);
  assert.equal(spec.outputPixelFormat, "yuv420p");
  expectCode(() => normalizeOutputSpec({ fps: 24 }, inspected), "INTRO_MAIN_INCOMPATIBLE");
  expectCode(() => normalizeOutputSpec({ width: 1920 }, inspected), "INTRO_OUTPUT_SPEC_INVALID");
  expectCode(() => normalizeOutputSpec({ fps: 59.94 }, inspected), "INTRO_OUTPUT_SPEC_INVALID");

  const date = new Date(2026, 6, 19, 6, 7, 8);
  assert.equal(timestampName(date), "20260719_060708");
  const firstName = "workflow_showcase_demo_20260719_060708.mp4";
  const paths = availableDemoPaths("X:\\output", {
    date,
    existsSync: candidate => path.basename(candidate) === firstName,
  });
  assert.equal(paths.outputName, "workflow_showcase_demo_20260719_060708_02.mp4");
  assert.equal(path.basename(paths.temporaryPath), "workflow_showcase_demo_20260719_060708_02.part.mp4");

  assert.equal(questionToneFromLuma(20).questionColor, "#ffffff");
  assert.equal(questionToneFromLuma(220).questionColor, "#151a18");
  assert.equal(questionToneFromLuma(null).luma, null);

  const normalizedWithAudio = mainAudioArguments("main.mp4", "normalized.mp4", {
    durationSeconds: 12.5,
    hasAudio: true,
  });
  assert.match(normalizedWithAudio.join(" "), /-c:v copy/);
  assert.match(normalizedWithAudio.join(" "), /-c:a aac/);
  assert.doesNotMatch(normalizedWithAudio.join(" "), /anullsrc/);
  const normalizedWithSilence = mainAudioArguments("main.mp4", "normalized.mp4", {
    durationSeconds: 12.5,
    hasAudio: false,
  });
  assert.match(normalizedWithSilence.join(" "), /anullsrc=r=48000:cl=stereo/);
  assert.match(normalizedWithSilence.join(" "), /-c:v copy/);
  const transport = transportStreamArguments("normalized.mp4", "main.ts");
  assert.match(transport.join(" "), /-c copy/);
  assert.match(transport.join(" "), /h264_mp4toannexb/);
  const plannedConcat = concatPlan("intro.ts", "main.ts", "demo.part.mp4", "temp-root");
  assert.match(plannedConcat.listText, /intro\.ts/);
  assert.match(plannedConcat.listText, /main\.ts/);
  assert.match(plannedConcat.args.join(" "), /-c copy/);
  assert.equal(plannedConcat.args.at(-1), "demo.part.mp4");

  const killed = [];
  let windowDestroyed = false;
  const trackedOperation = {
    cancelled: false,
    children: new Set([
      { exitCode: null, killed: false, kill: signal => killed.push(signal) },
      { exitCode: 0, killed: false, kill: () => killed.push("unexpected") },
    ]),
    renderWindow: {
      isDestroyed: () => false,
      destroy: () => { windowDestroyed = true; },
    },
  };
  assert.equal(cancelTrackedOperation(trackedOperation), true);
  assert.equal(trackedOperation.cancelled, true);
  assert.deepEqual(killed, ["SIGKILL"]);
  assert.equal(windowDestroyed, true);
  assert.equal(cancelTrackedOperation(null), false);

  const finalizeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "intro-controller-check-"));
  try{
    const partPath = path.join(finalizeRoot, "success.part.mp4");
    const outputPath = path.join(finalizeRoot, "success.mp4");
    fs.writeFileSync(partPath, "verified demo bytes");
    finalizeVerifiedPart(partPath, outputPath);
    assert.equal(fs.existsSync(partPath), false);
    assert.equal(fs.readFileSync(outputPath, "utf8"), "verified demo bytes");

    const preservedPart = path.join(finalizeRoot, "preserved.part.mp4");
    const blockedOutput = path.join(finalizeRoot, "blocked.mp4");
    fs.writeFileSync(preservedPart, "verified recovery bytes");
    let finalizeFailure = null;
    try{
      finalizeVerifiedPart(preservedPart, blockedOutput, {
        replaceFile: () => { const error = new Error("rename blocked"); error.code = "EPERM"; throw error; },
      });
    }catch(error){ finalizeFailure = error; }
    assert.equal(finalizeFailure?.code, "INTRO_FINALIZE_DEFERRED");
    assert.equal(finalizeFailure?.partPath, preservedPart);
    assert.equal(fs.readFileSync(preservedPart, "utf8"), "verified recovery bytes");

    const incompletePart = path.join(finalizeRoot, "incomplete.part.mp4");
    fs.writeFileSync(incompletePart, "incomplete bytes");
    assert.equal(removeIncompletePart(incompletePart), true);
    assert.equal(fs.existsSync(incompletePart), false);
    assert.equal(removeIncompletePart(incompletePart), false);
  }finally{
    fs.rmSync(finalizeRoot, { recursive: true, force: true });
  }

  const verified = validateFinalMetadata(metadata({ duration: "16.75" }), {
    expectedDuration: 16.75,
    fps: 60,
  });
  assert.deepEqual(verified, { durationSeconds: 16.75, videoCodec: "h264", audioCodec: "aac" });
  const streamCopyConcatMetadata = metadata({ duration: "16.75", fps: "48/1" });
  streamCopyConcatMetadata.streams[0].avg_frame_rate = "5607/250";
  assert.deepEqual(validateFinalMetadata(streamCopyConcatMetadata, {
    expectedDuration: 16.75,
    fps: 24,
  }), { durationSeconds: 16.75, videoCodec: "h264", audioCodec: "aac" });
  expectCode(() => validateFinalMetadata(metadata({ audioCodec: "mp3" }), {
    expectedDuration: 12.5,
    fps: 60,
  }), "INTRO_VERIFY_FAILED");
  expectCode(() => validateFinalMetadata(metadata({ pixelFormat: "yuv444p" }), {
    expectedDuration: 12.5,
    fps: 60,
  }), "INTRO_VERIFY_FAILED");
  expectCode(() => validateFinalMetadata(metadata(), {
    expectedDuration: null,
    fps: 60,
  }), "INTRO_VERIFY_FAILED");

  function FakeBrowserWindow(){}
  const controller = createIntroDemoController({
    BrowserWindow: FakeBrowserWindow,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    appRoot: path.resolve(__dirname, ".."),
    outputRoot: path.resolve(__dirname, "..", "output"),
    logEvent: () => {},
  });
  assert.deepEqual(Object.keys(controller).sort(), [
    "cancel",
    "dispose",
    "getSummary",
    "isRunning",
    "recordCompletedExport",
    "selectExport",
    "setSessionExport",
    "start",
  ]);
  const summary = await controller.getSummary({
    jobId: "job-check",
    revision: 7,
    settings: { prompt: "A", reply: "B", typingSeconds: 1 },
    language: "ko",
    outputSpec: { fps: 24, bitrateMbps: 12 },
  });
  assert.equal(summary.jobId, "job-check");
  assert.equal(summary.revision, 7);
  assert.equal(summary.language, "ko");
  assert.equal(summary.source, null);
  assert.equal(summary.preview, null);
  assert.equal(summary.building, false);
  assert.equal(summary.outputSpec.fps, 24);
  const progress = [];
  await assert.rejects(controller.start({
    isDestroyed: () => false,
    send: (channel, payload) => progress.push({ channel, payload }),
  }, {}), error => error?.code === "INTRO_MAIN_MISSING");
  assert.deepEqual(progress.map(entry => entry.channel), ["intro:progress", "intro:progress"]);
  assert.deepEqual(progress.map(entry => entry.payload.state), ["preparing", "error"]);
  assert.equal(controller.isRunning(), false);
  assert.equal(controller.cancel(), false);
  assert.equal(controller.setSessionExport(""), null);
  assert.equal(await controller.selectExport(null, {}), null);
  assert.equal(controller.dispose(), true);
  assert.equal(controller.dispose(), false);
  await assert.rejects(controller.getSummary({}), error => error?.code === "INTRO_DISPOSED");

  const controllerPath = path.resolve(__dirname, "..", "intro-demo-controller.cjs");
  const source = fs.readFileSync(controllerPath, "utf8");
  assert.doesNotMatch(source, /current-job/i);
  assert.doesNotMatch(source, /latestMain|mtimeMs\s*\).*sort/i);
  assert.doesNotMatch(source, /require\(["']electron["']\)|app\.whenReady|app\.quit/);
  assert.match(source, /sandbox:\s*true/);
  assert.match(source, /window\.introPreroll\.configure/);
  assert.match(source, /window\.introPreroll\.renderAt/);
  assert.match(source, /window\.introPreroll\.getTimeline/);
  const builderHtml = fs.readFileSync(path.resolve(__dirname, "..", "src", "intro-builder.html"), "utf8");
  const builderSource = fs.readFileSync(path.resolve(__dirname, "..", "src", "intro-builder.js"), "utf8");
  const sceneSource = fs.readFileSync(path.resolve(__dirname, "..", "src", "intro-preroll.html"), "utf8");
  assert.match(builderHtml, /id="promptInput" rows="3"/);
  assert.match(builderHtml, /id="replyInput" rows="3"/);
  assert.ok(builderHtml.indexOf("SHOWCASE EXPORT") < builderHtml.indexOf("TYPE TIME"));
  assert.match(builderHtml, /id="replayButton"[^>]*>REPLAY INTRO</);
  assert.match(builderHtml, /id="buildButton"[^>]*>BUILD</);
  assert.equal((builderHtml.match(/id="replayButton"/g) || []).length, 1);
  assert.match(builderHtml, /id="previewToggle"/);
  assert.match(builderSource, /togglePreviewPlayback/);
  assert.match(builderSource, /replayButton"\)\.disabled = running \|\| !previewReady/);
  assert.match(sceneSource, /Object\.freeze\(\{configure,replay,pause,resume,isPlaying:/);
  assert.match(builderSource, /insertLineBreak/);
  assert.match(builderSource, /singleLineText/);
  assert.match(source, /src["'],\s*["']assets["'],\s*["']intro-click\.wav/);
  assert.match(source, /src["'],\s*["']assets["'],\s*["']intro-keyboard\.wav/);
  assert.match(source, /sender\.send\(["']intro:progress["']/);
  assert.match(source, /"-c:v",\s*"copy"/);
  assert.match(source, /replaceByRenameWithRetry/);
  assert.match(source, /verifiedPart/);
  assert.doesNotMatch(source, /frameAtSeconds|\bframeAt\b/);
  assert.match(source, /redactSelectedSourcePath\(diagnostic, selectedSourcePath\)/);
  assert.doesNotMatch(source, /source:\s*(?:sessionExport|selected|next)\.path/);

  console.log("INTRO_DEMO_CONTROLLER_CHECK_OK");
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
