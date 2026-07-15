# Handoff

## Current State

Electron 단일 Job MVP 골격이 구성되어 있습니다. 기존 FCP XML parser는 동작을 유지한 채 `src/core/xmeml-parser.js`로, PRIMARY 계산과 SHOT/reference 순수 규칙은 나머지 `src/core/*`로 분리했습니다. `output-preview.html`은 `window.portablePreview` 브리지와 presentation runtime을 소유합니다. XML, 영상, 레퍼런스는 `current-job`에 복사되고 GLOBAL/SHOT 매핑은 `job.json`에 자동 저장됩니다.

공개 source beta는 `https://github.com/ch5p/character-workflow-portable`의 `main`과 `v0.1.0-beta.1` 태그에 배포했습니다. 저장소는 사설 이력과 사용자 Job을 제외한 단일 공개 이력으로 시작하며, GitHub Actions의 Windows `npm ci`·`check`·격리 `smoke`와 공개 태그 fresh clone의 `smoke:export`까지 통과했습니다. Private vulnerability reporting도 활성화했습니다.

SHOT 클릭·방향키 탐색은 실제 영상 `currentTime`과 타임라인을 함께 이동합니다. 정지 상태, 재생 시작, 재생 중 SHOT 이동을 `current-job`의 실제 XML/영상으로 검증했으며 재생 중 이전 영상 시계가 새 위치를 덮어쓰지 않도록 video-frame clock generation guard를 둡니다.

`EXPORT H.264`는 `render-spec.cjs`가 공급하는 1280x1080 Electron offscreen 화면을 60fps BGRA raw frame으로 FFmpeg에 직접 전달합니다. editor fit, Export summary, offscreen window, paint 검사와 FFmpeg 입력이 같은 spec을 사용합니다. 기본은 `h264_nvenc` CBR 12 Mbps이고 런타임 실패 시 `libx264`로 전체 출력을 다시 시도합니다. 원본 AAC 오디오는 stream copy하고 출력은 `current-job/output/character_workflow_export_*.mp4`에 저장합니다.

메인 Export 버튼은 즉시 렌더하지 않고 `src/export-dialog.html` 독립 modal 창을 엽니다. 사용자가 편집 패널에서 확정한 `PROJECT TITLE`과 고정 출력 정보를 확인한 뒤 `START EXPORT`를 눌러야 시작하며, 진행률·프레임·경과/예상 시간·완료 경로를 팝업에서 표시합니다. 제목은 입력 즉시 메인 프리뷰에 반영되고 짧은 debounce 뒤 `job.json`의 선택 필드 `projectTitle`에 저장되며 offscreen 출력에도 함께 적용됩니다. 필드가 없을 때만 `UNTITLED PROJECT`를 쓰고, 사용자가 명시적으로 저장한 빈 문자열은 그대로 유지합니다.

`LOAD XML` 버튼과 XML drop은 후보 파일을 먼저 검증한 뒤 `타임라인만 업데이트`(기본값), `새 Job으로 불러오기`, `취소`를 선택하는 같은 backend 경계를 사용합니다. UPDATE는 영상·레퍼런스·GLOBAL·제목·콜아웃·출력 설정을 유지하고 익명 `source identity + in/out occurrence`로 기존 SHOT 매핑을 보수적으로 재연결합니다. 확실하지 않거나 사라진 매핑은 삭제하지 않고 `orphanedShotMappings`에 보관하며, NEW JOB을 명시한 경우에만 source video/reference/GLOBAL/SHOT mapping을 초기화합니다. 두 모드 모두 트랜잭션 journal과 `jobId + revision` 비교로 rollback과 늦은 저장 차단을 수행합니다. XML/video picker와 drop은 각각 같은 Main prepare/commit helper를 사용합니다.

