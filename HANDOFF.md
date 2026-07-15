# Handoff

## Current State

Electron 단일 Job MVP 골격이 구성되어 있습니다. 기존 `output-preview.html`의 FCP XML 파서는 다시 작성하지 않고 `window.portablePreview` 브리지로만 호출합니다. XML, 영상, 레퍼런스는 `current-job`에 복사되고 GLOBAL/SHOT 매핑은 `job.json`에 자동 저장됩니다.

SHOT 클릭·방향키 탐색은 실제 영상 `currentTime`과 타임라인을 함께 이동합니다. 정지 상태, 재생 시작, 재생 중 SHOT 이동을 `current-job`의 실제 XML/영상으로 검증했으며 재생 중 이전 영상 시계가 새 위치를 덮어쓰지 않도록 video-frame clock generation guard를 둡니다.

`EXPORT H.264`는 1280x1080 Electron offscreen 화면을 60fps BGRA raw frame으로 FFmpeg에 직접 전달합니다. 기본은 `h264_nvenc` CBR 12 Mbps이고 런타임 실패 시 `libx264`로 전체 출력을 다시 시도합니다. 원본 AAC 오디오는 stream copy하고 출력은 `current-job/output/character_workflow_export_*.mp4`에 저장합니다.

메인 Export 버튼은 즉시 렌더하지 않고 `src/export-dialog.html` 독립 modal 창을 엽니다. 사용자가 편집 패널에서 확정한 `PROJECT TITLE`과 고정 출력 정보를 확인한 뒤 `START EXPORT`를 눌러야 시작하며, 진행률·프레임·경과/예상 시간·완료 경로를 팝업에서 표시합니다. 제목은 입력 즉시 메인 프리뷰에 반영되고 짧은 debounce 뒤 `job.json`의 선택 필드 `projectTitle`에 저장되며 offscreen 출력에도 함께 적용됩니다. 필드가 없을 때만 `SEEDANCE 2.0`을 쓰고, 사용자가 명시적으로 저장한 빈 문자열은 그대로 유지합니다.

## Red Zone

