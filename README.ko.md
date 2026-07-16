# Workflow Showcase

[`English →`](./README.md) · `한국어`

Premiere Pro에서 내보낸 legacy Final Cut Pro 7 XML(xmeml)과 완성본 영상을 이용해, SHOT별 레퍼런스 맵이 포함된 1280 × 1080 H.264 쇼케이스 영상을 만드는 Windows용 Electron 소스 베타입니다.

현재 공식 레이아웃은 classic 하나입니다. 16:9, 9:16, 1:1을 자동으로 지원하지 않으며, 필요한 사람은 안정 코어를 유지한 채 classic presentation과 render spec을 포크하여 수정할 수 있습니다.

## 왜 만들었나 · 이렇게 써주세요

> [여기 직접 채우기 — 당신 말투로. 이 프로젝트를 왜 만들었는지, 어떤 사람이 쓰면 좋은지, 뭘 해줬으면 하는지.]
>
> 예시 뼈대(지우고 새로 써도 됨):
> - AI 영상(예: 시댄스)으로 만든 결과물을, 별다른 후작업 없이 "워크플로우가 얹힌 쇼케이스"로 뚝딱 만들고 싶어서 만들었습니다.
> - 코드를 몰라도 됩니다. 콜아웃·레퍼런스·컷 판때기를 자기 취향대로 바꾸는 건 코덱스/클로드 같은 LLM에게 맡기면 됩니다. 그 방법은 [AI로 커스터마이징하기](docs/CUSTOMIZING_WITH_AI.ko.md)에 정리해뒀습니다.
> - 이렇게 써주면 좋겠습니다: [여기 직접]

## Beta 범위

- 지원: xmeml sequence와 video-track timing
- 주 검증 환경: Adobe Premiere Pro 2026 v26.2.2 (Build 3)의 Final Cut Pro XML export
- 기본 출력: 1280 × 1080, 60 fps, H.264, 12 Mbps
- 저장: current-job 폴더 안의 상대경로 기반 단일 Job
- 배포 형태: Windows source beta
- 미지원: modern FCPXML, CapCut 프로젝트, Premiere 효과·마스크 재현

자세한 경계는 [XML Compatibility](docs/XML_COMPATIBILITY.md)를 확인하세요.

## 준비물

- Windows 10 또는 11
- Node.js 22.12 이상
- npm
- FFmpeg — Export에 필요. WinGet을 사용할 수 있다면 아래 한 줄로 설치할 수 있습니다.

이 저장소는 FFmpeg 바이너리를 포함하지 않습니다. WinGet이 설치된 Windows 10/11에서는 명령 프롬프트나 PowerShell에 아래를 복붙하세요. 설치가 낯설면 이 명령어를 그대로 LLM에게 "실행해줘"라고 해도 됩니다.

    winget install -e --id Gyan.FFmpeg

설치 후 앱을 완전히 종료했다가 다시 실행하면 PATH에서 자동으로 찾습니다. 직접 받은 `ffmpeg.exe`를 프로젝트의 `ffmpeg/` 폴더에 넣어도 됩니다.

## 빠른 시작

    npm.cmd ci
    npm.cmd start

또는 설치 후 `START_APP.cmd`를 실행할 수 있습니다.

처음 실행하면 다음 공개 fixture가 재생 가능한 `SAMPLE JOB`으로 자동 열립니다.

- XML: `fixtures/premiere-export-kit/public-fixture/premiere-synthetic.xml`
- Video: `fixtures/premiere-export-kit/public-fixture/premiere-synthetic-final.mp4`

샘플은 24 fps, 12초, 5 EDITS, 4 SHOTS이며 PRIMARY 순서는 A → D → B → A → C입니다. 자기 프로젝트를 시작하려면 상단 `XML` 존을 클릭하거나 XML을 드롭하세요. 유효한 XML은 일회용 샘플을 자동으로 새 Job으로 교체하며, 이어 상단 `VIDEO` 존에서 같은 시퀀스의 완성본 영상을 불러오면 됩니다. 기존 일반 Job에서는 안전한 UPDATE XML / NEW JOB 선택창이 그대로 표시됩니다.

## Job 안전성

