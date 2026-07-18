"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function tailText(current, chunk, limit = 4000){
  return (current + String(chunk || "")).slice(-limit);
}

function assertSecondarySmoke(result){
  if(!result.error && result.status === 0 && String(result.stdout || "").includes("SINGLE_INSTANCE_REJECTED")) return true;
  throw new Error("Single-instance smoke failed: " + JSON.stringify({
    status: result.status,
    error: result.error?.message || null,
    stdout: String(result.stdout || "").slice(-500),
    stderr: String(result.stderr || "").slice(-500),
  }));
}

function runSecondarySmoke(appRoot, { timeoutMs = 10000 } = {}){
  return new Promise(resolve => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    let killGraceTimer = null;
    let timeoutError = null;
    let child = null;
    const finish = result => {
      if(settled) return;
      settled = true;
      if(timer) clearTimeout(timer);
      if(killGraceTimer) clearTimeout(killGraceTimer);
      resolve({ ...result, stdout, stderr });
    };
    try{
      // RED ZONE: keep the primary event loop alive so Electron can reject the secondary instance.
      child = spawn(process.execPath, [appRoot, "--smoke-test"], {
        cwd: appRoot,
        env: process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }catch(error){
      finish({ status: null, error });
      return;
    }
    child.stdout?.on("data", chunk => { stdout = tailText(stdout, chunk); });
    child.stderr?.on("data", chunk => { stderr = tailText(stderr, chunk); });
    child.once("error", error => finish({ status: null, error }));
    child.once("close", status => finish({ status, error: timeoutError }));
    timer = setTimeout(() => {
      timeoutError = new Error("Secondary instance timed out after " + timeoutMs + "ms");
      try{
        if(child.exitCode == null && !child.killed) child.kill();
      }catch{}
      // Let Windows release the child handles before the outer smoke runner removes its temp root.
      killGraceTimer = setTimeout(() => finish({ status: null, error: timeoutError }), 1500);
    }, timeoutMs);
  });
}

function attachSmokeHarness({
  window,
  app,
  appRoot,
  outputRoot,
  loadJob,
  logEvent,
  exportController,
  BrowserWindow,
  smokeTest,
  exportSmoke,
}){
  if(smokeTest){
    window.webContents.once("did-finish-load", async () => {
      try{
        assertSecondarySmoke(await runSecondarySmoke(appRoot));
        await new Promise(resolve => setTimeout(resolve, 1200));
        const starterJob = loadJob();
        const starterDemo = {
          enabled: starterJob.demo === true,
          hasXml: starterJob.xml?.relativePath === "source/timeline.xml",
          hasVideo: starterJob.video?.relativePath === "source/video.mp4",
          title: starterJob.projectTitle,
        };
        if(!starterDemo.enabled || !starterDemo.hasXml || !starterDemo.hasVideo || starterDemo.title !== "SYNTHETIC TIMELINE"){
          throw new Error("Bundled starter demo contract failed: " + JSON.stringify(starterDemo));
        }
        const smokeXmlPath = process.env.PORTABLE_SMOKE_XML;
        if(smokeXmlPath && fs.existsSync(smokeXmlPath)){
          const xmlText = fs.readFileSync(smokeXmlPath, "utf8");
          const parsed = await window.webContents.executeJavaScript(
            `window.portableMvp.loadXmlText(${JSON.stringify(xmlText)})`
          );
          if(parsed?.fps!==24||parsed?.durationFrames!==312||parsed?.edits!==5||parsed?.shots!==4){
            throw new Error("Public fixture contract changed: "+JSON.stringify(parsed));
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        await window.webContents.executeJavaScript('document.getElementById("calloutSettings").setAttribute("open", "")');
        const result = await window.webContents.executeJavaScript(`({
          title: document.title,
          hasApi: Boolean(window.portableApi),
          hasWireframe: Boolean(window.wireframeApi),
          hasPreview: Boolean(document.getElementById("renderPreview")?.contentWindow?.portablePreview),
          shotRail: Boolean(document.getElementById("shotRail")),
          editOverlay: Boolean(document.getElementById("editOverlay")),
          calloutSettingsOpen: document.getElementById("calloutSettings")?.open,
          calloutMotions: [...document.getElementById("calloutMotion")?.options||[]].map(option=>option.value),
          calloutStyles: [...document.getElementById("calloutStyle")?.options||[]].map(option=>option.value),
          editNumberTicker: document.getElementById("editNumberTicker")?.checked,
          editDisplayOptions: [...document.querySelectorAll("#editDisplaySettings input")].map(control=>control.id),
          previewState: document.getElementById("renderPreview")?.contentWindow?.portablePreview?.getState(),
          shotItems: document.querySelectorAll("#shotRailList .shotRailItem").length,
          editStatus: document.getElementById("editCountStatus")?.textContent,
          jobName: document.getElementById("jobName")?.textContent
        })`);
        if(!result.hasApi || !result.hasWireframe || !result.hasPreview || !result.shotRail || !result.editOverlay || !result.calloutSettingsOpen){
          throw new Error("Smoke contract failed: " + JSON.stringify(result));
        }
        if(result.calloutMotions.includes("snap") || !result.calloutMotions.includes("decode") ||
            !result.calloutStyles.includes("viewfinder") || result.editNumberTicker !== false ||
            result.editDisplayOptions.join(",")!=="editNumberTicker,referencePop3d"){
          throw new Error("Callout/Edit display options failed: " + JSON.stringify(result));
        }
        result.calloutMotionContract = await window.webContents.executeJavaScript(`(()=>{
          const frame=document.getElementById("renderPreview");
          const bridge=frame.contentWindow.portablePreview;
          const previewDocument=frame.contentDocument;
          const decodePool=frame.contentWindow.resolveDecodeGlyphPool();
          bridge.setProjectTitle(decodePool);
          bridge.setCalloutConfig({enabled:true,position:"left",style:"viewfinder",motion:"decode",startSeconds:0,durationSeconds:3.5,subtitle:"SMOKE"});
          bridge.seekFrame(Math.round(.45*bridge.getState().fps));
          const first=previewDocument.getElementById("videoCalloutTitle").textContent;
          bridge.seekFrame(Math.round(.45*bridge.getState().fps));
          const second=previewDocument.getElementById("videoCalloutTitle").textContent;
          const glyphCount=previewDocument.querySelectorAll("#videoCalloutTitle .decodeGlyph").length;
          const allowedGlyphs=new Set(Array.from("<>/|=+*#%█▓▒░").concat(String.fromCharCode(92)));
          const glyphPoolValid=decodePool.length>0&&!/\d/.test(decodePool)&&Array.from(decodePool).every(glyph=>allowedGlyphs.has(glyph));
          const scrambled=previewDocument.querySelector("#videoCalloutTitle .decodeGlyph.scrambled");
          const decoded=previewDocument.querySelector("#videoCalloutTitle .decodeGlyph:not(.scrambled)");
          const scrambledStyle=scrambled?getComputedStyle(scrambled):null;
          const decodedStyle=decoded?getComputedStyle(decoded):null;
          const decodeStyleSeparated=Boolean(scrambledStyle&&decodedStyle&&
            scrambledStyle.fontFamily!==decodedStyle.fontFamily&&scrambledStyle.color===decodedStyle.color&&
            scrambledStyle.opacity==="1"&&scrambledStyle.textAlign==="left");
          const viewfinderVisible=getComputedStyle(previewDocument.querySelector(".videoCalloutViewfinder")).display!=="none";
          const tickerEnabled=bridge.setEditDisplayConfig({numberTicker:true}).numberTicker===true;
          const tickerDisabled=bridge.setEditDisplayConfig({numberTicker:false}).numberTicker===false;
          return {deterministic:first===second,glyphCount,decodePool,glyphPoolValid,decodeStyleSeparated,viewfinderVisible,
            editDisplayApi:tickerEnabled&&tickerDisabled};
        })()`);
        if(!result.calloutMotionContract.deterministic || !result.calloutMotionContract.glyphCount ||
            !result.calloutMotionContract.glyphPoolValid || !result.calloutMotionContract.decodeStyleSeparated ||
            !result.calloutMotionContract.viewfinderVisible || !result.calloutMotionContract.editDisplayApi){
          throw new Error("Callout motion smoke failed: " + JSON.stringify(result.calloutMotionContract));
        }
        if(!String(result.jobName || "").startsWith("SAMPLE JOB / ")){
          throw new Error("Starter demo label is missing: " + JSON.stringify(result));
        }
        result.starterDemo = starterDemo;
        await window.webContents.executeJavaScript("window.portableApi.openExportDialog({durationSeconds:12,sourceFps:24,editCount:5})");
        let exportDialogWindow = null;
        let exportDialogApiReady = false;
        for(let attempt = 0; attempt < 30 && !exportDialogApiReady; attempt += 1){
          exportDialogWindow = BrowserWindow.getAllWindows().find(candidate => (
            candidate !== window && !candidate.isDestroyed() && candidate.getParentWindow() === window
          )) || null;
          if(exportDialogWindow){
            try{
              exportDialogApiReady = await exportDialogWindow.webContents.executeJavaScript("Boolean(window.exportDialogApi)");
            }catch{}
          }
          if(!exportDialogApiReady) await new Promise(resolve => setTimeout(resolve, 100));
        }
        const exportPreferences = exportDialogWindow?.webContents.getLastWebPreferences?.() || {};
        if(!exportDialogApiReady || exportPreferences.sandbox !== true){
          throw new Error("Sandboxed Export dialog preload failed: " + JSON.stringify({
            apiReady: exportDialogApiReady,
            sandbox: exportPreferences.sandbox,
          }));
        }
        await exportDialogWindow.webContents.executeJavaScript("void window.exportDialogApi.closeDialog(); true");
        result.exportDialogSandbox = { apiReady: true, sandbox: true };
        if(process.env.PORTABLE_SMOKE_XML && (!result.shotItems || result.editStatus==="0 EDITS")){
          throw new Error("XML did not reach the parent SHOT rail: " + JSON.stringify(result));
        }
        const smokeVideoPath = process.env.PORTABLE_SMOKE_VIDEO;
        const smokeInvalidVideoPath = process.env.PORTABLE_SMOKE_INVALID_VIDEO;
        if(smokeVideoPath && smokeInvalidVideoPath){
          const videoPreflight = await window.webContents.executeJavaScript(`(async()=>{
            const api=window.portableApi;
            const preview=document.getElementById("renderPreview").contentWindow.portablePreview;
            const before=await api.getJob();
            const good=await api.prepareDroppedVideo(${JSON.stringify(smokeVideoPath)});
            const metadata=await preview.preflightVideo(good.candidateUrl,10000);
            await api.discardPreparedVideo(good.token,"smoke-preflight-passed");
            const bad=await api.prepareDroppedVideo(${JSON.stringify(smokeInvalidVideoPath)});
            let rejected=false;
            try{await preview.preflightVideo(bad.candidateUrl,5000)}catch(error){rejected=true}
            await api.discardPreparedVideo(bad.token,"smoke-preflight-failed");
            const after=await api.getJob();
            return {
              valid:metadata.readyState>=2&&metadata.width>0&&metadata.height>0,
              invalidRejected:rejected,
              jobUnchanged:before.jobId===after.jobId&&before.revision===after.revision,
            };
          })()`);
          if(!videoPreflight.valid || !videoPreflight.invalidRejected || !videoPreflight.jobUnchanged){
            throw new Error("Video preflight smoke failed: "+JSON.stringify(videoPreflight));
          }
          result.videoPreflight=videoPreflight;
        }
        result.singleInstance=true;
        const job = loadJob();
        if(job.xml?.relativePath && job.video?.relativePath){
          const playback = await window.webContents.executeJavaScript(`(async()=>{
            const bridge=document.getElementById("renderPreview").contentWindow.portablePreview;
            for(let attempt=0;attempt<30&&bridge.getState().readyState<1;attempt+=1){
              await new Promise(resolve=>setTimeout(resolve,100));
            }
            const items=document.querySelectorAll("#shotRailList .shotRailItem");
            (items[1]||items[0])?.click();
            await new Promise(resolve=>setTimeout(resolve,150));
            const sought=bridge.getState();
            bridge.playPause();
            await new Promise(resolve=>setTimeout(resolve,600));
            const playing=bridge.getState();
            const expectedPlayingSeek=window.wireframeApi.snapshot().shots[2]?.start||0;
            (items[2]||items[1]||items[0])?.click();
            await new Promise(resolve=>setTimeout(resolve,500));
            const playingSeek=bridge.getState();
            bridge.playPause();
            const shots=window.wireframeApi.snapshot().shots;
            const crossingStart=Math.max(0,(shots[1]?.end||0)-.1);
            bridge.seekFrame(crossingStart*bridge.getState().fps);
            document.activeElement?.blur?.();
            document.body.dispatchEvent(new KeyboardEvent("keydown",{key:" ",code:"Space",bubbles:true,cancelable:true}));
            await new Promise(resolve=>setTimeout(resolve,500));
            const shortcutPlaying=bridge.getState();
            const syncedShot=document.querySelector("#shotRailList .shotRailItem.selected")?.dataset.shot||null;
            document.body.dispatchEvent(new KeyboardEvent("keyup",{key:" ",code:"Space",bubbles:true,cancelable:true}));
            document.body.dispatchEvent(new KeyboardEvent("keydown",{key:" ",code:"Space",bubbles:true,cancelable:true}));
            return {sought,playing,playingSeek,expectedPlayingSeek,shortcutPlaying,syncedShot,expectedSyncedShot:String(shots[2]?.id||"")};
          })()`);
          if(playback.sought.readyState<1 || playback.sought.currentTime<.5){
            throw new Error("SHOT seek failed: " + JSON.stringify(playback));
          }
          if(playback.playing.paused || playback.playing.currentTime<=playback.sought.currentTime+.1){
            throw new Error("Video playback failed: " + JSON.stringify(playback));
          }
          if(playback.playingSeek.paused || Math.abs(playback.playingSeek.currentTime-playback.expectedPlayingSeek)>.9){
            throw new Error("Playing SHOT seek drifted: " + JSON.stringify(playback));
          }
          if(playback.shortcutPlaying.paused || playback.syncedShot!==playback.expectedSyncedShot){
            throw new Error("Space shortcut or SHOT follow failed: " + JSON.stringify(playback));
          }
          result.playback=playback;
        }
        await window.webContents.executeJavaScript(`(()=>{
          const bridge=document.getElementById("renderPreview").contentWindow.portablePreview;
          bridge.setCalloutConfig({enabled:true,position:"left",style:"line",startSeconds:.08,durationSeconds:30,subtitle:"WORKFLOW SHOWCASE · EDIT WORKFLOW"});
          bridge.seekFrame(2*bridge.getState().fps);
        })()`);
        await new Promise(resolve => setTimeout(resolve, 180));
        const image = await window.webContents.capturePage();
        fs.writeFileSync(path.join(outputRoot, "mvp-smoke.png"), image.toPNG());
        if(smokeXmlPath && fs.existsSync(smokeXmlPath)){
          const demoReplacement = await window.webContents.executeJavaScript(`(async()=>{
            const api=window.portableApi;
            const preview=document.getElementById("renderPreview").contentWindow.portablePreview;
            const before=await api.getJob();
            const prepared=await api.prepareDroppedXml(${JSON.stringify(smokeXmlPath)});
            const candidate=preview.inspectXml(prepared.text);
            const mode=await api.chooseXmlImportMode(prepared.token);
            await preview.releaseMedia({references:true});
            const result=await api.commitXmlImport({
              token:prepared.token,
              expectedJobId:before.jobId,
              expectedRevision:before.revision,
              previousTimelineShots:[],
              nextTimelineShots:candidate.shots,
            });
            return {
              mode,
              previousJobId:before.jobId,
              nextJobId:result.job.jobId,
              demo:result.job.demo===true,
              video:result.job.video,
            };
          })()`);
          if(demoReplacement.mode!=="new" || demoReplacement.demo || demoReplacement.video!==null ||
              demoReplacement.previousJobId===demoReplacement.nextJobId){
            throw new Error("Starter demo replacement contract failed: "+JSON.stringify(demoReplacement));
          }
          result.demoReplacement=demoReplacement;
        }
        const smokeReferencePath = process.env.PORTABLE_SMOKE_REFERENCE;
        if(smokeReferencePath && fs.existsSync(smokeReferencePath)){
          const referenceImport = await window.webContents.executeJavaScript(`(async()=>{
            const api=window.portableApi;
            const before=await api.getJob();
            const after=await api.addDroppedReferences([${JSON.stringify(smokeReferencePath)}],before.jobId,before.revision);
            const added=after.references[after.references.length-1];
            return {
              beforeCount:before.references.length,
              afterCount:after.references.length,
              revisionAdvanced:after.revision>before.revision,
              relativePath:added?.relativePath||null,
            };
          })()`);
          const importedPath = referenceImport.relativePath
            ? path.join(process.env.PORTABLE_TEST_JOB_ROOT, referenceImport.relativePath)
            : null;
          if(referenceImport.afterCount!==referenceImport.beforeCount+1 || !referenceImport.revisionAdvanced ||
              !importedPath || !fs.existsSync(importedPath)){
            throw new Error("Reference streaming import smoke failed: "+JSON.stringify(referenceImport));
          }
          result.referenceImport=referenceImport;
        }
        logEvent("smoke_passed", result);
        console.log("SMOKE_OK " + JSON.stringify(result));
        app.exit(0);
      }catch(error){
        logEvent("smoke_failed", { message: error.message });
        console.error("SMOKE_FAILED " + error.stack);
        app.exit(1);
      }
    });
  }
  if(exportSmoke){
    window.webContents.once("did-finish-load", async () => {
      try{
        const result = await exportController.start(window.webContents, loadJob());
        console.log("EXPORT_SMOKE_OK " + JSON.stringify(result));
        app.exit(0);
      }catch(error){
        console.error("EXPORT_SMOKE_FAILED " + error.stack);
        app.exit(1);
      }
    });
  }
}

module.exports = { attachSmokeHarness, runSecondarySmoke, assertSecondarySmoke, tailText };
