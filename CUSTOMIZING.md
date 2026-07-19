# Customizing

`English` · [`한국어 →`](./CUSTOMIZING.ko.md)

This project is not a product that selects layouts at runtime. The official beta ships one layout, classic 1280 × 1080. If you need a different aspect ratio, design your own fixed layout in a fork.

> If you want to change things through an LLM (Codex, Claude, etc.) without reading code, start with [Customizing with AI](docs/CUSTOMIZING_WITH_AI.md).

## Safe customization surface

For layout work, start with these three files:

- `render-spec.cjs`: fixed canvas width/height and default output fps/bitrate
- `src/layouts/classic/tokens.css`: shared color, font, and shadow tokens
- `src/layouts/classic/classic.css`: placement and region-specific values for video, callout, references, timeline, and overview

An existing Job's `output.fps` and `output.bitrateMbps` can override the code defaults. For an aspect-ratio fork, normally change only width/height; treat fps or bitrate changes as a separate Export-contract change.

You can find the HTML regions in `src/output-preview.html` by these IDs:

- `videoZone`
- `videoCallout`
- `referenceCard` and `referenceDock`
- `timelineSection` and `timelineViewport`
- `overviewTimeline`
- `stage`

### Narrow presentation runtime seams

Two visual requests also have narrow JavaScript-owned presentation values in `src/output-preview.html`:

- Fixed aspect ratio: `CONFIG.panelHeight`, `applyLayout()`, and `fitScale()` write the panel height and resolved canvas size. Account for them together with `render-spec.cjs` and `classic.css`.
- Reference-card size/density: `positionReferenceDock()` calculates the `72`–`176` px card width, `8` px gap assumption, `--reference-item-width`, and the `visibleCount > 6` crop state.
- Edit display: `EDIT DISPLAY` groups `NUMBER TICKER` (`editNumberTicker`, `false` by default) and `REFERENCE 3D POP` (`referenceMotion`, `classic` by default). The ticker changes only the EDIT-number transition. `referenceMotion` selects the `classic` or `pop3d` presentation in `classic.css`; both reference motions deliberately share the same hidden-to-visible trigger, stagger, LEAD-IN, replacement, and cleanup path in `output-preview.html`. Customize the scoped keyframes without splitting that timing path.

Treat only those values as presentation plumbing. Do not rewrite `positionReferenceDock()` or alter visible-reference selection, LEAD-IN, crossfade, ghost-card cleanup, the playback clock, or parser/core behavior.

## INTRO pre-roll customization surface

The top `INTRO` launcher opens a separate sandboxed `INTRO BUILDER`; it does not replace or modify the normal `EXPORT H.264` workflow. The safe visual surface is the shared `src/intro-preroll.html`, which is used by both the builder preview and the offscreen intro render. Change scene layout, typography, color, and deterministic animation there so preview and output stay identical. Keep the fixed question `What should we get done?`, project `Project None`, model `5.6 Sol`, and effort `High` unless the request explicitly changes that contract.

The only persisted scene settings are the optional top-level `introPreroll.prompt`, `introPreroll.reply`, `introPreroll.typingSeconds` (`1` or `2`), and `introPreroll.soundEnabled` boolean. Missing `soundEnabled` defaults to `true` for older Jobs. After a successful normal Export, Main records only its app-owned output filename, Job ID, size, and modification time in `current-job/logs/last-showcase-export.json`; the controller may restore that exact file after restart only when every field still matches. Manual selections outside the app-owned `output/` folder remain session-only. Do not scan for the newest modified file or persist a selected Export absolute path, background path, or audio asset path.

After changing the INTRO controller or concat boundary, run `npm.cmd run smoke:intro`. It uses isolated temporary media and a fake capture surface to exercise the real FFmpeg normalization, stream-copy concat, verification, cancel, and cleanup path without reading `current-job`.

`src/assets/intro-click.wav` and `src/assets/intro-keyboard.wav` are sanitized, app-owned sounds. The shared scene derives a bounded deterministic key-event schedule from the visible prompt; preview playback and the controller-rendered audio must consume that same schedule. Keep asset lookup, source selection, FFmpeg execution, H.264 stream-copy, AAC normalization, TS concat, verification, cancel, and atomic finalization in `intro-demo-controller.cjs`. The intro is re-rendered; the selected main Export is not re-rendered or modified.

## Stable core

Do not modify these files for presentation changes:

- `src/core/xmeml-parser.js`
- `src/core/primary-timeline.js`
- `src/core/shot-model.js`
- `src/core/reference-mapping.js`
- `src/core/duration-math.js`
- `timeline-reconcile.cjs`
- `persisted-timeline-state.cjs`
- `job-lifecycle.cjs`
- `video-lifecycle.cjs`
- `reference-lifecycle.cjs`
- `storage-policy.cjs`
- `intro-demo-controller.cjs`

In particular, the XML parser, SHOT identity, reference mapping semantics, one-frame DURATION threshold, Job relative paths, import storage policy, IPC, normal Export cancel / encoder fallback, and INTRO source/concat/finalization controller are the stable core.

## Making a fixed aspect-ratio fork

1. First make `npm.cmd run check` and `npm.cmd run smoke` pass.
2. Change the classic width and height in `render-spec.cjs` to your fork's fixed values.
3. In `classic.css`, re-lay-out the stage, videoZone, panel, reference, and timeline regions for the new canvas. Also update the presentation-only `CONFIG.panelHeight` used by `applyLayout()` and `fitScale()` in `src/output-preview.html`; its inline height otherwise overrides ordinary CSS.
4. Confirm the editor fit and the Export summary show the same render spec.
5. Load the public fixture and confirm the same 5 EDITS and 4 SHOTS hold.
6. Run `npm.cmd run smoke:export` to verify the automated Export path.
7. Export through the real app's `EXPORT H.264` control and inspect the resulting MP4's size and legibility yourself.

This does not automatically guarantee mobile legibility or information density. 16:9, 9:16, 1:1, and 4:5 are each separate design problems.

## Callout contract

The callout fields of an existing Job keep these meanings:

- `enabled`
- `position`
- `style`: `line`, `label`, `minimal`, or `viewfinder`; absent or unknown values use `line`
- `motion`: `fade`, `mask`, `type`, `decode`, or `glitch`; absent or unknown values use `fade`
- `startSeconds`
- `durationSeconds`
- `subtitle`

`TYPE` and `DECODE` are driven by the current video time, not elapsed wall-clock time. `TYPE` uses a stable reveal schedule, while `DECODE` uses a stable character-index/time-step scramble and a supported symbol pool. Seeking the same frame again must reproduce the same title state in the editor preview and offscreen Export.

When adding an optional field, provide defaults so existing Jobs open with the same result. Insert external text via `textContent`, not `innerHTML`.

## When a user asks to keep classic and add another layout

Stop before editing and ask which result the user means:

1. a fork that replaces classic with one fixed layout;
2. a separate experimental preview/build that does not change the runtime Job contract; or
3. a deliberate second official layout selectable by the app.

Only the first path is documented as a normal presentation customization. Do not silently add a selector, registry, plugin framework, or Job layout field for the second or third path.

## Do not add yet

Do not add the following structures until two or more official layouts are actually needed:

- runtime preset selector
- layout registry
- plugin framework
- Job layout ID
- width/height user-input UI
