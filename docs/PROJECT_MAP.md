# Project Map

## App

- `main.cjs`: Electron 창, 파일 선택, 포터블 복사, `job.json` 저장, 앱 로그
- `preload.cjs`: 화면에 노출하는 최소 로컬 파일 API
- `export-preload.cjs`: Export 팝업에만 노출하는 시작·취소·진행·폴더 열기 API
- `exporter.cjs`: offscreen BGRA 프레임 수집, FFmpeg H.264/AAC 출력, 진행률·취소·fallback
- `src/index.html`: 편집 화면과 SHOT 레일
- `src/mvp-app.js`: 편집 화면, Job 저장소, 출력 프리뷰 연결
- `src/output-preview.html`: 기존 FCP XML 파서와 1280x1080 출력 프리뷰 복사본
- `src/export-dialog.html`, `src/export-dialog.js`: 저장된 제목과 렌더 사양 확인, 진행률과 완료 경로를 표시하는 독립 Export 창

## Current Job Contract

- `current-job/job.json`: 레퍼런스와 SHOT 매핑의 기준 파일
- `projectTitle`: 편집 패널에서 입력 즉시 미리보기에 반영되고 자동 저장되는 최대 40자의 선택 필드. 필드가 없으면 `SEEDANCE 2.0`, 명시적인 빈 문자열은 빈 제목으로 사용
- `callout`: `enabled`, `position`, `style`, `startSeconds`, `durationSeconds`, `subtitle`을 가진 선택 필드이며 출력 미리보기와 offscreen 렌더가 동일하게 사용
- `shotMappings.<shotId>`: 기존 `mode`, `refs`에 선택 필드 `leadInSeconds: 1`을 추가할 수 있으며, 없으면 `0`으로 처리
- `current-job/source/timeline.xml`: 앱으로 가져온 XML
- `current-job/source/video.*`: 앱으로 가져온 완성본 영상
- `current-job/references/`: 이미지·영상 레퍼런스 복사본
- `current-job/output/`: `character_workflow_export_*.mp4`와 QA 산출물
- `current-job/logs/app.log`: 진단 이벤트 JSONL

모든 저장 경로는 앱 폴더 기준 상대 경로입니다. 내부 식별자와 JSON key는 변경하지 않습니다.

## Contract 확인

- 문서 기준: 위 `current-job` 구조와 `job.json` version 1
- 실제 샘플: 앱 최초 실행 시 같은 구조와 `job.json`이 생성됨
- 코드 가정: `main.cjs`의 `JOB_ROOT`와 `hydrateJob()`이 같은 구조를 읽음
- 불일치 여부: 없음
- 처리 방식: 구조 변경 시 문서, 실제 샘플, 코드 세 곳을 함께 확인
