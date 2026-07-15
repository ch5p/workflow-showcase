# Project Map

## App

- `main.cjs`: Electron 창, 파일 선택, XML UPDATE/NEW JOB 선택 경계, 포터블 복사, `job.json` CAS 저장, 앱 로그
- `preload.cjs`: 화면에 노출하는 최소 로컬 파일 API와 XML/video/reference drop용 제한 IPC
- `job-lifecycle.cjs`: XML UPDATE/NEW JOB의 prepare/commit/rollback/crash recovery와 Windows-safe staged replace
- `video-lifecycle.cjs`: source video 교체의 prepare/commit/rollback/crash recovery와 Windows-safe staged replace
- `timeline-reconcile.cjs`: 익명 SHOT descriptor 1:1 재매칭과 orphan 보존
- `export-preload.cjs`: Export 팝업에만 노출하는 시작·취소·진행·폴더 열기 API
- `exporter.cjs`: offscreen BGRA 프레임 수집, FFmpeg H.264/AAC 출력, 진행률·취소·fallback
- `src/index.html`: 편집 화면과 SHOT 레일
- `src/mvp-app.js`: 편집 화면, Job 저장소, 출력 프리뷰 연결
- `src/output-preview.html`: 기존 FCP XML 파서와 1280x1080 출력 프리뷰 복사본
- `src/export-dialog.html`, `src/export-dialog.js`: 저장된 제목과 렌더 사양 확인, 진행률과 완료 경로를 표시하는 독립 Export 창

## Current Job Contract

- `current-job/job.json`: 레퍼런스와 SHOT 매핑의 기준 파일
- `jobId`, `revision`: 새 Job identity와 같은 Job 안의 변경 세대. 모든 renderer mutation은 자신이 읽은 두 값을 보내며 Main은 하나라도 다른 stale save를 거부
- `projectTitle`: 편집 패널에서 입력 즉시 미리보기에 반영되고 자동 저장되는 최대 40자의 선택 필드. 필드가 없으면 `SEEDANCE 2.0`, 명시적인 빈 문자열은 빈 제목으로 사용
- `callout`: `enabled`, `position`, `style`, `startSeconds`, `durationSeconds`, `subtitle`을 가진 선택 필드이며 출력 미리보기와 offscreen 렌더가 동일하게 사용
- `shotMappings.<shotId>`: 기존 `mode`, `refs`에 선택 필드 `leadInSeconds: 1`을 추가할 수 있으며, 없으면 `0`으로 처리
- `timelineShots`: 원본 이름·경로 없이 `identityKey`, `nameKey`, timeline/source in-out occurrence만 저장하는 재매칭 descriptor
- `orphanedShotMappings`: 새 타임라인과 확실히 1:1 매칭되지 않은 기존 매핑. `descriptor`, `mapping`, `reason`만 저장하며 다음 UPDATE에서 다시 연결 가능
- `current-job/source/timeline.xml`: 앱으로 가져온 XML
- `current-job/source/video.*`: 앱으로 가져온 완성본 영상
- `current-job/references/`: 이미지·영상 레퍼런스 복사본
- `current-job/output/`: `character_workflow_export_*.mp4`와 QA 산출물
- `current-job/logs/app.log`: 진단 이벤트 JSONL

모든 저장 경로는 앱 폴더 기준 상대 경로입니다. 내부 식별자와 JSON key는 변경하지 않습니다.

## Import Contract

