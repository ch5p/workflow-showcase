"use strict";

// User-facing strings for the Main process and the exporter.
// Contract: the UI skeleton (buttons, feature names like UPDATE XML / UPDATE TIMELINE / NEW JOB) stays English
// in both languages; sentences that people read are localized.
// job.json ui.language: "en" | "ko" | absent = follow the OS preferred UI language.

function resolveLanguage(preferred, osLocale){
  if(preferred === "en" || preferred === "ko") return preferred;
  return String(osLocale || "").toLowerCase().startsWith("ko") ? "ko" : "en";
}

function resolvePreferredLanguage(preferred, preferredSystemLanguages = [], systemLocale = "", appLocale = ""){
  const preferredSystemLanguage = Array.isArray(preferredSystemLanguages)
    ? preferredSystemLanguages.find(value => typeof value === "string" && value.trim()) || ""
    : "";
  return resolveLanguage(preferred, preferredSystemLanguage || systemLocale || appLocale);
}

const MAIN = {
  en: {
    job_save_failed: "Could not save the Current Job safely. The existing Job is preserved; check the app log.",
    ready_recovery: "Current Job recovery is required. Restart the app and check the log.",
    ready_xml_missing: "The XML file is missing or was moved. Load the XML again.",
    ready_timeline_missing: "The timeline input is missing or was moved. Load the timeline again.",
    ready_video_missing: "The source video file is missing or was moved. Load the video again.",
    ready_reference_missing: "Some registered reference files are missing or unsafe. Add them again or delete those entries.",
    boot_unsafe_title: "Current Job path is unsafe",
    boot_unsafe: "The app stopped because current-job contains an unsafe link or folder. Preserve the originals and check the folder layout.",
    boot_recovery_title: "Current Job recovery required",
    boot_recovery_xml_check: "The app stopped because the safe Job recovery state could not be verified. Check current-job/logs/app.log and recover while preserving the original files.",
    boot_recovery_xml: "The app stopped because an unfinished XML replacement could not be recovered automatically. Check current-job/logs/app.log and recover while preserving the original files.",
    boot_recovery_timeline_check: "The app stopped because the safe timeline recovery state could not be verified. Check current-job/logs/app.log and recover while preserving the original files.",
    boot_recovery_timeline: "The app stopped because an unfinished timeline replacement could not be recovered automatically. Check current-job/logs/app.log and recover while preserving the original files.",
    boot_recovery_video_check: "The app stopped because the safe video replacement recovery state could not be verified. Check current-job/logs/app.log and recover while preserving the original files.",
    boot_recovery_video: "The app stopped because an unfinished video replacement could not be recovered automatically. Check current-job/logs/app.log and recover while preserving the original files.",
    boot_unreadable_title: "Current Job is unreadable",
    boot_unreadable: "The app stopped because current-job/job.json could not be read. The original file was not overwritten. Check current-job/logs/app.log.",
    xml_dialog_title: "Load timeline XML",
    xml_dialog_message: "Choose how to apply the new XML to the current Job.",
    xml_dialog_detail: "UPDATE XML: keeps the video, references, GLOBAL, title, callout, and output settings, and safely reattaches SHOT mappings.\nNEW JOB: resets the existing working data (video, references, mappings, title, callout).",
    timeline_picker_title: "Load timeline",
    timeline_picker_message: "Choose a timeline source.",
    timeline_picker_detail: "XML accepts the legacy Final Cut Pro 7 format exported by Premiere Pro or DaVinci Resolve. CapCut Desktop 9.x local projects are experimental.",
    capcut_picker_title: "Choose a CapCut Desktop 9.x project folder",
    timeline_switch_title: "Change timeline format",
    timeline_switch_message: "A different timeline format requires a NEW JOB.",
    timeline_switch_detail: "The existing video, references, mappings, title, and callout will be reset. Completed Export files, logs, UI language, and output settings remain.",
    capcut_dialog_title: "Load CapCut timeline",
    capcut_dialog_message: "Choose how to apply the CapCut timeline to the current Job.",
    capcut_dialog_detail: "UPDATE TIMELINE keeps the video, references, GLOBAL, title, callout, and output settings, then reattaches SHOT mappings.\nNEW JOB resets the existing working data.",
    capcut_changed_during_read: "The CapCut project changed while it was being read. Leave that project or close CapCut, then try again.",
    capcut_draft_missing: "The selected folder does not contain draft_content.json.",
    rollback_block_title: "Current Job recovery required",
    rollback_block_xml: "Saving and Export are blocked because the XML replacement rollback could not be completed. Restart the app and check current-job/logs/app.log.",
    rollback_block_timeline: "Saving and Export are blocked because the timeline replacement rollback could not be completed. Restart the app and check current-job/logs/app.log.",
    rollback_block_video: "Saving and Export are blocked because the video replacement rollback could not be completed. Restart the app and check current-job/logs/app.log.",
    export_block_xml: "Finish or cancel Export before loading a new XML.",
    export_block_timeline: "Finish or cancel Export before loading a new timeline.",
    export_block_video: "Finish or cancel Export before loading a video.",
    export_block_reload: "Finish or cancel Export before reloading the Current Job.",
    xml_mode_required: "Choose how to import XML before committing it.",
    timeline_mode_required: "Choose how to import the timeline before committing it.",
    bitrate_running: "The bitrate cannot be changed while rendering.",
    bitrate_invalid: "Unsupported bitrate.",
    ui_capture_choose: "Choose the UI area to save as a 2X PNG.",
    ui_capture_detail: "The image was captured at the moment you pressed Ctrl+Shift+P. Window chrome and the mouse cursor are excluded.",
    ui_capture_scope_unavailable: "That area is not visible in the captured frame. Open the EDIT PANEL or pause while the TITLE CALLOUT is visible, then try again.",
    ui_capture_failed: "Could not create a verified 2X PNG. The Current Job was not changed; check current-job/logs/app.log.",
  },
  ko: {
    job_save_failed: "Current Job을 안전하게 저장하지 못했습니다. 기존 Job은 유지되며 앱 로그를 확인하세요.",
    ready_recovery: "Current Job 복구가 필요합니다. 앱을 다시 시작한 뒤 로그를 확인하세요.",
    ready_xml_missing: "XML 파일이 없거나 이동되었습니다. XML을 다시 불러오세요.",
    ready_timeline_missing: "타임라인 입력 파일이 없거나 이동되었습니다. 타임라인을 다시 불러오세요.",
    ready_video_missing: "완성본 영상 파일이 없거나 이동되었습니다. 영상을 다시 불러오세요.",
    ready_reference_missing: "등록된 레퍼런스 파일 중 일부가 없거나 안전하지 않습니다. 다시 추가하거나 해당 항목을 삭제하세요.",
    boot_unsafe_title: "Current Job path is unsafe",
    boot_unsafe: "current-job 내부에 안전하지 않은 링크 또는 폴더가 있어 앱을 중단했습니다. 원본을 보존하고 폴더 구성을 확인하세요.",
    boot_recovery_title: "Current Job recovery required",
    boot_recovery_xml_check: "안전한 Job 복구 상태를 확인하지 못해 앱을 중단했습니다. current-job/logs/app.log를 확인하고 원본 파일을 보존한 채 복구하세요.",
    boot_recovery_xml: "완료되지 않은 XML 교체를 자동 복구하지 못해 앱을 중단했습니다. current-job/logs/app.log를 확인하고 원본 파일을 보존한 채 복구하세요.",
    boot_recovery_timeline_check: "안전한 타임라인 복구 상태를 확인하지 못해 앱을 중단했습니다. current-job/logs/app.log를 확인하고 원본 파일을 보존한 채 복구하세요.",
    boot_recovery_timeline: "완료되지 않은 타임라인 교체를 자동 복구하지 못해 앱을 중단했습니다. current-job/logs/app.log를 확인하고 원본 파일을 보존한 채 복구하세요.",
    boot_recovery_video_check: "안전한 영상 교체 복구 상태를 확인하지 못해 앱을 중단했습니다. current-job/logs/app.log를 확인하고 원본 파일을 보존한 채 복구하세요.",
    boot_recovery_video: "완료되지 않은 영상 교체를 자동 복구하지 못해 앱을 중단했습니다. current-job/logs/app.log를 확인하고 원본 파일을 보존한 채 복구하세요.",
    boot_unreadable_title: "Current Job is unreadable",
    boot_unreadable: "current-job/job.json을 읽을 수 없어 앱을 중단했습니다. 원본 파일은 덮어쓰지 않았습니다. current-job/logs/app.log를 확인하세요.",
    xml_dialog_title: "Load timeline XML",
    xml_dialog_message: "새 XML을 현재 작업에 반영할 방식을 선택하세요.",
    xml_dialog_detail: "UPDATE XML: 영상·레퍼런스·GLOBAL·제목·콜아웃·출력 설정을 유지하고 SHOT 매핑을 안전하게 재연결합니다.\nNEW JOB: 기존 작업 자료(영상·레퍼런스·매핑·제목·콜아웃)를 초기화합니다.",
    timeline_picker_title: "Load timeline",
    timeline_picker_message: "타임라인 소스를 선택하세요.",
    timeline_picker_detail: "XML은 Premiere Pro 또는 DaVinci Resolve에서 내보낸 Final Cut Pro 7 형식을 사용합니다. CapCut Desktop 9.x 로컬 프로젝트 입력은 실험 기능입니다.",
    capcut_picker_title: "CapCut Desktop 9.x 프로젝트 폴더 선택",
    timeline_switch_title: "Change timeline format",
    timeline_switch_message: "다른 타임라인 형식으로 바꾸려면 NEW JOB이 필요합니다.",
    timeline_switch_detail: "기존 영상·레퍼런스·매핑·제목·콜아웃은 초기화됩니다. 완성된 Export 파일·로그·UI 언어·출력 설정은 유지됩니다.",
    capcut_dialog_title: "Load CapCut timeline",
    capcut_dialog_message: "CapCut 타임라인을 현재 작업에 반영할 방식을 선택하세요.",
    capcut_dialog_detail: "UPDATE TIMELINE: 영상·레퍼런스·GLOBAL·제목·콜아웃·출력 설정을 유지하고 SHOT 매핑을 다시 연결합니다.\nNEW JOB: 기존 작업 자료를 초기화합니다.",
    capcut_changed_during_read: "읽는 도중 CapCut 프로젝트가 변경되었습니다. 해당 프로젝트에서 나가거나 CapCut을 닫은 뒤 다시 시도하세요.",
    capcut_draft_missing: "선택한 폴더에 draft_content.json이 없습니다.",
    rollback_block_title: "Current Job recovery required",
    rollback_block_xml: "XML 교체 rollback을 완료하지 못해 저장과 Export를 차단했습니다. 앱을 다시 시작한 뒤 current-job/logs/app.log를 확인하세요.",
    rollback_block_timeline: "타임라인 교체 rollback을 완료하지 못해 저장과 Export를 차단했습니다. 앱을 다시 시작한 뒤 current-job/logs/app.log를 확인하세요.",
    rollback_block_video: "영상 교체 rollback을 완료하지 못해 저장과 Export를 차단했습니다. 앱을 다시 시작한 뒤 current-job/logs/app.log를 확인하세요.",
    export_block_xml: "Export를 완료하거나 취소한 뒤 새 XML을 불러오세요.",
    export_block_timeline: "Export를 완료하거나 취소한 뒤 새 타임라인을 불러오세요.",
    export_block_video: "Export를 완료하거나 취소한 뒤 영상을 불러오세요.",
    export_block_reload: "Export를 완료하거나 취소한 뒤 Current Job을 다시 불러오세요.",
    xml_mode_required: "XML을 반영할 방식을 선택한 뒤 적용하세요.",
    timeline_mode_required: "타임라인을 반영할 방식을 선택한 뒤 적용하세요.",
    bitrate_running: "렌더링 중에는 비트레이트를 변경할 수 없습니다.",
    bitrate_invalid: "지원하지 않는 비트레이트입니다.",
    ui_capture_choose: "2배 PNG로 저장할 UI 영역을 선택하세요.",
    ui_capture_detail: "Ctrl+Shift+P를 누른 순간의 화면을 캡처했습니다. 창 테두리와 마우스 커서는 포함되지 않습니다.",
    ui_capture_scope_unavailable: "캡처 순간에 해당 영역이 보이지 않았습니다. EDIT PANEL을 열거나 TITLE CALLOUT이 보이는 지점에서 일시정지한 뒤 다시 시도하세요.",
    ui_capture_failed: "검증된 2배 PNG를 만들지 못했습니다. Current Job은 변경하지 않았으며 current-job/logs/app.log를 확인하세요.",
  },
};

