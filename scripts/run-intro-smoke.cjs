"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createIntroDemoController } = require("../intro-demo-controller.cjs");

const APP_ROOT = path.resolve(__dirname, "..");
const WIDTH = 1280;
const HEIGHT = 1080;
const FPS = 24;
const MAIN_DURATION = 0.5;
const TEMP_PREFIX = "workflow-showcase-intro-smoke-";
const FRAME = createFrame();
const TIMELINE = Object.freeze({
  focus: 0.05,
  type: 0.12,
  typeDur: 0.22,
  send: 0.42,
  end: 1,
  keyEvents: [
    { time: 0.16, sampleOffset: 0.31, sampleDuration: 0.075 },
    { time: 0.28, sampleOffset: 0.47, sampleDuration: 0.075 },
  ],
});

function createFrame(){
  const frame = Buffer.alloc(WIDTH * HEIGHT * 4);
  frame.fill(Buffer.from([0x52, 0x3b, 0x24, 0xff]));
  return frame;
}

function resolveTool(name){
  const bundled = path.join(APP_ROOT, "ffmpeg", name + ".exe");
  const candidates = fs.existsSync(bundled) ? [bundled, name] : [name];
  for(const candidate of candidates){
    const result = spawnSync(candidate, ["-hide_banner", "-version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    });
    if(result.status === 0) return candidate;
  }
  throw new Error(name + " is not available");
}

function run(command, args, label){
  const result = spawnSync(command, args, {
    cwd: APP_ROOT,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60000,
  });
  if(result.error) throw result.error;
  if(result.status !== 0){
    throw new Error(label + " failed (" + result.status + ")\n" + (result.stderr || result.stdout || ""));
  }
  return result;
}

function probe(ffprobePath, filePath){
  const result = run(ffprobePath, [
    "-v", "error", "-show_streams", "-show_format", "-of", "json", filePath,
  ], "ffprobe");
  return JSON.parse(result.stdout);
}

function sha256(filePath){
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function listControllerTempRoots(){
  return new Set(fs.readdirSync(os.tmpdir(), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith("workflow-showcase-intro-") &&
      !entry.name.startsWith(TEMP_PREFIX))
    .map(entry => entry.name));
}

function removeOwnTempRoot(root){
  const resolved = path.resolve(root);
  const tempBase = path.resolve(os.tmpdir());
  const relative = path.relative(tempBase, resolved);
  if(!relative || relative.startsWith("..") || path.isAbsolute(relative) ||
    !path.basename(resolved).startsWith(TEMP_PREFIX)){
    throw new Error("Refusing to remove an unowned INTRO smoke directory: " + resolved);
  }
  if(fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}

class FakeBrowserWindow {
  constructor(options){
    assert.equal(options?.width, WIDTH);
    assert.equal(options?.height, HEIGHT);
    assert.equal(options?.webPreferences?.sandbox, true);
    this.destroyed = false;
    this.loadedFile = null;
    this.config = null;
    this.currentTime = 0;
    this.webContents = {
      setAudioMuted: value => assert.equal(value, true),
      setFrameRate: value => assert.equal(value, FPS),
      setWindowOpenHandler: handler => assert.deepEqual(handler(), { action: "deny" }),
      on: (eventName, handler) => {
        assert.equal(eventName, "will-navigate");
        assert.equal(typeof handler, "function");
      },
      executeJavaScript: source => this.execute(source),
      capturePage: async () => ({
        getSize: () => ({ width: WIDTH, height: HEIGHT }),
        toBitmap: () => FRAME,
      }),
    };
  }

  async loadFile(filePath){
    assert.equal(path.resolve(filePath), path.join(APP_ROOT, "src", "intro-preroll.html"));
    this.loadedFile = filePath;
  }

  async execute(source){
    assert.ok(this.loadedFile, "INTRO scene must be loaded before JavaScript runs");
    const configurePrefix = "window.introPreroll.configure(";
    const renderPrefix = "window.introPreroll.renderAt(";
    if(source.startsWith(configurePrefix) && source.endsWith(")")){
      this.config = JSON.parse(source.slice(configurePrefix.length, -1));
      assert.equal(this.config.audioEnabled, false);
      assert.match(this.config.backgroundImage, /^file:/);
      assert.match(this.config.backgroundSharpImage, /^file:/);
      return true;
    }
    if(source === "window.introPreroll.getTimeline()"){
      assert.ok(this.config, "INTRO scene must be configured before reading its timeline");
      return { ...TIMELINE };
    }
    if(source.startsWith(renderPrefix) && source.endsWith(")")){
      this.currentTime = Number(JSON.parse(source.slice(renderPrefix.length, -1)));
      assert.ok(Number.isFinite(this.currentTime));
      return true;
    }
    throw new Error("Unexpected INTRO scene JavaScript: " + source);
  }

  isDestroyed(){ return this.destroyed; }
  destroy(){ this.destroyed = true; }
}

function assertOutput(metadata, result){
  const video = metadata.streams.find(stream => stream.codec_type === "video");
  const audio = metadata.streams.find(stream => stream.codec_type === "audio");
  assert.ok(video, "final demo must contain video");
  assert.equal(video.codec_name, "h264");
  assert.equal(Number(video.width), WIDTH);
  assert.equal(Number(video.height), HEIGHT);
  assert.equal(video.pix_fmt, "yuv420p");
  // MPEG-TS concat/remux may rewrite avg/r rate fields; the deterministic fixture still proves frame preservation.
  assert.equal(Number(video.nb_frames), Math.ceil(TIMELINE.end * FPS) + Math.round(MAIN_DURATION * FPS));
  assert.ok(audio, "final demo must contain normalized audio");
  assert.equal(audio.codec_name, "aac");
  assert.equal(Number(audio.sample_rate), 48000);
  assert.equal(Number(audio.channels), 2);
  const duration = Number(metadata.format.duration);
  assert.ok(Math.abs(duration - result.durationSeconds) <= 0.05,
    "reported and probed durations must agree");
  assert.ok(Math.abs(duration - (TIMELINE.end + MAIN_DURATION)) <= 0.2,
    "final duration must contain the intro followed by the main Export");
}

async function main(){
  const ffmpegPath = resolveTool("ffmpeg");
  const ffprobePath = resolveTool("ffprobe");
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  const controllerTempsBefore = listControllerTempRoots();
  let controller = null;
  try{
    const outputRoot = path.join(smokeRoot, "output");
    fs.mkdirSync(outputRoot);
    const logsRoot = path.join(smokeRoot, "logs");
    fs.mkdirSync(logsRoot);
    const sourceRecordPath = path.join(logsRoot, "last-showcase-export.json");
    const mainPath = path.join(outputRoot, "workflow_showcase_export_20260719_120000.mp4");
    run(ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "warning",
      "-f", "lavfi", "-i", "color=c=0x24415c:s=1280x1080:r=24:d=" + MAIN_DURATION,
      "-frames:v", String(Math.round(FPS * MAIN_DURATION)),
      "-c:v", "libx264", "-preset", "ultrafast", "-profile:v", "high",
      "-pix_fmt", "yuv420p", "-r", String(FPS), "-an", "-movflags", "+faststart",
      mainPath,
    ], "main fixture generation");
    const sourceHash = sha256(mainPath);
    const progress = [];
    const events = [];
    const sender = {
      isDestroyed: () => false,
      send: (channel, payload) => {
        assert.equal(channel, "intro:progress");
        progress.push(payload);
      },
    };
    controller = createIntroDemoController({
      BrowserWindow: FakeBrowserWindow,
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      appRoot: APP_ROOT,
      outputRoot,
      sourceRecordPath,
      logEvent: (event, detail) => events.push({ event, detail }),
    });
    const selected = controller.recordCompletedExport(mainPath, "job-smoke");
    assert.equal(selected.ready, true);
    assert.equal(selected.fps, FPS);
    assert.ok(fs.existsSync(sourceRecordPath));
    assert.ok(events.some(item => item.event === "intro_source_recorded"));
    const result = await controller.start(sender, {
      settings: { prompt: "Build the smoke.", reply: "Running now.", typingSeconds: 1 },
      outputSpec: {
        width: WIDTH,
        height: HEIGHT,
        fps: FPS,
        bitrateMbps: 1,
        codec: "h264",
        outputPixelFormat: "yuv420p",
      },
    });
    assert.equal(result.ok, true);
    assert.equal(controller.isRunning(), false);
    assert.ok(fs.existsSync(result.outputPath));
    assert.equal(sha256(mainPath), sourceHash, "INTRO build must not modify its source Export");
    assertOutput(probe(ffprobePath, result.outputPath), result);
    assert.ok(progress.some(item => item.state === "complete" && item.progress === 1));
    assert.ok(events.some(item => item.event === "intro_build_completed"));
    assert.deepEqual(fs.readdirSync(outputRoot).filter(name => name.endsWith(".part.mp4")), []);

    const outputsBeforeCancel = fs.readdirSync(outputRoot).filter(name => name.endsWith(".mp4")).sort();
    const cancelledBuild = controller.start(sender, {
      settings: { prompt: "Cancel this smoke.", reply: "Cancelled.", typingSeconds: 1 },
      outputSpec: { width: WIDTH, height: HEIGHT, fps: FPS, bitrateMbps: 1 },
    });
    assert.equal(controller.cancel(), true);
    const cancelledResult = await cancelledBuild;
    assert.deepEqual(cancelledResult, { ok: false, cancelled: true });
    assert.equal(controller.isRunning(), false);
    assert.equal(sha256(mainPath), sourceHash, "cancelled INTRO build must not modify its source Export");
    assert.deepEqual(
      fs.readdirSync(outputRoot).filter(name => name.endsWith(".mp4")).sort(),
      outputsBeforeCancel,
      "cancelled INTRO build must not publish another output"
    );
    assert.deepEqual(fs.readdirSync(outputRoot).filter(name => name.endsWith(".part.mp4")), []);
    assert.ok(events.some(item => item.event === "intro_build_cancelled"));
    controller.dispose();
    controller = null;

    controller = createIntroDemoController({
      BrowserWindow: FakeBrowserWindow,
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      appRoot: APP_ROOT,
      outputRoot,
      sourceRecordPath,
      logEvent: (event, detail) => events.push({ event, detail }),
    });
    const restored = await controller.getSummary({
      jobId: "job-smoke",
      revision: 1,
      settings: { prompt: "Build the smoke.", reply: "Running now.", typingSeconds: 1 },
      outputSpec: { width: WIDTH, height: HEIGHT, fps: FPS, bitrateMbps: 1 },
    });
    assert.equal(restored.source?.ready, true);
    assert.equal(restored.source?.name, path.basename(mainPath));
    assert.ok(events.some(item => item.event === "intro_source_restored"));
    controller.dispose();
    controller = null;

    controller = createIntroDemoController({
      BrowserWindow: FakeBrowserWindow,
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      appRoot: APP_ROOT,
      outputRoot,
      sourceRecordPath,
      logEvent: (event, detail) => events.push({ event, detail }),
    });
    const mismatchedJob = await controller.getSummary({
      jobId: "job-other",
      revision: 1,
      settings: { prompt: "Different Job.", reply: "No inherited source.", typingSeconds: 1 },
      outputSpec: { width: WIDTH, height: HEIGHT, fps: FPS, bitrateMbps: 1 },
    });
    assert.equal(mismatchedJob.source, null, "another Job must not inherit the recorded Showcase Export");
    controller.dispose();
    controller = null;

    const controllerTempsAfter = listControllerTempRoots();
    assert.deepEqual(
      [...controllerTempsAfter].filter(name => !controllerTempsBefore.has(name)),
      [],
      "INTRO controller must clean every temp directory created by the smoke"
    );
    console.log("INTRO_PIPELINE_SMOKE_OK");
  }finally{
    if(controller) controller.dispose();
    removeOwnTempRoot(smokeRoot);
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