- `LOAD XML` 버튼과 XML drop은 같은 prepare/commit 경로를 사용하며 후보 검증 뒤 `타임라인만 업데이트`(기본), `새 Job으로 불러오기`, `취소`를 표시합니다.
- 선택 취소, 파일 선택 취소, 검증 실패에서는 기존 `job.json`, source, references를 변경하지 않습니다.
- UPDATE는 `source/timeline.xml`만 교체하고 video/reference/GLOBAL/title/callout/`ui`/`output`을 보존합니다. exact source identity를 우선하며 unique name + source range/occurrence 증거가 있을 때만 fallback하고, ambiguous/unmatched 매핑은 orphan으로 보관합니다.
- NEW JOB은 명시 선택 시에만 source XML/video와 reference 파일을 정리하고 `references`, `globalReferenceIds`, 이전 `shotMappings`·orphan, `projectTitle`, `callout`을 초기화합니다. `timelineShots`에는 새 XML의 익명 descriptor를 저장하며, `current-job/output/`, `current-job/logs/`, 기존 `ui`, `output`은 보존합니다.
- `LOAD VIDEO` 버튼과 video drop은 같은 2단계 transaction을 사용합니다. candidate 준비 뒤 renderer media handle을 해제하고 Main이 기존 video/Job backup, 교체, rollback을 담당합니다.
- 모든 mutation은 `jobId + revision`을 비교하므로 XML UPDATE와 NEW JOB 뒤 도착한 이전 debounce 저장이 현재 상태를 덮어쓰지 못합니다.
- XML/video transaction은 Windows rename 잠금 오류를 4회 재시도하고, 지속 실패 시 durable copy·fsync·SHA-256 검증으로 manifest와 Job 파일을 교체합니다. 유효한 primary manifest가 항상 기준이며 primary가 없거나 손상된 경우에만 staging manifest를 사용합니다.
- 잠긴 고정 staging 파일은 UUID staging으로 우회합니다. rollback 완료 marker도 UUID staging에 fsync한 뒤 검증 교체하고 `state: rolled_back`를 기록합니다. marker 이전 중단은 `moved` inventory와 backup 잔존 여부로 candidate 제거를 멱등 재실행합니다. transaction 정리는 fallback을 primary로 복구한 뒤 staging과 backup/candidate를 지우고 primary manifest를 마지막에 삭제합니다. `prepared`/`committed`/`rolled_back` transaction의 일시적 정리 실패는 `deferred`로 기록하고 현재 Job mutation과 Export를 차단하지 않습니다.
- `backup/job.json` 복원 권한은 durable manifest의 `hadJob: true`입니다. `hadJob: null`인 초기 backup crash에서는 final backup 파일이 보여도 live Job은 아직 untouched이므로 현재 `job.json`을 유지합니다.

## Test Fixtures

- `fixtures/premiere-export-kit/media/`: 실제 Premiere Sequence를 만드는 중립 소스 카드 5개
- `fixtures/premiere-export-kit/PREMIERE_EXPORT_GUIDE.md`: 24 fps, 12초 fixture 제작·내보내기 절차
- `fixtures/premiere-export-kit/public-fixture/`: 공개 정리를 마친 실제 Premiere `xmeml`과 같은 Sequence의 최종 MP4
- `fixtures/premiere-export-kit/public-fixture/SOURCE_NOTES.md`: 출처, 정리 내역, 검증 contract, SHA-256 기록

Premiere가 처음 만든 raw XML과 원본 첨부 파일은 Git에 추가하지 않습니다. `tests/fixtures/`를 추가할 때는 실제 Premiere 통합 fixture를 복제하지 않고, 손작성 `xmeml` edge case와 Job 단위 fixture만 둡니다.

현재 smoke는 실제 앱 폴더가 아닌 임시 앱 복사본에서 `PORTABLE_SMOKE_XML`로 공개 XML을 읽어 실행합니다. MP4 자동 fixture 연결은 명시적인 test-only Job root가 생긴 뒤 추가합니다.

Lifecycle 회귀 검사는 OS 임시 Job root에서만 실행하며 manifest/Job backup/install/restore의 지속적 `EPERM`, 유효 primary + 오래된 `.tmp`, 손상 primary + 유효 UUID fallback, 잠긴 고정 staging 우회, rollback 뒤 cleanup 중단, 이전 timeline/video가 없던 candidate 설치 중단, marker 기록 실패 뒤 재복구, 정상 `.partial` + 잘린 Job backup final, 동일 Job 해시 교체 생략을 강제로 검증합니다. 실제 `current-job` 접근은 guard로 실패시킵니다.

## Contract 확인

- 문서 기준: 위 `current-job` 구조, `job.json` version 1, `jobId + revision`, UPDATE/NEW JOB Import Contract
- 실제 샘플: Premiere Pro 2026 fixture의 24 fps, 288 frames, 반복 source identity와 앱의 격리 smoke 결과 5 EDITS/4 SHOTS. 실패 transaction 실복구에서 source 2개/reference 11개/기존 Job의 파일별 SHA-256 일치를 확인
- 코드 가정: `main.cjs`의 `JOB_ROOT`, XML/video lifecycle, timeline reconcile, CAS guard와 `hydrateJob()`이 같은 구조를 읽음
- 불일치 여부: 없음
- 처리 방식: 구조 변경 시 문서, 실제 샘플, 코드 세 곳을 함께 확인