Windows의 `EPERM`/`EACCES`/`EBUSY`에 대비해 XML/video transaction의 manifest, Job backup, Job install·restore는 rename을 재시도하고, 계속 실패하면 `copy → fsync → SHA-256 검증` 뒤 staging을 정리합니다. 유효한 `manifest.json`은 모든 `.tmp`보다 항상 우선하며, 잠긴 고정 `.tmp`는 고유 staging 파일로 우회합니다. Rollback이 실제로 끝난 뒤에만 고유 staging에 완료 marker를 fsync하고 검증 교체한 뒤 `state: rolled_back`를 기록하므로 빈 backup 폴더를 완료 증거로 추측하지 않습니다. marker 기록 전에 중단돼도 manifest inventory와 남은 backup을 기준으로 candidate 제거를 안전하게 재실행합니다. 완료된 transaction의 임시 파일 정리만 잠긴 경우에는 저장·Export를 차단하지 않고 다음 시작 때 정리를 다시 시도합니다. 실제 실패 Job을 source 2개, reference 11개, 기존 `job.json`의 파일별 SHA-256까지 동일하게 rollback한 상태입니다.

beta.2 후보는 single-instance lock, 일반 `job.json`의 UUID staging·fsync·rename 재시도, no-follow 저장 경로 검사, Electron 영상 decode 사전검증을 추가했습니다. Current Job identity가 외부에서 바뀌면 이전 화면의 stale patch를 새 Job에 재적용하지 않고 저장을 차단하며, 헤더의 `Reload Current Job` 아이콘으로만 다시 읽습니다. Export 인코딩 완료 뒤 최종 rename이 실패하면 완성 `.part.mp4`를 보존합니다. 격리 runtime safety 검사와 실제 데스크톱 smoke에서 정상/손상 영상 preflight, Job 불변, 두 번째 인스턴스 차단을 확인했습니다. 현 세션의 `smoke:export` 재실행은 실행 승인 한도로 보류되어 사용자 Export QA가 필요합니다.

## Red Zone