- 앱은 한 번에 한 프로세스만 Current Job을 열며, 두 번째 실행은 기존 창으로 돌아갑니다.
- 일반 `job.json` 저장도 고유 staging 파일을 fsync한 뒤 Windows 파일 잠금을 재시도합니다. 교체가 끝내 실패하면 기존 Job과 완성 staging을 모두 보존합니다.
- `current-job` 내부 symlink/junction은 외부 파일 읽기·삭제·출력 이탈을 막기 위해 허용하지 않습니다.
- UPDATE XML: 기존 영상, 레퍼런스, GLOBAL/SHOT 매핑, 제목과 출력 설정을 유지하고 타임라인만 갱신합니다.
- NEW JOB: 사용자가 명시적으로 선택했을 때만 source, video, references, mappings, title, callout을 초기화합니다. 단, 최초 실행용 샘플은 예외이며 첫 번째 유효한 사용자 XML이 일회용 샘플을 자동으로 교체합니다.
- 영상은 Electron이 metadata와 첫 프레임을 실제로 읽은 뒤에만 Current Job에 반영합니다.
- 렌더 완료 후 최종 파일명 교체가 실패하면 완성된 `.part.mp4`를 삭제하지 않습니다.

Job은 `current-job` 아래에 저장됩니다. 앱 폴더 전체를 복사하면 내부 상대경로를 이용해 다른 위치에서도 다시 열 수 있습니다. `current-job`의 사용자 데이터는 Git에서 제외됩니다.

## 테스트

회귀 fixture와 smoke 실행은 실제 `current-job` 대신 OS 임시 폴더를 사용합니다. `check`는 테스트가 사용자 Job을 바꾸지 않았는지 확인하기 위해 실행 전후 `current-job/job.json`의 SHA-256만 로컬에서 비교하며, 내용을 출력하거나 수정하지 않습니다.

    npm.cmd run check
    npm.cmd run smoke
    npm.cmd run smoke:export

`smoke:export`는 FFmpeg가 필요하며 1초짜리 임시 출력을 만든 뒤 삭제합니다. 시각 검수는 실제 앱의 `EXPORT H.264`로 별도 출력한 파일을 확인하세요.

## 커스터마이징

- 고정 출력 width/height와 기본 fps/bitrate: `render-spec.cjs`
- classic 공통 색상·글꼴 토큰: `src/layouts/classic/tokens.css`
- classic 배치, 영역별 크기와 스타일: `src/layouts/classic/classic.css`
- 파서와 PRIMARY 계산: `src/core/` — 레이아웃 작업에서 수정하지 않음

코드를 몰라도 LLM으로 바꾸는 방법은 [AI로 커스터마이징하기](docs/CUSTOMIZING_WITH_AI.ko.md)에, 새 화면비 포크와 안전선은 [CUSTOMIZING.ko.md](CUSTOMIZING.ko.md)와 [Classic Layout](docs/CLASSIC_LAYOUT.md)에 정리했습니다.

## 알려진 한계

- XML은 편집 구조 데이터이며 Premiere의 필터, 좌우 반전, Transform, Crop, mask, keyframe, 색보정 등을 재현하지 않습니다. 조정 레이어는 타임라인 내용으로 노출하지 않고 EDIT/SHOT 계산 전에 제외합니다.
- transition은 일부 경계 계산에만 사용하며 시각 효과를 렌더링하지 않습니다.
- final visual truth는 XML이 아니라 함께 불러온 완성본 영상입니다.
- editor UI는 반응형 제품 UI가 아니며 classic 출력은 1280 × 1080 하나만 제공합니다.
- 현재 source beta는 Windows에서만 검증했습니다.
- frame-accurate mastering tool이 아니며 부하가 큰 환경에서는 중복 paint frame이 생길 수 있습니다.
- UPDATE XML에서 명확히 연결되지 않은 SHOT 매핑은 다음 UPDATE를 위해 보존되지만, 이 beta에는 이를 목록으로 보거나 수동 재연결·개별 삭제하는 화면이 없습니다.
- Export는 원본 오디오를 변환하지 않고 복사합니다. MP4와 호환되지 않는 오디오 코덱을 가진 일부 MOV/M4V는 Export가 실패할 수 있습니다.
- 영상·레퍼런스 가져오기는 복사 진행률이나 사전 여유 공간 확인을 제공하지 않습니다. 매우 큰 파일은 멈춘 것처럼 보이거나 공간 부족으로 실패할 수 있습니다.

## 기여와 보안

기여 절차는 [CONTRIBUTING.md](CONTRIBUTING.md), 보안 제보는 [SECURITY.md](SECURITY.md)를 확인하세요.

## 라이선스

코드와 저장소에 포함된 synthetic fixture는 별도 표기가 없는 한 [MIT License](LICENSE)를 따릅니다. Adobe, Premiere Pro, Final Cut Pro, CapCut은 각 소유자의 상표이며 이 프로젝트는 해당 회사들과 제휴하지 않습니다.
