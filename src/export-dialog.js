"use strict";

(() => {
  const api = window.exportDialogApi;
  const $ = id => document.getElementById(id);
  let summary = null;
  let running = false;
  let completed = false;
  let startedAt = 0;
  let latestProgress = 0;

  function clock(seconds){
    if(!Number.isFinite(seconds) || seconds < 0) return "--:--";
    const total = Math.round(seconds);
    const minutes = Math.floor(total / 60);
    return String(minutes).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
  }

  function renderSummary(next){
    summary = next;
    $("projectTitle").value = next.projectTitle ?? "SEEDANCE 2.0";
    updateTitleCount();
    $("formatValue").textContent = next.format;
    $("frameValue").textContent = next.width + " × " + next.height + " · " + next.outputFps + " FPS";
    $("bitrateValue").textContent = next.bitrateMbps + " Mbps CBR";
    $("durationValue").textContent = next.durationSeconds
      ? clock(next.durationSeconds) + " · " + next.totalFrames.toLocaleString() + " FRAMES"
      : "CALCULATED ON START";
    $("sourceValue").textContent = (next.sourceFps ? next.sourceFps + " FPS · " : "") + next.videoName;
    $("folderValue").textContent = next.outputFolder;
    $("frameProgress").textContent = "0 / " + (next.totalFrames || 0).toLocaleString() + " FRAMES";
    $("startButton").disabled = !next.ready;
    if(!next.ready){
      $("stateValue").textContent = "NOT READY";
      setMessage("XML과 완성본 영상을 먼저 불러와야 합니다.", true);
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
    if(payload?.state === "fallback") setMessage("NVIDIA 인코더를 사용할 수 없어 CPU 렌더링으로 다시 시작합니다.");
    if(payload?.state === "finalizing") setMessage("MP4 파일을 마무리하고 있습니다.");
    if(payload?.state === "error") setMessage(payload.message || "렌더링에 실패했습니다.", true);
  }

  function setRunning(next){
    running = next;
    $("projectTitle").disabled = next;
    $("startButton").disabled = next || !summary?.ready;
    $("cancelButton").textContent = next ? "CANCEL EXPORT" : "CANCEL";
  }

  function showComplete(result){
    completed = true;
    setRunning(false);
    setProgress({ state: "complete", progress: 1, frame: result.totalFrames, totalFrames: result.totalFrames });
    setMessage("렌더링이 완료되었습니다.");
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
    setMessage("렌더링 화면과 인코더를 준비하고 있습니다.");
    try{
      const result = await api.startExport(projectTitle, summary?.jobId, summary?.revision);
      if(result?.cancelled){
        setRunning(false);
        setProgress({ state: "cancelled", progress: 0 });
        setMessage("렌더링을 취소했습니다.");
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
      setMessage("렌더링을 중단하고 임시 파일을 정리하고 있습니다.");
      await api.cancelExport();
      $("cancelButton").disabled = false;
      return;
    }
    await api.closeDialog();
  }

  $("startButton").addEventListener("click", startExport);
  $("cancelButton").addEventListener("click", cancelOrClose);
  $("openFolderButton").addEventListener("click", () => api.openOutput());
  api.onProgress(setProgress);
  api.onSummaryUpdated(next => { if(!running) renderSummary(next) });
  api.getSummary().then(renderSummary).catch(error => setMessage(error.message, true));
})();