- `src/output-preview.html`의 `parseFCPXML`, `buildFocusSegments`, `build`, 재생 시계는 기존 출력 계약입니다. 파서 재작성 금지.
- `current-job/job.json`의 `version`, `relativePath`, `globalReferenceIds`, `shotMappings` key를 임의 변경하지 않습니다.
- `projectTitle`은 최대 40자의 선택 필드입니다. 필드가 없을 때만 `SEEDANCE 2.0`으로 복원하며 빈 문자열은 유효한 사용자 선택입니다. 편집 패널의 `PROJECT TITLE`이 유일한 편집 위치이며 Export 팝업은 저장된 값을 확인만 합니다.
- `callout`은 선택 필드이며 `enabled`, `position`, `style`, `startSeconds`, `durationSeconds`, `subtitle`을 저장합니다. 없으면 기존 LINE/LEFT 기본값으로 복원합니다. TOOL TAG 기능은 출력 가독성 문제로 제거했습니다.
- `projectTitle`과 `callout.subtitle` 자동 저장은 입력 중인 DOM 값을 다시 쓰지 않습니다. 포커스를 벗어날 때만 공백을 정리해야 하며, debounce 저장이 사용자의 띄어쓰기를 지우는 회귀를 만들면 안 됩니다.
- Export 시작 주체는 `export-preload.cjs`가 노출한 제한 API를 사용하는 popup 창입니다. 진행 중 창의 기본 닫기를 막고, `CANCEL EXPORT`를 통해서만 FFmpeg와 offscreen 창을 정리합니다.
- Electron renderer에서 Node API를 직접 켜지 않습니다. 파일 접근은 `preload.cjs`의 제한된 IPC만 사용합니다.
- 앱 이동성을 위해 사용자 절대 경로를 소스 또는 `job.json`에 저장하지 않습니다.
- Git은 앱 코드와 `current-job` 빈 폴더 골격만 추적합니다. `job.json`, source media, references, output, logs, `node_modules`, archive/checkpoints는 로컬 런타임 데이터이므로 `.gitignore`에서 제외하며 임의로 강제 추가하지 않습니다.
- `exporter.cjs`의 raw BGRA 1:1 캡처, 60fps, bt709, AAC stream copy 계약을 깨지 않습니다. PNG/JPEG 중간 프레임 방식으로 되돌리지 않습니다.
- 시작 시 WAITING placeholder 없이 빈 레퍼런스 영역으로 두고, 재생 0.15초부터 GLOBAL 카드를 0.15초 간격으로 이어 붙입니다. 이후 REPLACE/INHERIT는 이전 카드를 유지한 0.35초 크로스페이드로 공백 없이 교체합니다. ADD는 기존 카드를 유지하고 추가 카드만 0.15초 간격으로 표시합니다.
- SHOT 클릭·방향키·다중 선택은 탐색 상태일 뿐입니다. `wireframechange`, `job:save`, `setReferences`는 실제 레퍼런스 매핑 편집에서만 호출합니다.
- EDIT PANEL은 우측 `editPanelHandle`과 상단 버튼으로 열고 닫으며, 열린 상태에서 렌더 왼쪽 영역을 누르면 닫힙니다. 패널 헤더에는 `PROJECT TITLE` 입력과 닫기만 둡니다. `previewShell` 닫기 이벤트는 `#editOverlay`, `#shotRail`, `#editPanelHandle` 내부 조작을 반드시 제외해야 합니다.
- 영상 제목 callout은 `updateVideoCallout()`에서 영상 시간으로 구동합니다. CSS wall-clock 애니메이션으로 바꾸지 않아야 미리보기와 60fps offscreen 출력 타이밍이 일치합니다. 빈 프로젝트 제목 또는 `enabled:false`에서는 숨깁니다. 출력 콜아웃은 작은 타임라인 정보보다 약 1.5배 큰 가독성 규격을 사용하며 상단 고정 문구는 `EDIT WORKFLOW`입니다.
- 출력 글꼴은 혼합형입니다. 프로젝트 제목, SHOT 라벨, 레퍼런스 라벨은 일반 UI sans를 사용하고 타임코드, 눈금, EDIT/FPS 숫자는 정렬을 위해 mono를 유지합니다. 콜아웃 subtitle은 13px/600/흰색 80%입니다.
- 상단 `RESET`은 `portablePreview.reset()`만 호출하여 영상·플레이헤드·SHOT 탐색을 0초로 돌리고 Job·레퍼런스 매핑은 변경하지 않습니다.
- 상단 `OUTPUT`은 `export:open-output` IPC를 호출하여 현재 Job의 `current-job/output` 폴더를 탐색기로 엽니다. 렌더 시작이나 미리보기 상태 변경은 하지 않습니다.
- 메인 Electron 창은 기본 1360px, 최소 1320px이며 내부 앱 본체는 1320px입니다. EDIT PANEL과 SHOT 레일은 투명 트랙의 얇은 스크롤바와 청록색 hover를 공유합니다. 출력 캔버스 1280x1080 계약과는 별개입니다.
- 레퍼런스 파일 삭제는 Main IPC에서만 수행하고, `references`, GLOBAL, 모든 SHOT 매핑을 함께 정리합니다. 실제 파일 삭제 대상은 반드시 `current-job/references` 내부여야 합니다.
- REFERENCE FILES의 `IMAGE 01`, `VIDEO 01` 번호는 전체 파일 목록 순서에 따른 표시값이며 삭제 후 타입별로 다시 당깁니다. GLOBAL BASE와 SHOT REFERENCES는 각 화면에 배치된 왼쪽 순서대로 별도 번호를 표시합니다. 연결 계약인 `id`, `relativePath`, 실제 파일명은 변경하지 않습니다.
- SHOT 매핑의 선택 필드 `leadInSeconds`는 현재 `1`만 허용합니다. 켜진 샷은 영상·SHOT 선택 위치를 바꾸지 않고 레퍼런스 매핑만 실제 샷 시작 1초 전부터 적용합니다. 필드가 없거나 `0`이면 기존 컷 시작 동작을 유지합니다.
- LEAD-IN이 켜진 SHOT에 들어가거나 그 SHOT에서 빠져나갈 때는 이전 카드를 즉시 정리하고, 새 카드는 opacity 혼합 없이 transform 팝만 적용합니다. 일반 컷 전환의 0.35초 크로스페이드는 유지합니다.

