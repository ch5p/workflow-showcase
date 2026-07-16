# Customizing

[`English →`](./CUSTOMIZING.md) · `한국어`

이 프로젝트는 여러 레이아웃을 런타임에서 선택하는 제품이 아닙니다. 공식 베타는 classic 1280 × 1080 하나를 제공하며, 다른 화면비가 필요한 기여자는 포크에서 자신의 고정 레이아웃을 설계합니다.

> 코드를 직접 보지 않고 LLM(코덱스·클로드 등)에게 시켜서 바꾸고 싶다면 [AI로 커스터마이징하기](docs/CUSTOMIZING_WITH_AI.ko.md)를 먼저 보세요.

## Safe customization surface

레이아웃 작업에서 먼저 보는 파일은 세 곳입니다.

- `render-spec.cjs`: 고정 canvas width/height와 output fps/bitrate 기본값
- `src/layouts/classic/tokens.css`: 공통 색상, 글꼴, 그림자 토큰
- `src/layouts/classic/classic.css`: video, callout, references, timeline, overview 배치와 영역별 고정값

기존 Job의 `output.fps`와 `output.bitrateMbps`가 코드 기본값을 덮어쓸 수 있습니다. 화면비 포크에서는 기본적으로 width/height만 바꾸고, fps/bitrate 변경은 별도의 Export 계약 변경으로 취급하세요.

HTML 영역은 `src/output-preview.html`에서 다음 ID로 찾을 수 있습니다.

- `videoZone`
- `videoCallout`
- `referenceCard`와 `referenceDock`
- `timelineSection`과 `timelineViewport`
- `overviewTimeline`
- `stage`

## Stable core

다음 파일은 presentation 변경을 위해 수정하지 않습니다.

- `src/core/xmeml-parser.js`
- `src/core/primary-timeline.js`
- `src/core/shot-model.js`
- `src/core/reference-mapping.js`
- `timeline-reconcile.cjs`
- `job-lifecycle.cjs`
- `video-lifecycle.cjs`

특히 XML parser, SHOT identity, reference mapping 의미, Job 상대경로, IPC, Export 취소와 encoder fallback은 안정 코어입니다.

## Making a fixed aspect-ratio fork

1. 먼저 `npm.cmd run check`와 `npm.cmd run smoke`를 통과시킵니다.
2. `render-spec.cjs`의 classic width와 height를 포크의 고정값으로 바꿉니다.
3. `classic.css`에서 stage, videoZone, panel, reference, timeline 영역을 새 canvas에 맞게 직접 배치합니다.
4. editor fit과 Export summary가 같은 render spec을 표시하는지 확인합니다.
5. 공개 fixture를 불러와 같은 5 EDITS와 4 SHOTS가 유지되는지 확인합니다.
6. `npm.cmd run smoke:export`로 자동 Export 경로를 검사합니다.
7. 실제 앱의 `EXPORT H.264`로 영상을 내보내 결과 MP4의 크기와 가독성을 직접 검수합니다.

이 작업은 모바일 가독성이나 정보 밀도를 자동으로 보장하지 않습니다. 16:9, 9:16, 1:1, 4:5는 각각 별도의 디자인 문제입니다.

## Callout contract

기존 Job의 callout 필드는 다음 의미를 유지합니다.

- `enabled`
- `position`
- `style`
- `startSeconds`
- `durationSeconds`
- `subtitle`

선택 필드를 추가할 때는 기존 Job이 같은 결과로 열리도록 기본값을 제공해야 합니다. 외부 텍스트는 `innerHTML`이 아니라 `textContent`로 삽입해야 합니다.

## Do not add yet

실제 공식 레이아웃이 두 개 이상 필요해지기 전에는 다음 구조를 추가하지 않습니다.

- runtime preset selector
- layout registry
- plugin framework
- Job layout ID
- width와 height 사용자 입력 UI
