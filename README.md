# Workflow Showcase

`English` · [`한국어 →`](./README.ko.md)

A portable video-template source beta that turns a legacy Final Cut Pro 7 XML (xmeml) exported from Premiere Pro, plus your finished video, into a 1280 × 1080 H.264 showcase clip with a per-SHOT reference map. The tested desktop build currently targets Windows.

There is currently one official layout, `classic`. It does not automatically support 16:9, 9:16, or 1:1; if you need those, fork the classic presentation and render spec while keeping the stable core intact.

## Why this exists

Most AI-generated clips (for example, from Seedance-class models) look great on their own, but the interesting part — which references drove each shot, and how the cut was assembled — is invisible. This tool takes the timeline you already edited in Premiere and the finished video, and renders a single "process reveal": your video on top, the reference map and the PRIMARY-based cut breakdown underneath. It is meant as a ready-to-post showcase for feeds like X, with no extra compositing work.

It is built so that non-coders can remix it. Changing callouts, reference cards, or the cut board to your taste is meant to be driven through an LLM (Codex, Claude, etc.) rather than by editing code by hand. See [Customizing with AI](docs/CUSTOMIZING_WITH_AI.md).

## Beta scope

- Supported: xmeml sequences and video-track timing
- Primary validation: Final Cut Pro XML export from Adobe Premiere Pro 2026 v26.2.2 (Build 3)
- Default output: 1280 × 1080, 60 fps, H.264, 12 Mbps
- Storage: a single Job under `current-job`, addressed by relative paths
- Distribution: Windows source beta
- Not supported: modern FCPXML, CapCut projects, reproduction of Premiere effects/masks

See [XML Compatibility](docs/XML_COMPATIBILITY.md) for the exact boundaries.

## Requirements

- Windows 10 or 11
- Node.js 22.12 or later
- npm
- FFmpeg — required for Export. If WinGet is available, install it with the command below.

This repository does not bundle the FFmpeg binary. On a Windows 10/11 system with WinGet, paste this into Command Prompt or PowerShell. If setup is unfamiliar, you can ask an LLM to run the command for you.

    winget install -e --id Gyan.FFmpeg

Fully quit and restart the app after installation so it can see the updated `PATH`. You can also place a downloaded `ffmpeg.exe` in the project's `ffmpeg/` folder.

## Quick start

    npm.cmd ci
    npm.cmd start

Or run `START_APP.cmd` after installing.

The first launch opens the bundled public fixture as a ready-to-play `SAMPLE JOB`:

- XML: `fixtures/premiere-export-kit/public-fixture/premiere-synthetic.xml`
- Video: `fixtures/premiere-export-kit/public-fixture/premiere-synthetic-final.mp4`

The sample is 24 fps and 12 seconds, with 5 EDITS, 4 SHOTS, and a PRIMARY order of A → D → B → A → C. To start your own project, click or drop your XML on the top `XML` zone. A valid XML automatically replaces the disposable sample as a new Job; then load the matching finished video from the top `VIDEO` zone. Existing non-sample Jobs still show the safe UPDATE XML / NEW JOB choice.

## Job safety

- The app opens the Current Job from a single process at a time; a second launch returns to the existing window.
- Ordinary `job.json` saves fsync a unique staging file and retry Windows file locks. If the replace ultimately fails, both the existing Job and the completed staging file are preserved.
- Symlinks/junctions inside `current-job` are rejected to prevent reading, deleting, or writing files outside the Job.
- UPDATE XML: keeps the existing video, references, GLOBAL/SHOT mappings, title, and output settings, and refreshes only the timeline.
- NEW JOB: resets source, video, references, mappings, title, and callout only when the user explicitly chooses it. The bundled first-run sample is the only exception: the first valid user XML replaces that disposable sample automatically.
- A video is committed to the Current Job only after Electron actually reads its metadata and first frame.
- If the final rename after a completed render fails, the finished `.part.mp4` is not deleted.

Jobs live under `current-job`. Copy the whole app folder and it reopens elsewhere via internal relative paths. User data in `current-job` is excluded from Git.

## Tests

Regression fixtures and smoke runs use an OS temp folder instead of the real `current-job`. To verify that tests did not mutate user data, `check` locally compares only the before/after SHA-256 of `current-job/job.json`; it does not print or modify its contents.

    npm.cmd run check
    npm.cmd run smoke
    npm.cmd run smoke:export

`smoke:export` requires FFmpeg, creates a 1-second temporary output, and then deletes it. For visual QA, make a separate file with the real app's `EXPORT H.264` control and inspect that result.

## Customizing

- Fixed output width/height and default fps/bitrate: `render-spec.cjs`
- Shared classic color/font tokens: `src/layouts/classic/tokens.css`
- Classic placement, region sizing, and style: `src/layouts/classic/classic.css`
- Parser and PRIMARY calculation: `src/core/` — do not modify for layout work

To customize via an LLM without reading code, see [Customizing with AI](docs/CUSTOMIZING_WITH_AI.md). For a fixed aspect-ratio fork and the safety lines, see [CUSTOMIZING.md](CUSTOMIZING.md) and [Classic Layout](docs/CLASSIC_LAYOUT.md).

## Known limitations

- XML is edit-structure data; it does not reproduce Premiere filters, horizontal flips, Transform, Crop, masks, keyframes, or color grading. Premiere Adjustment Layers are ignored before EDIT/SHOT detection rather than shown as timeline content.
- Transitions are used only for some boundary calculations and are not rendered as visual effects.
- The final visual truth is the finished video you load, not the XML.
- The editor UI is not a responsive product UI, and classic output is 1280 × 1080 only.
- This source beta has been validated on Windows only.
- It is not a frame-accurate mastering tool; duplicate paint frames may appear under heavy load.
- UPDATE XML preserves SHOT mappings that cannot be matched unambiguously for a later UPDATE, but this beta has no screen to list, manually reattach, or individually discard those orphaned mappings.
- Export copies source audio without transcoding. Some MOV/M4V files whose audio codec is incompatible with MP4 may fail to export.
- Video and reference imports do not show copy progress or check free disk space in advance. Very large files may appear stalled or fail when space runs out.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution process and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

The code and the synthetic fixtures included in this repository are under the [MIT License](LICENSE) unless noted otherwise. Adobe, Premiere Pro, Final Cut Pro, and CapCut are trademarks of their respective owners; this project is not affiliated with those companies.