검색 키워드: `RED ZONE`, `window.portablePreview`, `JOB_ROOT`, `job_saved`, `export_started`, `export_completed`.

## Hot Debug

1. `current-job/logs/app.log`의 마지막 이벤트를 확인합니다.
2. `current-job/job.json`에서 XML, video, references의 `relativePath`가 실제 파일과 일치하는지 확인합니다.
3. `npm.cmd run check`로 문법, 파서 브리지, 상대 경로 계약을 확인합니다.
4. `npm.cmd run smoke`로 보이지 않는 Electron 창을 열어 API와 프리뷰 브리지를 검사합니다.
5. `job_read_failed`가 있으면 손상된 `job.json`을 별도 보관한 뒤 앱이 새 Job을 만들게 합니다.

주요 이벤트: `app_started`, `xml_imported`, `video_imported`, `references_imported`, `job_saved`, `renderer_ready`, `renderer_error`, `export_dialog_opened`, `project_title_updated`, `export_started`, `export_completed`, `export_failed`, `export_cancelled`.

레퍼런스 전환 공백이나 깜빡임은 `positionReferenceDock`, `fadeOutgoingReferences`, `immediatePortableIds`, `.referenceDockItem.leaving` 순서로 확인합니다. 뒤로 이동하거나 리셋할 때 첫 GLOBAL의 0.15초 등장 상태가 복원되는지도 함께 확인합니다.
LEAD-IN이 어긋나면 `job.json`의 대상 SHOT에 `leadInSeconds: 1`이 저장됐는지 확인하고, `portableReferenceShotAtFrame`, `portableShotReferenceStartFrame` 계산을 순서대로 확인합니다.
LEAD-IN 진입·퇴장 카드에 다른 이미지가 섞이면 `leadInTransition`, `lastPortableShotUsedLeadIn`, `clearOutgoingReferences`, `prepareLeadInEntries`, `.leadInEnter` 순서로 확인합니다.
SHOT 클릭이 간헐적으로 레퍼런스를 숨기면 단순 선택 직후 `job_saved`가 기록되는지 확인합니다. 기록된다면 탐색 이벤트가 `wireframechange`를 잘못 발생시킨 것입니다.
EDIT PANEL이 내부 조작 중 닫히면 `previewShell`의 `pointerdown` 대상이 `#editOverlay,#shotRail,#editPanelHandle` guard를 통과하는지 먼저 확인합니다.
레퍼런스 삭제 문제는 `reference_deleted`, `reference_file_delete_failed` 이벤트와 `job.json`에 삭제 ID가 남아 있는지부터 확인합니다. 파일 정리 실패여도 매핑에서는 제거되며, 고아 파일만 수동 정리합니다.

익스포트 문제는 `export_started`, `export_encoder_fallback`, `export_completed`, `export_failed`, `export_cancelled` 순서와 `.part.mp4` 잔존 여부를 먼저 확인합니다.
Export 팝업이 열리지 않으면 `export_dialog_opened` 이벤트와 `export-preload.cjs` 로드 여부를 확인합니다. 진행률이 멈추면 팝업을 반복 실행하지 말고 마지막 `export:progress` 상태와 FFmpeg 로그를 확인합니다.

## Next

- 실제 사용자 XML/영상/레퍼런스로 전체 동선 검수
- 전체 길이 실제 렌더의 장시간 안정성 및 취소 동선 검수
- 시스템 FFmpeg를 앱 내부 `ffmpeg/ffmpeg.exe` 번들로 교체
- 실행 파일 패키징 후 폴더 이동 검수