- `src/core/xmeml-parser.js`, `primary-timeline.js`, `shot-model.js`, `reference-mapping.js`와 `src/output-preview.html`의 `build`, 재생 시계는 기존 출력 계약입니다. 레이아웃 작업에서 core를 수정하거나 parser를 다시 작성하지 않습니다.
- `current-job/job.json`의 `version`, `jobId`, `revision`, `relativePath`, `globalReferenceIds`, `shotMappings`, `timelineShots`, `orphanedShotMappings` key를 임의 변경하지 않습니다.
- 한 Current Job에는 한 Electron 프로세스만 접근합니다. `requestSingleInstanceLock()`을 제거하거나 test `userData` 설정 이전으로 옮기지 않습니다.
- 일반 Job 저장은 `durable-file.cjs`의 고유 staging·fsync·rename 재시도를 사용합니다. 교체 실패 시 완성 staging과 기존 `job.json`을 지우지 않습니다.
- `current-job`, `source`, `references`, `output`, `logs`의 symlink/junction은 금지합니다. 파일 URL 생성·XML read·reference delete·Export input/output 직전에 `owned-path.cjs` 검사를 우회하지 않습니다.
- `projectTitle`은 최대 40자의 선택 필드입니다. 필드가 없을 때만 `UNTITLED PROJECT`로 복원하며 빈 문자열은 유효한 사용자 선택입니다. 편집 패널의 `PROJECT TITLE`이 유일한 편집 위치이며 Export 팝업은 저장된 값을 확인만 합니다.
- `callout`은 선택 필드이며 `enabled`, `position`, `style`, `startSeconds`, `durationSeconds`, `subtitle`을 저장합니다. 없으면 기존 LINE/LEFT 기본값으로 복원합니다. TOOL TAG 기능은 출력 가독성 문제로 제거했습니다.
- `projectTitle`과 `callout.subtitle` 자동 저장은 입력 중인 DOM 값을 다시 쓰지 않습니다. 포커스를 벗어날 때만 공백을 정리해야 하며, debounce 저장이 사용자의 띄어쓰기를 지우는 회귀를 만들면 안 됩니다.
- Export 시작 주체는 `export-preload.cjs`가 노출한 제한 API를 사용하는 popup 창입니다. 진행 중 창의 기본 닫기를 막고, `CANCEL EXPORT`를 통해서만 FFmpeg와 offscreen 창을 정리합니다.
- Electron renderer에서 Node API를 직접 켜지 않습니다. 파일 접근은 `preload.cjs`의 제한된 IPC만 사용합니다.
- 앱 이동성을 위해 사용자 절대 경로를 소스 또는 `job.json`에 저장하지 않습니다.
- Git은 앱 코드와 `current-job` 빈 폴더 골격만 추적합니다. `job.json`, source media, references, output, logs, `node_modules`, archive/checkpoints는 로컬 런타임 데이터이므로 `.gitignore`에서 제외하며 임의로 강제 추가하지 않습니다.
- `LOAD XML`의 안전 기본값은 UPDATE입니다. UPDATE는 `source/timeline.xml`과 타임라인 metadata만 교체하고 `source/video.*`, `references/`, GLOBAL, 제목, 콜아웃, `ui`, `output`을 건드리지 않습니다. 기존 SHOT 번호만으로 매핑하지 않으며 exact 익명 source identity를 우선하고 unique name/range 증거가 있을 때만 fallback합니다. 다중 후보는 추측하지 않고 orphan으로 남깁니다.
- NEW JOB은 사용자가 두 번째 선택지를 명시한 경우에만 실행하는 파괴적 경계입니다. source/reference 삭제 전에 후보 검증과 선택을 끝내야 하며, 성공 시에도 기존 Export 파일·로그·`ui`·`output` 설정은 보존합니다.
- XML/video picker와 drop은 별도 저장 구현을 만들지 않고 같은 제한 IPC와 Main import helper를 사용합니다. drop 파일은 `webUtils.getPathForFile`로 받은 경로만 전달하며 renderer가 사용자 파일을 직접 영구 저장하지 않습니다.
- video candidate는 visible preview나 기존 Job을 바꾸기 전에 detached Electron video probe가 metadata와 첫 프레임을 읽어야 합니다. preflight 실패 candidate는 폐기하고 기존 video·Job·revision을 유지합니다.
- 외부에서 Current Job identity가 바뀐 stale save는 새 Job에 자동 재시도하지 않습니다. 저장을 차단한 뒤 명시적 reload만 허용합니다.
- 새 Job마다 새 `jobId`를 발급하고 모든 mutation은 자신이 읽은 `jobId + revision`을 포함합니다. UPDATE처럼 같은 Job 안에서 revision만 바뀌는 경우에도 늦은 debounce 저장을 거부해야 합니다.
- transaction 복구에서 유효한 `manifest.json`이 기준입니다. `.tmp`의 `updatedAt`이 더 늦어 보여도 primary를 덮어 해석하지 않습니다. primary가 없거나 손상된 경우에만 유효한 staging 후보 중 최신 기록을 사용합니다.
- transaction 정리는 staging 파일을 먼저, backup/candidate를 다음, primary manifest를 마지막에 지웁니다. 정리 실패 중에도 rollback 기준이 남아야 하며 이 순서를 바꾸지 않습니다. 기존 `job.json`과 backup 해시가 같으면 파일 교체를 생략합니다.
- `rollback-complete.json`은 backup 폴더가 비었다는 추측을 대체하는 완료 증거입니다. transaction ID와 종류가 일치하는 유효 final 또는 durable staged marker만 이미 끝난 rollback으로 인정하고, 잘리거나 불일치한 marker는 무시합니다. marker가 없으면 이전 timeline/video가 원래 없었던 경우에도 설치된 candidate를 제거하며, 재시도 때는 `moved` inventory와 backup 잔존 여부로 복원된 이전 파일을 다시 지우지 않습니다.
- `backup/job.json`은 manifest에 `hadJob: true`가 durable하게 기록된 경우에만 복원합니다. `hadJob: null`은 Job backup 생성 중이며 live Job mutation 전이라는 뜻이므로 final backup이 존재해도 신뢰하지 않고 현재 `job.json`을 보존합니다. 정상 `.partial`과 잘린 final이 함께 남는 crash-window를 회귀 테스트로 고정합니다.
- `exporter.cjs`의 raw BGRA 1:1 캡처, 60fps, bt709, AAC stream copy 계약을 깨지 않습니다. PNG/JPEG 중간 프레임 방식으로 되돌리지 않습니다.
- FFmpeg가 성공한 뒤 final rename/fsync가 실패한 경우 완성 `.part.mp4`를 보존합니다. 인코딩 실패·취소 전의 불완전 part만 정리합니다.
- `render-spec.cjs`가 classic width/height/fps/bitrate의 단일 소스입니다. `src/layouts/classic/*`은 presentation surface이며 runtime preset, Job layout ID, 화면비 선택 UI를 beta에 추가하지 않습니다.
- `npm run smoke`와 `smoke:export`는 `scripts/run-smoke.cjs`가 만든 앱 외부 임시 Job root와 전용 Electron userData에서만 실행합니다. `PORTABLE_TEST_JOB_ROOT` 없이 smoke flag를 직접 실행하거나 앱 내부/current-job을 test root로 지정하면 Main이 즉시 거부해야 합니다.
- 시작 시 WAITING placeholder 없이 빈 레퍼런스 영역으로 두고, 재생 0.15초부터 GLOBAL 카드를 0.15초 간격으로 이어 붙입니다. 이후 REPLACE/INHERIT는 이전 카드를 유지한 0.35초 크로스페이드로 공백 없이 교체합니다. ADD는 기존 카드를 유지하고 추가 카드만 0.15초 간격으로 표시합니다.
- SHOT 클릭·방향키·다중 선택은 탐색 상태일 뿐입니다. `wireframechange`, `job:save`, `setReferences`는 실제 레퍼런스 매핑 편집에서만 호출합니다.
- EDIT PANEL은 우측 `editPanelHandle`과 상단 버튼으로 열고 닫으며, 열린 상태에서 렌더 왼쪽 영역을 누르면 닫힙니다. 패널 헤더에는 `PROJECT TITLE` 입력과 닫기만 둡니다. `previewShell` 닫기 이벤트는 `#editOverlay`, `#shotRail`, `#editPanelHandle` 내부 조작을 반드시 제외해야 합니다.
- 영상 제목 callout은 `updateVideoCallout()`에서 영상 시간으로 구동합니다. CSS wall-clock 애니메이션으로 바꾸지 않아야 미리보기와 60fps offscreen 출력 타이밍이 일치합니다. 빈 프로젝트 제목 또는 `enabled:false`에서는 숨깁니다. 출력 콜아웃은 작은 타임라인 정보보다 약 1.5배 큰 가독성 규격을 사용하며 상단 고정 문구는 `EDIT WORKFLOW`입니다.
- 출력 글꼴은 혼합형입니다. 프로젝트 제목, SHOT 라벨, 레퍼런스 라벨은 일반 UI sans를 사용하고 타임코드, 눈금, EDIT/FPS 숫자는 정렬을 위해 mono를 유지합니다. 콜아웃 subtitle은 13px/600/흰색 80%입니다.
- 상단 `RESET`은 `portablePreview.reset()`만 호출하여 영상·플레이헤드·SHOT 탐색을 0초로 돌리고 Job·레퍼런스 매핑은 변경하지 않습니다.
- 상단 `OUTPUT`은 `export:open-output` IPC를 호출하여 현재 Job의 `current-job/output` 폴더를 탐색기로 엽니다. 렌더 시작이나 미리보기 상태 변경은 하지 않습니다.
- 메인 Electron 창은 기본 1360px, 최소 1320px이며 내부 앱 본체는 1320px입니다. EDIT PANEL과 SHOT 레일은 투명 트랙의 얇은 스크롤바와 청록색 hover를 공유합니다. 출력 캔버스 1280x1080 계약과는 별개입니다.
- 레퍼런스 파일 삭제는 Main IPC에서만 수행하고, `references`, GLOBAL, 활성 SHOT 매핑과 orphan 매핑을 함께 정리합니다. 실제 파일 삭제 대상은 반드시 `current-job/references` 내부여야 합니다.
- REFERENCE FILES의 `IMAGE 01`, `VIDEO 01` 번호는 전체 파일 목록 순서에 따른 표시값이며 삭제 후 타입별로 다시 당깁니다. GLOBAL BASE와 SHOT REFERENCES는 각 화면에 배치된 왼쪽 순서대로 별도 번호를 표시합니다. 연결 계약인 `id`, `relativePath`, 실제 파일명은 변경하지 않습니다.
- SHOT 매핑의 선택 필드 `leadInSeconds`는 현재 `1`만 허용합니다. 켜진 샷은 영상·SHOT 선택 위치를 바꾸지 않고 레퍼런스 매핑만 실제 샷 시작 1초 전부터 적용합니다. 필드가 없거나 `0`이면 기존 컷 시작 동작을 유지합니다.
- LEAD-IN이 켜진 SHOT에 들어가거나 그 SHOT에서 빠져나갈 때는 이전 카드를 즉시 정리하고, 새 카드는 opacity 혼합 없이 transform 팝만 적용합니다. 일반 컷 전환의 0.35초 크로스페이드는 유지합니다.

