"use strict";

(() => {
  const api = window.exportDialogApi;
  const $ = id => document.getElementById(id);
  let summary = null;
  let running = false;
  let completed = false;
  let startedAt = 0;
  let latestProgress = 0;
  let dialogLanguage = "en";

  const DIALOG_STRINGS = {
    en: {
      lead: "Confirm the title and output info before starting the render.",
      idle: "Press START EXPORT to begin rendering.",
      not_ready: "Load the XML and the source video first.",
      preparing: "Preparing the render surface and the encoder.",
      fallback: "The NVIDIA encoder is unavailable; restarting with CPU rendering.",
      finalizing: "Finalizing the MP4 file.",
      failed: "Rendering failed.",
      complete: "Rendering is complete.",
      cancelled: "Rendering was cancelled.",
      cancelling: "Stopping the render and cleaning up temporary files.",
      bitrate_saved: mbps => "Saved the bitrate as " + mbps + " Mbps.",
    },
    ko: {
      lead: "렌더링을 시작하기 전에 제목과 출력 정보를 확인하세요.",
      idle: "START EXPORT를 누르면 렌더링을 시작합니다.",
      not_ready: "XML과 완성본 영상을 먼저 불러와야 합니다.",
      preparing: "렌더링 화면과 인코더를 준비하고 있습니다.",
      fallback: "NVIDIA 인코더를 사용할 수 없어 CPU 렌더링으로 다시 시작합니다.",
      finalizing: "MP4 파일을 마무리하고 있습니다.",
      failed: "렌더링에 실패했습니다.",
      complete: "렌더링이 완료되었습니다.",
      cancelled: "렌더링을 취소했습니다.",
      cancelling: "렌더링을 중단하고 임시 파일을 정리하고 있습니다.",
      bitrate_saved: mbps => "비트레이트를 " + mbps + " Mbps로 저장했습니다.",
    },
  };
  const msg = key => {
    const dict = DIALOG_STRINGS[dialogLanguage] || DIALOG_STRINGS.en;
    return dict[key] ?? DIALOG_STRINGS.en[key] ?? key;
  };

  function clock(seconds){
    if(!Number.isFinite(seconds) || seconds < 0) return "--:--";
    const total = Math.round(seconds);
    const minutes = Math.floor(total / 60);
    return String(minutes).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
  }

  function renderSummary(next){
    summary = next;
    dialogLanguage = next.language === "ko" ? "ko" : "en";
    $("leadText").textContent = msg("lead");
    $("projectTitle").value = next.projectTitle ?? "UNTITLED PROJECT";
    updateTitleCount();
    $("formatValue").textContent = next.format;
    $("frameValue").textContent = next.width + " × " + next.height + " · " + next.outputFps + " FPS";
    $("bitrateSelect").value = String(next.bitrateMbps);
    $("durationValue").textContent = next.durationSeconds
      ? clock(next.durationSeconds) + " · " + next.totalFrames.toLocaleString() + " FRAMES"
      : "CALCULATED ON START";
    $("sourceValue").textContent = (next.sourceFps ? next.sourceFps + " FPS · " : "") + next.videoName;
    $("folderValue").textContent = next.outputFolder;
    $("frameProgress").textContent = "0 / " + (next.totalFrames || 0).toLocaleString() + " FRAMES";
    $("startButton").disabled = !next.ready;
    if(!next.ready){
      $("stateValue").textContent = "NOT READY";
      setMessage(next.readyMessage || msg("not_ready"), true);
    }else{
      $("stateValue").textContent = "READY";
      setMessage(msg("idle"));
    }
  }

  function updateTitleCount(){
    $("titleCount").textContent = "EDIT PANEL";
  }

  function setMessage(message, isError = false){
    $("message").textContent = message;
    $("message").classList.toggle("error", isError);
  }

  function setProgress(payload){
    const progress = Math.max(0, Math.min(1, Number(payload?.progress) || 0));
    latestProgress = progress;
    const percent = Math.round(progress * 100);
    const states = {
      preparing: "PREPARING",
      recording: "RENDERING",
      fallback: "CPU FALLBACK",
      finalizing: "FINALIZING",
      complete: "COMPLETE",
      cancelled: "CANCELLED",
      error: "FAILED",
    };
    $("stateValue").textContent = states[payload?.state] || "READY";
    $("percentValue").textContent = percent + "%";
    $("progressFill").style.width = percent + "%";
    const frame = Number(payload?.frame) || Math.round((summary?.totalFrames || 0) * progress);
    const total = Number(payload?.totalFrames) || summary?.totalFrames || 0;
    $("frameProgress").textContent = frame.toLocaleString() + " / " + total.toLocaleString() + " FRAMES";
    const elapsed = startedAt ? (Date.now() - startedAt) / 1000 : 0;
    const remaining = progress > .02 && progress < 1 ? elapsed * (1 - progress) / progress : NaN;
    $("timeProgress").textContent = clock(elapsed) + " · " + clock(remaining) + " LEFT";
    if(payload?.state === "fallback") setMessage(msg("fallback"));
    if(payload?.state === "finalizing") setMessage(msg("finalizing"));
    if(payload?.state === "error") setMessage(payload.message || msg("failed"), true);
  }

  function setRunning(next){
    running = next;
    $("projectTitle").disabled = next;
    $("bitrateSelect").disabled = next;
    $("startButton").disabled = next || !summary?.ready;
    $("cancelButton").textContent = next ? "CANCEL EXPORT" : "CANCEL";
  }

  async function changeBitrate(event){
    const previous = String(summary?.bitrateMbps || 12);
    if(running){ event.target.value = previous; return; }
    try{
      const next = await api.setBitrate(Number(event.target.value), summary?.jobId, summary?.revision);
      renderSummary(next);
      setMessage(msg("bitrate_saved")(next.bitrateMbps));
    }catch(error){
      event.target.value = previous;
      setMessage(error.message, true);
    }
  }

  function showComplete(result){
    completed = true;
    setRunning(false);
    setProgress({ state: "complete", progress: 1, frame: result.totalFrames, totalFrames: result.totalFrames });
    setMessage(msg("complete"));
    $("outputPath").textContent = result.outputPath;
    $("outputPath").classList.add("visible");
    $("startButton").style.display = "none";
    $("cancelButton").textContent = "CLOSE";
    $("openFolderButton").classList.add("visible");
  }

  async function startExport(){
    if(running) return;
    const projectTitle = $("projectTitle").value.replace(/\s+/g, " ").trim();
    completed = false;
    startedAt = Date.now();
    latestProgress = 0;
    $("outputPath").classList.remove("visible");
    $("openFolderButton").classList.remove("visible");
    $("startButton").textContent = "START EXPORT";
    setRunning(true);
    setProgress({ state: "preparing", progress: 0 });
    setMessage(msg("preparing"));
    try{
      const result = await api.startExport(projectTitle, summary?.jobId, summary?.revision);
      if(result?.cancelled){
        setRunning(false);
        setProgress({ state: "cancelled", progress: 0 });
        setMessage(msg("cancelled"));
      }else if(result?.ok) showComplete(result);
    }catch(error){
      setRunning(false);
      setProgress({ state: "error", progress: latestProgress, message: error.message });
      $("startButton").textContent = "RETRY";
    }
  }

  async function cancelOrClose(){
    if(running){
      $("cancelButton").disabled = true;
      setMessage(msg("cancelling"));
      await api.cancelExport();
      $("cancelButton").disabled = false;
      return;
    }
    await api.closeDialog();
  }

  $("startButton").addEventListener("click", startExport);
  $("bitrateSelect").addEventListener("change", changeBitrate);
  $("cancelButton").addEventListener("click", cancelOrClose);
  $("openFolderButton").addEventListener("click", () => api.openOutput());
  api.onProgress(setProgress);
  api.onSummaryUpdated(next => { if(!running) renderSummary(next) });
  api.getSummary().then(renderSummary).catch(error => setMessage(error.message, true));
})();
