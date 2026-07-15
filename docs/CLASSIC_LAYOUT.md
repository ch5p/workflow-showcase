# Classic Layout

classic은 공개 베타가 공식 제공하는 유일한 출력 레이아웃입니다.

## Render contract

- Canvas: 1280 × 1080
- Output FPS: 60
- Raw input: BGRA
- Output pixel format: yuv420p
- Color: bt709
- Video bitrate: 12 Mbps
- Preferred encoder: h264_nvenc
- Fallback encoder: libx264
- Container: MP4 with fast start

기본값의 단일 소스는 render-spec.cjs입니다. editor fit, Export summary, offscreen BrowserWindow, paint 검사와 FFmpeg 입력이 같은 spec을 사용합니다.

## Presentation files

- src/layouts/classic/tokens.css: 색과 typography
- src/layouts/classic/classic.css: canvas와 영역 배치
- src/output-preview.html: named presentation regions와 preview runtime

주요 영역은 video, callout, references, timeline, overview입니다. CSS와 해당 DOM은 presentation surface이며 src/core의 parser와 timeline 계산은 presentation이 아닙니다.

## Visual QA

자동 smoke는 구조와 브리지만 확인합니다. 레이아웃 변경 후에는 공개 fixture로 다음을 직접 봅니다.

- 2–5초에 OVERLAY D가 보임
- 7–8초에 disabled E가 보이지 않고 CLIP A가 보임
- PRIMARY가 A → D → B → A → C
- 제목과 callout이 video 위에서 읽힘
- reference card와 timeline이 잘리지 않음
- Export MP4가 1280 × 1080이며 preview와 같은 배치