검색 키워드: `RED ZONE`, `window.portablePreview`, `JOB_ROOT`, `job_saved`, `export_started`, `export_completed`.

## Hot Debug

1. `current-job/logs/app.log`의 마지막 이벤트를 확인합니다.
2. `current-job/job.json`에서 XML, video, references의 `relativePath`가 실제 파일과 일치하는지 확인합니다.
3. `npm.cmd run check`로 문법, 파서 브리지, 상대 경로 계약을 확인합니다.
4. Electron smoke는 `scripts/run-smoke.cjs`가 OS 임시 폴더에 만든 전용 Job/userData에서 실행해 API와 프리뷰 브리지를 검사합니다. 정상 종료 후 임시 폴더는 0개여야 합니다.
5. `job_read_failed`가 있으면 앱이 원본을 보존하고 기동을 차단합니다. 손상 파일을 별도 보관한 뒤 수동 복구하거나 명시적으로 새 Job을 구성합니다.
6. `job_*_commit_cleanup_deferred` 또는 `job_*_recovery_cleanup_deferred`만 있으면 교체 결과는 확정됐고 임시 transaction 정리만 미뤄진 상태입니다. 앱을 종료해 파일 잠금을 해제한 뒤 다시 시작하면 정리를 재시도하며, 이 상태만으로 Job을 삭제하지 않습니다.
7. `job_write_failed`가 있으면 기존 `job.json`과 `.job.json.<uuid>.tmp`를 모두 보존하고 앱을 종료합니다. 파일 잠금을 해제한 뒤 다시 실행하며 staging을 임의로 `job.json`에 덮어쓰지 않습니다.
8. `STORED_PATH_UNSAFE` 또는 `Current Job path is unsafe`가 나오면 `current-job` 하위의 symlink/junction을 제거하고 실제 폴더와 파일 복사본으로 복구합니다.

