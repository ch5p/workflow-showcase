# Classic Layout

classic is the only output layout officially provided by the public beta.

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

The single source for these defaults is `render-spec.cjs`. The editor fit, Export summary, offscreen BrowserWindow, paint check, and FFmpeg input all use the same spec.

## Presentation files

- `src/layouts/classic/tokens.css`: color and typography
- `src/layouts/classic/classic.css`: canvas and region placement
- `src/output-preview.html`: named presentation regions and the preview runtime

The main regions are video, callout, references, timeline, and overview. The CSS and its DOM are the presentation surface; the parser and timeline calculation in `src/core` are not presentation.

## Local edit map

- Callout shell: `#videoCallout`, `.videoCalloutRule`, `.videoCalloutCopy`, `.videoCalloutEyebrow`, `#videoCalloutTitle`, `.videoCalloutMeta`, and the position/style data selectors in `classic.css`
- Reference shell: `#referenceCard`, `#referenceDock`, `.referenceDockItem`, and `.referenceDockLabel` in `classic.css`
- Timeline and overview: `#timelineSection`, `#timelineViewport`, and `#overviewTimeline` in `classic.css`
- Fixed-layout panel height: `CONFIG.panelHeight`, `applyLayout()`, and `fitScale()` in `src/output-preview.html`; these write an inline panel height and must be considered in a fixed-aspect-ratio fork
- Reference packing only: `positionReferenceDock()` currently computes the `72`–`176` px item width, `8` px gap assumption, `--reference-item-width`, and `visibleCount > 6` crop state

Do not rewrite `positionReferenceDock()` for a visual change. Its surrounding logic also owns LEAD-IN, crossfade, visible-reference selection, and ghost-card cleanup. Do not change `updateVideoCallout()`, the playback clock, parser bridge, or `src/core` for presentation work.

If a request says “keep classic and add another layout,” stop and clarify whether it means replacing classic in a fixed fork, making a separate non-runtime experiment, or deliberately adding a second official runtime layout. The latter two are architecture decisions, not ordinary CSS work.

## Visual QA

Automated smoke only checks structure and bridges. After a layout change, inspect the following with the public fixture:

- OVERLAY D is visible at 2–5 seconds
- disabled E is not visible and CLIP A is visible at 7–8 seconds
- PRIMARY is A → D → B → A → C
- the title and callout are legible over the video
- reference cards and the timeline are not clipped
- the Export MP4 is 1280 × 1080 with the same layout as the preview
