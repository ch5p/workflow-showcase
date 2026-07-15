# Character Workflow Portable

Premiere Pro에서 내보낸 legacy Final Cut Pro 7 XML (xmeml)과 완성본 영상을 이용해, SHOT별 레퍼런스 맵이 포함된 1280 × 1080 H.264 영상을 만드는 Windows용 Electron 소스 베타입니다.

현재 공식 레이아웃은 classic 하나입니다. 16:9, 9:16, 1:1을 자동으로 지원하지 않으며, 필요한 사람은 안정 코어를 유지한 채 classic presentation과 render spec을 포크하여 수정할 수 있습니다.

## Beta scope

- 지원: xmeml sequence와 video-track timing
- 주 검증 환경: Adobe Premiere Pro 2026 v26.2.2 (Build 3)의 Final Cut Pro XML export
- 출력: 1280 × 1080, 60 fps, H.264, 12 Mbps
- 저장: current-job 폴더 안의 상대경로 기반 단일 Job
- 배포 형태: Windows source beta
- 미지원: modern FCPXML, CapCut 프로젝트, Premiere 효과·마스크 재현

자세한 경계는 [XML Compatibility](docs/XML_COMPATIBILITY.md)를 확인하세요.

## Requirements

- Windows 10 또는 11
- Node.js 22.12 이상
- npm
- FFmpeg가 PATH에 등록되어 있거나 프로젝트의 ffmpeg/ffmpeg.exe에 존재해야 Export 가능

이 저장소는 FFmpeg 바이너리를 포함하지 않습니다.

## Quick start

    npm.cmd ci
    npm.cmd start

또는 설치 후 START_APP.cmd를 실행할 수 있습니다.

처음 검수할 때는 다음 공개 fixture를 사용하세요.

- XML: fixtures/premiere-export-kit/public-fixture/premiere-synthetic.xml
- Video: fixtures/premiere-export-kit/public-fixture/premiere-synthetic-final.mp4

앱에서 XML을 드롭하고 NEW JOB을 선택한 다음 같은 fixture의 MP4를 드롭합니다. 기대 결과는 24 fps, 12초, 5 EDITS, 4 SHOTS이며 PRIMARY 순서는 A → D → B → A → C입니다.

## Job safety

LOAD XML에는 두 목적이 있습니다.

- UPDATE XML: 기존 영상, 레퍼런스, GLOBAL/SHOT 매핑, 제목과 출력 설정을 유지하고 타임라인만 갱신합니다.
- NEW JOB: 사용자가 명시적으로 선택했을 때만 source, video, references, mappings, title, callout을 초기화합니다.

Job은 current-job 아래에 저장됩니다. 앱 폴더 전체를 복사하면 내부 상대경로를 이용해 다른 위치에서도 다시 열 수 있습니다. current-job의 사용자 데이터는 Git에서 제외됩니다.

## Tests

모든 자동 검사는 실제 current-job 대신 OS 임시 폴더를 사용합니다.

    npm.cmd run check
    npm.cmd run smoke
    npm.cmd run smoke:export

smoke:export는 FFmpeg가 필요하며 1초짜리 임시 출력만 생성합니다. 임시 Job과 출력은 검사 종료 후 삭제됩니다.

## Customizing

- 고정 출력 크기·fps·bitrate: render-spec.cjs
- classic 디자인 토큰: src/layouts/classic/tokens.css
- classic 배치와 스타일: src/layouts/classic/classic.css
- 파서와 PRIMARY 계산: src/core/ — 레이아웃 작업에서 수정하지 않음

새 화면비를 만드는 방법과 안전선을 [CUSTOMIZING.md](CUSTOMIZING.md)와 [Classic Layout](docs/CLASSIC_LAYOUT.md)에 정리했습니다.

## Known limitations

- XML은 편집 구조 데이터이며 Premiere의 필터, 좌우 반전, Transform, Crop, mask, keyframe, 색보정 등을 재현하지 않습니다.
- transition은 일부 경계 계산에만 사용하며 시각 효과를 렌더링하지 않습니다.
- final visual truth는 XML이 아니라 함께 불러온 완성본 영상입니다.
- editor UI는 반응형 제품 UI가 아니며 classic 출력은 1280 × 1080 하나만 제공합니다.
- 현재 source beta는 Windows에서만 검증했습니다.
- frame-accurate mastering tool이 아니며 부하가 큰 환경에서는 중복 paint frame이 생길 수 있습니다.

## Contributing and security

기여 절차는 [CONTRIBUTING.md](CONTRIBUTING.md), 보안 제보는 [SECURITY.md](SECURITY.md)를 확인하세요.

## License

코드와 저장소에 포함된 synthetic fixture는 별도 표기가 없는 한 [MIT License](LICENSE)를 따릅니다. Adobe, Premiere Pro, Final Cut Pro, CapCut은 각 소유자의 상표이며 이 프로젝트는 해당 회사들과 제휴하지 않습니다.