주요 이벤트: `app_started`, `second_instance_rejected`, `current_job_reload_requested`, `job_write_failed`, `job_write_cleanup_deferred`, `job_xml_prepared`, `job_xml_mode_selected`, `job_xml_commit_started`, `job_xml_commit_committed`, `job_xml_commit_rollback_*`, `job_xml_recovery_*`, `job_xml_update_started`, `job_xml_update_committed`, `job_reset_started`, `job_reset_committed`, `video_import_prepared`, `video_import_preflight_passed`, `video_import_preflight_failed`, `job_video_commit_*`, `job_video_recovery_*`, `video_imported`, `references_imported`, `job_saved`, `job_mutation_rejected_stale`, `renderer_ready`, `renderer_error`, `export_started`, `export_finalize_failed`, `export_completed`, `export_failed`, `export_cancelled`.

레퍼런스 전환 공백이나 깜빡임은 `positionReferenceDock`, `fadeOutgoingReferences`, `immediatePortableIds`, `.referenceDockItem.leaving` 순서로 확인합니다. 뒤로 이동하거나 리셋할 때 첫 GLOBAL의 0.15초 등장 상태가 복원되는지도 함께 확인합니다.
LEAD-IN이 어긋나면 `job.json`의 대상 SHOT에 `leadInSeconds: 1`이 저장됐는지 확인하고, `portableReferenceShotAtFrame`, `portableShotReferenceStartFrame` 계산을 순서대로 확인합니다.
LEAD-IN 진입·퇴장 카드에 다른 이미지가 섞이면 `leadInTransition`, `lastPortableShotUsedLeadIn`, `clearOutgoingReferences`, `prepareLeadInEntries`, `.leadInEnter` 순서로 확인합니다.
SHOT 클릭이 간헐적으로 레퍼런스를 숨기면 단순 선택 직후 `job_saved`가 기록되는지 확인합니다. 기록된다면 탐색 이벤트가 `wireframechange`를 잘못 발생시킨 것입니다.
EDIT PANEL이 내부 조작 중 닫히면 `previewShell`의 `pointerdown` 대상이 `#editOverlay,#shotRail,#editPanelHandle` guard를 통과하는지 먼저 확인합니다.
레퍼런스 삭제 문제는 `reference_deleted`, `reference_file_delete_failed` 이벤트와 `job.json`에 삭제 ID가 남아 있는지부터 확인합니다. 파일 정리 실패여도 매핑에서는 제거되며, 고아 파일만 수동 정리합니다.

