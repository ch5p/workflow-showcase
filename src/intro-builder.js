"use strict";

(() => {
  const api = window.introBuilderApi;
  const $ = id => document.getElementById(id);
  const DEFAULT_SETTINGS = {
    prompt: "Three rescuers, one moment. Firefighter, swiftwater, paramedic — intercut at their limits. 15s, 24fps.",
    reply: "Understood. Rise from boots to eyes, fragment burst, then the reverse descent to gripping hands. Rolling now.",
    typingSeconds: 1,
    soundEnabled: true,
  };
  const STRINGS = {
    en: {
      lead: "Select a finished export, tune the opening exchange, then build one demo MP4.",
      choose_source: "Choose the finished workflow MP4 that should follow the intro.",
      source_required: "Select an export before building the demo.",
      ready: "The intro is ready. Replay it or build the demo.",
      saving: "Saving the intro settings.",
      saved: "Intro settings saved.",
      save_failed: "The intro settings could not be saved. Try editing once more.",
      job_changed: "The Current Job changed. Its latest intro settings are now loaded.",
      source_cancelled: "Export selection was cancelled.",
      source_failed: "The export could not be selected. Check the app log and try again.",
      preview_failed: "The preview image could not be loaded.",
      preparing: "Preparing the intro and source export.",
      building: "Building the demo MP4.",
      cancelling: "Stopping the build and cleaning up temporary files.",
      cancelled: "The demo build was cancelled.",
      build_failed: "The demo could not be built. Check the app log for details.",
      complete: "The demo MP4 is ready.",
      api_missing: "The Intro Builder bridge is unavailable.",
    },
    ko: {
      lead: "완성된 내보내기 영상을 고르고 인트로 대화를 조정한 다음 데모 MP4를 만드세요.",
      choose_source: "인트로 뒤에 이어질 완성된 워크플로 MP4를 선택하세요.",
      source_required: "데모를 만들기 전에 내보내기 영상을 선택하세요.",
      ready: "인트로가 준비되었습니다. 다시 재생하거나 데모를 만들 수 있습니다.",
      saving: "인트로 설정을 저장하고 있습니다.",
      saved: "인트로 설정을 저장했습니다.",
      save_failed: "인트로 설정을 저장하지 못했습니다. 내용을 한 번 더 수정해 보세요.",
      job_changed: "Current Job이 변경되어 최신 인트로 설정을 불러왔습니다.",
      source_cancelled: "내보내기 영상 선택을 취소했습니다.",
      source_failed: "내보내기 영상을 선택하지 못했습니다. 앱 로그를 확인한 뒤 다시 시도하세요.",
      preview_failed: "미리보기 이미지를 불러오지 못했습니다.",
      preparing: "인트로와 원본 내보내기 영상을 준비하고 있습니다.",
      building: "데모 MP4를 만들고 있습니다.",
      cancelling: "빌드를 중단하고 임시 파일을 정리하고 있습니다.",
      cancelled: "데모 빌드를 취소했습니다.",
      build_failed: "데모를 만들지 못했습니다. 자세한 내용은 앱 로그에서 확인하세요.",
      complete: "데모 MP4가 준비되었습니다.",
      api_missing: "Intro Builder 연결을 사용할 수 없습니다.",
    },
  };
  const PROGRESS_LABELS = {
    preparing: "PREPARING",
    extracting: "EXTRACTING",
    rendering_intro: "RENDERING INTRO",
    normalizing_audio: "NORMALIZING AUDIO",
    converting_intro: "CONVERTING INTRO",
    converting_main: "CONVERTING MAIN",
    concatenating: "CONCATENATING",
    verifying: "VERIFYING",
    finalizing: "FINALIZING",
    complete: "COMPLETE",
    cancelling: "CANCELLING",
    cancelled: "CANCELLED",
    error: "FAILED",
  };

  let summary = null;
  let settings = { ...DEFAULT_SETTINGS };
  let language = "en";
  let running = false;
  let dirty = false;
  let saveTimer = 0;
  let saveQueue = Promise.resolve();
  let savingDepth = 0;
  let previewReady = false;
  let previewGeneration = 0;
  let outputAvailable = false;
  let closing = false;

  const msg = key => (STRINGS[language] || STRINGS.en)[key] || STRINGS.en[key] || key;
  const singleLineText = value => String(value ?? "").replace(/\r\n?|\n/g, " ");
  const normalizeSettings = value => ({
    prompt: typeof value?.prompt === "string" ? singleLineText(value.prompt).slice(0, 500) : DEFAULT_SETTINGS.prompt,
    reply: typeof value?.reply === "string" ? singleLineText(value.reply).slice(0, 500) : DEFAULT_SETTINGS.reply,
    typingSeconds: Number(value?.typingSeconds) === 2 ? 2 : 1,
    soundEnabled: value?.soundEnabled !== false,
  });
  const settingsPayload = () => ({
    prompt: settings.prompt,
    reply: settings.reply,
    typingSeconds: settings.typingSeconds,
    soundEnabled: settings.soundEnabled,
  });
  const sameSettings = (left, right) => left.prompt === right.prompt
    && left.reply === right.reply
    && left.typingSeconds === right.typingSeconds
    && left.soundEnabled === right.soundEnabled;
  const basename = value => {
    if (typeof value !== "string") return "";
    const parts = value.split(/[\\/]/);
    return parts[parts.length - 1] || "";
  };
  const finiteRevision = value => Number.isInteger(Number(value)) ? Number(value) : null;

  function setSaveState(label, state = "") {
    $("saveState").textContent = label;
    $("saveState").className = "saveState" + (state ? " " + state : "");
  }

  function setMessage(message, isError = false) {
    $("buildMessage").textContent = message;
    $("buildMessage").classList.toggle("error", isError);
  }

  function updateCounts() {
    $("promptCount").textContent = String($("promptInput").value.length) + " / 500";
    $("replyCount").textContent = String($("replyInput").value.length) + " / 500";
  }

  function applySettingsToInputs(next) {
    settings = normalizeSettings(next);
    $("promptInput").value = settings.prompt;
    $("replyInput").value = settings.reply;
    const radio = document.querySelector('input[name="typingSeconds"][value="' + settings.typingSeconds + '"]');
    if (radio) radio.checked = true;
    const soundRadio = document.querySelector('input[name="soundEnabled"][value="' + (settings.soundEnabled ? "on" : "off") + '"]');
    if (soundRadio) soundRadio.checked = true;
    updateCounts();
    configurePreview();
  }

  function readSettingsFromInputs() {
    settings = {
      prompt: $("promptInput").value.slice(0, 500),
      reply: $("replyInput").value.slice(0, 500),
      typingSeconds: Number(document.querySelector('input[name="typingSeconds"]:checked')?.value) === 2 ? 2 : 1,
      soundEnabled: document.querySelector('input[name="soundEnabled"]:checked')?.value !== "off",
    };
    updateCounts();
  }

  function preventEditorLineBreak(event) {
    if (event.key === "Enter" || event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
      event.preventDefault();
    }
  }

  function singleLineEditorChanged(event) {
    const input = event.currentTarget;
    const selectionStart = Number.isInteger(input.selectionStart) ? input.selectionStart : input.value.length;
    const normalizedBeforeCaret = singleLineText(input.value.slice(0, selectionStart));
    const normalized = singleLineText(input.value).slice(0, 500);
    if (normalized !== input.value) {
      input.value = normalized;
      const caret = Math.min(normalizedBeforeCaret.length, normalized.length);
      input.setSelectionRange(caret, caret);
    }
    editorChanged();
  }

  function formatDuration(seconds) {
    const value = Number(seconds);
    return Number.isFinite(value) && value > 0 ? value.toFixed(value < 10 ? 2 : 1) + " S" : "--";
  }

  function sourceDescription(source) {
    if (!source?.ready) return msg("choose_source");
    const pieces = [];
    if (source.width && source.height) pieces.push(source.width + " × " + source.height);
    if (source.fps) pieces.push(Number(source.fps).toFixed(Number(source.fps) % 1 ? 2 : 0) + " FPS");
    if (source.durationSeconds) pieces.push(formatDuration(source.durationSeconds));
    if (source.hasAudio === false) pieces.push("NO AUDIO");
    return pieces.join(" · ") || "READY FOR INTRO";
  }

  function updateSource() {
    const source = summary?.source?.ready ? summary.source : null;
    const name = basename(source?.name);
    $("sourceName").textContent = name || "No export selected";
    $("sourceMeta").textContent = sourceDescription(source);
    $("sourceChip").textContent = name || "NO EXPORT SELECTED";
    $("sourceChip").classList.toggle("ready", Boolean(source));
    $("sourceState").textContent = source ? "READY" : "REQUIRED";
  }

  function refreshControls() {
    const ready = Boolean(summary?.source?.ready);
    $("promptInput").disabled = running;
    $("replyInput").disabled = running;
    document.querySelectorAll('input[name="typingSeconds"]').forEach(input => { input.disabled = running; });
    document.querySelectorAll('input[name="soundEnabled"]').forEach(input => { input.disabled = running; });
    $("selectButton").disabled = running;
    $("replayButton").disabled = running || !previewReady;
    $("buildButton").disabled = running || !ready || !summary?.jobId;
    $("cancelButton").disabled = !running;
    $("openOutputButton").disabled = running || !outputAvailable;
    $("closeButton").disabled = running;
  }

  function setRunning(next) {
    running = Boolean(next);
    refreshControls();
  }

  function renderSummary(next, applyRemoteSettings = false) {
    if (!next || typeof next !== "object") return;
    summary = next;
    language = next.language === "ko" ? "ko" : "en";
    $("leadText").textContent = msg("lead");
    if (applyRemoteSettings) {
      dirty = false;
      applySettingsToInputs(next.settings);
      setSaveState("SAVED", "saved");
    } else {
      configurePreview();
    }
    updateSource();
    if (next.building && !running) {
      setRunning(true);
      $("progressState").textContent = "BUILDING";
      setMessage(msg("building"));
    } else {
      refreshControls();
    }
    if (!running) setMessage(next.source?.ready ? msg("ready") : msg("source_required"));
  }

  function sceneApi() {
    return previewReady ? $("sceneFrame").contentWindow?.introPreroll : null;
  }

  async function configurePreview() {
    const scene = sceneApi();
    if (!scene) return;
    const generation = ++previewGeneration;
    const preview = summary?.preview || null;
    try {
      const timeline = await scene.configure({
        prompt: settings.prompt,
        reply: settings.reply,
        typingSeconds: settings.typingSeconds,
        backgroundImage: preview?.blurredUrl || null,
        backgroundSharpImage: preview?.sharpUrl || null,
        questionColor: preview?.questionColor || null,
        questionShadow: preview?.questionShadow || null,
        audioEnabled: settings.soundEnabled,
      });
      if (generation === previewGeneration && timeline?.end) {
        $("durationLabel").textContent = Number(timeline.end).toFixed(2) + " S INTRO";
      }
    } catch (error) {
      console.error("[intro-builder] Preview configuration failed", error);
      if (generation === previewGeneration) setMessage(msg("preview_failed"), true);
    }
  }

  function fitPreview() {
    const mount = $("previewMount");
    const scale = Math.max(.05, Math.min(mount.clientWidth / 1280, mount.clientHeight / 1080));
    const width = 1280 * scale;
    const height = 1080 * scale;
    const element = $("previewScale");
    element.style.left = Math.round((mount.clientWidth - width) / 2) + "px";
    element.style.top = Math.round((mount.clientHeight - height) / 2) + "px";
    element.style.transform = "scale(" + scale + ")";
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = 0;
      enqueueSave().catch(() => {});
    }, 420);
  }

  function editorChanged() {
    readSettingsFromInputs();
    dirty = true;
    setSaveState("PENDING", "saving");
    configurePreview();
    scheduleSave();
  }

  function adoptSaveSummary(next, expectedJobId) {
    if (!next || typeof next !== "object") return;
    if (next.jobId !== expectedJobId) {
      renderSummary(next, true);
      throw new Error("JOB_CHANGED");
    }
    summary = next;
    language = next.language === "ko" ? "ko" : "en";
    updateSource();
    configurePreview();
  }

  async function persistSnapshot(snapshot, expectedJobId, expectedRevision, retryAllowed) {
    const result = await api.saveSettings(snapshot, expectedJobId, expectedRevision);
    if (result?.saveRejected === "JOB_STALE") {
      const currentJobId = result.jobId;
      const currentRevision = finiteRevision(result.revision);
      if (currentJobId !== expectedJobId) {
        const latest = await api.getSummary();
        renderSummary(latest, true);
        throw new Error("JOB_CHANGED");
      }
      if (!retryAllowed || currentRevision === null) throw new Error("JOB_STALE");
      summary = { ...summary, jobId: currentJobId, revision: currentRevision };
      return persistSnapshot(snapshot, currentJobId, currentRevision, false);
    }
    adoptSaveSummary(result, expectedJobId);
    return result;
  }

  async function saveLatest() {
    if (!dirty || !summary?.jobId) return summary;
    const snapshot = settingsPayload();
    const expectedJobId = summary.jobId;
    const expectedRevision = finiteRevision(summary.revision);
    if (expectedRevision === null) throw new Error("MISSING_REVISION");
    dirty = false;
    savingDepth += 1;
    setSaveState("SAVING", "saving");
    setMessage(msg("saving"));
    try {
      const result = await persistSnapshot(snapshot, expectedJobId, expectedRevision, true);
      if (!dirty && sameSettings(snapshot, settings)) {
        if (result?.settings) applySettingsToInputs(result.settings);
        setSaveState("SAVED", "saved");
        setMessage(msg("saved"));
      } else {
        setSaveState("PENDING", "saving");
      }
      return result;
    } catch (error) {
      console.error("[intro-builder] Settings save failed", error);
      if (error.message === "JOB_CHANGED") {
        dirty = false;
        setSaveState("RELOADED", "saved");
        setMessage(msg("job_changed"));
      } else {
        dirty = true;
        setSaveState("SAVE ERROR", "error");
        setMessage(msg("save_failed"), true);
      }
      throw error;
    } finally {
      savingDepth -= 1;
    }
  }

  function enqueueSave() {
    const operation = saveQueue.then(saveLatest);
    saveQueue = operation.catch(() => {});
    return operation;
  }

  async function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    await saveQueue;
    if (dirty) await enqueueSave();
    if (dirty) throw new Error("SETTINGS_NOT_SAVED");
    return summary;
  }

  async function selectExport() {
    if (running) return;
    $("selectButton").disabled = true;
    try {
      await flushSave();
      const next = await api.selectExport();
      if (!next) {
        setMessage(msg("source_cancelled"));
        return;
      }
      const changedJob = summary?.jobId && next.jobId !== summary.jobId;
      renderSummary(next, changedJob || !dirty);
      setMessage(next.source?.ready ? msg("ready") : msg("source_required"));
    } catch (error) {
      console.error("[intro-builder] Export selection failed", error);
      setMessage(msg("source_failed"), true);
    } finally {
      refreshControls();
    }
  }

  async function replayPreview() {
    try {
      await sceneApi()?.replay();
    } catch (error) {
      console.error("[intro-builder] Preview replay failed", error);
      setMessage(msg("preview_failed"), true);
    }
  }

  function updateProgress(payload) {
    let progress = Number(payload?.progress);
    if (!Number.isFinite(progress)) progress = Number(payload?.percent) / 100;
    progress = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
    const state = typeof payload?.state === "string" ? payload.state : "preparing";
    $("progressState").textContent = PROGRESS_LABELS[state] || state.replace(/_/g, " ").toUpperCase();
    $("progressPercent").textContent = Math.round(progress * 100) + "%";
    $("progressFill").style.width = (progress * 100) + "%";
    if (state === "preparing") setMessage(msg("preparing"));
    else if (state === "cancelling") setMessage(msg("cancelling"));
    else if (state === "cancelled") {
      setRunning(false);
      setMessage(msg("cancelled"));
    } else if (state === "error") {
      setRunning(false);
      setMessage(msg("build_failed"), true);
    } else if (state !== "complete") setMessage(msg("building"));
  }

  async function startBuild() {
    if (running || !summary?.source?.ready) return;
    outputAvailable = false;
    $("resultName").classList.remove("visible");
    try {
      await flushSave();
      const expectedJobId = summary.jobId;
      const expectedRevision = finiteRevision(summary.revision);
      if (expectedRevision === null) throw new Error("MISSING_REVISION");
      setRunning(true);
      updateProgress({ state: "preparing", progress: 0 });
      const snapshot = settingsPayload();
      const requestBuild = async (jobId, revision, retryAllowed) => {
        const result = await api.startBuild(snapshot, jobId, revision);
        if (result?.startRejected !== "JOB_STALE") return result;
        const latestRevision = finiteRevision(result.revision);
        if (result.jobId !== jobId) {
          renderSummary(result, true);
          setMessage(msg("job_changed"));
          return { aborted: true };
        }
        if (!retryAllowed || latestRevision === null) throw new Error("JOB_STALE");
        summary = { ...result, revision: latestRevision };
        updateSource();
        return requestBuild(jobId, latestRevision, false);
      };
      const result = await requestBuild(expectedJobId, expectedRevision, true);
      if (result?.aborted) {
        setRunning(false);
        refreshControls();
        return;
      }
      if (result?.cancelled || result?.ok === false) {
        setRunning(false);
        updateProgress({ state: "cancelled", progress: 0 });
        return;
      }
      if (!result?.ok) throw new Error("BUILD_FAILED");
      outputAvailable = true;
      setRunning(false);
      updateProgress({ state: "complete", progress: 1 });
      setMessage(msg("complete"));
      const outputName = basename(result.outputName || result.outputPath) || "DEMO MP4";
      $("resultName").textContent = outputName;
      $("resultName").classList.add("visible");
      refreshControls();
    } catch (error) {
      console.error("[intro-builder] Demo build failed", error);
      setRunning(false);
      updateProgress({ state: "error", progress: 0 });
    }
  }

  async function cancelBuild() {
    if (!running) return;
    $("cancelButton").disabled = true;
    updateProgress({ state: "cancelling", progress: Number($("progressFill").style.width.replace("%", "")) / 100 });
    try {
      await api.cancel();
    } catch (error) {
      console.error("[intro-builder] Build cancel failed", error);
      setMessage(msg("build_failed"), true);
    }
  }

  async function closeWindow() {
    if (running || closing) return;
    closing = true;
    try {
      await flushSave();
      const closed = await api.closeWindow();
      if (!closed) closing = false;
    } catch (error) {
      console.error("[intro-builder] Close failed", error);
      closing = false;
    }
  }

  function summaryUpdated(next) {
    const changedJob = Boolean(summary?.jobId && next?.jobId !== summary.jobId);
    if (changedJob) {
      clearTimeout(saveTimer);
      saveTimer = 0;
      dirty = false;
      renderSummary(next, true);
      setMessage(msg("job_changed"));
      return;
    }
    renderSummary(next, !dirty && savingDepth === 0);
  }

  [$("promptInput"), $("replyInput")].forEach(input => {
    input.addEventListener("keydown", preventEditorLineBreak);
    input.addEventListener("beforeinput", preventEditorLineBreak);
    input.addEventListener("input", singleLineEditorChanged);
  });
  document.querySelectorAll('input[name="typingSeconds"]').forEach(input => input.addEventListener("change", editorChanged));
  document.querySelectorAll('input[name="soundEnabled"]').forEach(input => input.addEventListener("change", editorChanged));
  $("selectButton").addEventListener("click", selectExport);
  $("replayButton").addEventListener("click", replayPreview);
  $("buildButton").addEventListener("click", startBuild);
  $("cancelButton").addEventListener("click", cancelBuild);
  $("openOutputButton").addEventListener("click", () => api.openOutput().catch(error => console.error("[intro-builder] Open output failed", error)));
  $("closeButton").addEventListener("click", closeWindow);
  $("sceneFrame").addEventListener("load", () => {
    previewReady = true;
    fitPreview();
    configurePreview();
    refreshControls();
  });
  const resizeObserver = new ResizeObserver(fitPreview);
  resizeObserver.observe($("previewMount"));

  if (!api) {
    setSaveState("NO BRIDGE", "error");
    setMessage(msg("api_missing"), true);
    refreshControls();
    return;
  }
  const removeSummaryListener = api.onSummaryUpdated(summaryUpdated);
  const removeProgressListener = api.onProgress(updateProgress);
  const removeCloseListener = api.onCloseRequested(closeWindow);
  window.addEventListener("unload", () => {
    resizeObserver.disconnect();
    removeSummaryListener?.();
    removeProgressListener?.();
    removeCloseListener?.();
  });
  api.getSummary().then(next => {
    renderSummary(next, true);
    setSaveState("SAVED", "saved");
  }).catch(error => {
    console.error("[intro-builder] Summary load failed", error);
    setSaveState("LOAD ERROR", "error");
    setMessage(msg("build_failed"), true);
  });
})();
