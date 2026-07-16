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

## Stable core

Do not modify these files for presentation changes:

- `src/core/xmeml-parser.js`
- `src/core/primary-timeline.js`
- `src/core/shot-model.js`
- `src/core/reference-mapping.js`
- `timeline-reconcile.cjs`
- `job-lifecycle.cjs`
- `video-lifecycle.cjs`

In particular, the XML parser, SHOT identity, reference mapping semantics, Job relative paths, IPC, and Export cancel / encoder fallback are the stable core.

## Making a fixed aspect-ratio fork

1. First make `npm.cmd run check` and `npm.cmd run smoke` pass.
2. Change the classic width and height in `render-spec.cjs` to your fork's fixed values.
3. In `classic.css`, re-lay-out the stage, videoZone, panel, reference, and timeline regions for the new canvas.
4. Confirm the editor fit and the Export summary show the same render spec.
5. Load the public fixture and confirm the same 5 EDITS and 4 SHOTS hold.
6. Run `npm.cmd run smoke:export` to verify the automated Export path.
7. Export through the real app's `EXPORT H.264` control and inspect the resulting MP4's size and legibility yourself.

This does not automatically guarantee mobile legibility or information density. 16:9, 9:16, 1:1, and 4:5 are each separate design problems.

## Callout contract

The callout fields of an existing Job keep these meanings:

- `enabled`
- `position`
- `style`
- `startSeconds`
- `durationSeconds`
- `subtitle`

When adding an optional field, provide defaults so existing Jobs open with the same result. Insert external text via `textContent`, not `innerHTML`.

## Do not add yet

Do not add the following structures until two or more official layouts are actually needed:

- runtime preset selector
- layout registry
- plugin framework
- Job layout ID
- width/height user-input UI