XML 갱신 문제가 생기면 먼저 `job_xml_mode_selected`의 mode와 `jobId`, `revision`을 확인합니다. UPDATE에서는 `timelineShots`, `shotMappings`, `orphanedShotMappings`와 `renderer_xml_update_applied`의 `preserved/newShots/orphaned/ambiguous/reattached`를 대조하고, video/reference 파일 hash가 그대로인지 확인합니다. NEW JOB에서는 source/reference 초기화와 `output`·`logs` 보존을 확인합니다. rollback 실패 이벤트가 있으면 같은 XML을 다시 불러오지 말고 앱 프로세스를 모두 종료합니다. `.job-import-*`와 유효한 primary manifest를 삭제하거나 `.tmp`로 덮지 않은 채 앱을 다시 시작해 `job_xml_recovery_rolled_back`을 확인하고, source/reference 수·경로와 `job.json` SHA-256을 이전 inventory와 대조합니다.

영상 교체 문제가 생기면 `video_import_prepared`, `video_import_preflight_passed` 또는 `video_import_preflight_failed`, `job_video_commit_started`, `job_video_commit_committed` 또는 `job_video_commit_rollback_*` 순서로 확인합니다. preflight 실패에는 commit 이벤트가 없어야 하고 기존 video·Job revision이 그대로여야 합니다. 교체 전 renderer가 media handle을 해제하며, commit 실패 시 이전 video와 `job.json`이 함께 복구되어야 합니다.

익스포트 문제는 `export_started`, `export_encoder_fallback`, `export_finalize_failed`, `export_completed`, `export_failed`, `export_cancelled` 순서와 `.part.mp4` 잔존 여부를 먼저 확인합니다. `export_finalize_failed` 뒤의 part는 완성 파일이므로 삭제하지 말고 앱 종료 후 `.mp4`로 이름을 바꿔 복구합니다.
Export 팝업이 열리지 않으면 `export_dialog_opened` 이벤트와 `export-preload.cjs` 로드 여부를 확인합니다. 진행률이 멈추면 팝업을 반복 실행하지 말고 마지막 `export:progress` 상태와 FFmpeg 로그를 확인합니다.

## Next

- 사용자 최종 Visual QA: 기존 Job 화면과 공개 fixture의 classic 배치·가독성 및 1280×1080 Export 비교
- source beta 공개 후 frame freshness, audio codec fallback, 장시간 render/cancel은 후속 이슈로 관리
- FFmpeg 번들과 실행 파일 패키징은 public binary 단계로 분리