const EXPORTER = {
  en: {
    output_name_failed: "Could not allocate a new export file name.",
    ffmpeg_missing: "FFmpeg was not found. If WinGet is available, run 'winget install -e --id Gyan.FFmpeg' and fully restart the app, or put ffmpeg.exe in the app's ffmpeg folder.",
    first_frame_timeout: "Timed out waiting for the first offscreen frame.",
    frame_empty: "The offscreen frame is empty.",
    ffmpeg_failed: "FFmpeg failed",
    already_running: "An export is already in progress.",
    xml_missing: "No XML is loaded.",
    timeline_missing: "No timeline is loaded.",
    video_missing: "No video is loaded.",
    finalize_rename: "The render finished but the file could not be renamed to its final name. The completed .part.mp4 was preserved.",
    finalize_verify: "The render finished but final file verification failed. Check the output folder and the app log.",
    disk_space_insufficient: "The output folder does not have enough free space for the estimated render and its safety reserve. Free some space and try again.",
  },
  ko: {
    output_name_failed: "새 Export 파일명을 할당하지 못했습니다.",
    ffmpeg_missing: "FFmpeg를 찾을 수 없습니다. WinGet을 사용할 수 있다면 'winget install -e --id Gyan.FFmpeg'를 실행한 뒤 앱을 완전히 재시작하세요. 또는 ffmpeg.exe를 앱의 ffmpeg 폴더에 넣으세요.",
    first_frame_timeout: "offscreen 첫 프레임 시간 초과",
    frame_empty: "offscreen 프레임이 비어 있습니다.",
    ffmpeg_failed: "FFmpeg 실패",
    already_running: "이미 익스포트가 진행 중입니다.",
    xml_missing: "XML이 없습니다.",
    timeline_missing: "타임라인이 없습니다.",
    video_missing: "영상이 없습니다.",
    finalize_rename: "렌더는 완료됐지만 최종 파일명으로 바꾸지 못했습니다. 완성된 .part.mp4 파일은 보존했습니다.",
    finalize_verify: "렌더는 완료됐지만 최종 파일 검증에 실패했습니다. output 폴더와 앱 로그를 확인하세요.",
    disk_space_insufficient: "output 폴더에 예상 렌더 파일과 안전 여유분을 저장할 공간이 부족합니다. 공간을 확보한 뒤 다시 시도하세요.",
  },
};

function pick(table, lang, key){
  const dict = table[lang] || table.en;
  return dict[key] ?? table.en[key] ?? key;
}

function mainText(lang, key){ return pick(MAIN, lang, key); }
function exporterText(lang, key){ return pick(EXPORTER, lang, key); }

module.exports = { resolveLanguage, resolvePreferredLanguage, mainText, exporterText };
