# Changelog

## 0.1.0-beta.2

- Added persistent EN/KR UI selection, preferred-OS-language first-run detection, localized failure messages, and language-resolution diagnostics
- Excluded Premiere Adjustment Layers before PRIMARY EDIT/SHOT detection without exposing effect metadata
- Seeded the bundled Premiere fixture as a disposable first-run `SAMPLE JOB` and made the first valid user XML replace it through NEW JOB
- Replaced the inactive center-drop claim with guidance to the real top XML/VIDEO controls
- Unified the app, package, documentation, Export prefix, and public repository identity as `Workflow Showcase`
- Hardened the single-instance guard and durable Current Job saving
- Blocked symlink/junction escapes on stored paths
- Electron decode/metadata preflight before committing a video
- Preserve `.part.mp4` when the final rename after a render fails
- Moved completed Export files to the app-root `output/` so replacing `current-job` cannot delete them
- Added the Current Job reload icon and renamed the reset control to `TO START`
- Fixed callout descender clipping and the subtitle shadow
- Added LINE/LABEL/MINIMAL/VIEWFINDER title-callout styles and FADE/MASK/TYPE/DECODE/GLITCH motions, with TYPE and DECODE resolved deterministically from video time
- Routed embedded-preview drops through the official XML/video import transaction
- Made English the default public documentation, added Korean `.ko.md` editions, and published the AI customization guardrails
- Kept the primary Electron process responsive while the smoke test verifies second-instance rejection
- Added an `ADD FILES` picker to `REFERENCE FILES` while preserving drag and drop
- Made the Export popup verify that its stored XML, video, and reference files still exist before showing `READY`
- Removed the unimplemented `DURATION Δ` claim and documented the actual orphan behavior and audio-codec limits
- Limited GitHub Actions to read-only repository access and a bounded run time
- Added free-space preflight, bounded safety reserves, non-blocking streamed video/reference copies, progress, streaming SHA-256, and partial-file cleanup while keeping generous sanity caps
- Added duration-based Export space estimation before FFmpeg starts
- Split persisted timeline validation, DURATION boundary math, UI capture, and smoke orchestration into focused modules with regression checks
- Sandboxed the Export confirmation window and verified its preload API in the isolated desktop smoke
- Added a separate sandboxed Intro Builder with persisted prompt/reply/typing/sound settings, prompt-length-aware deterministic key sounds, source-independent replay and preview-surface play/pause, a compact aspect-fitted live preview, exact same-Job Showcase Export restoration without newest-file guessing, a shared deterministic pre-roll scene, sanitized app-owned sounds, and an isolated real-FFmpeg smoke for stream-copy/AAC/TS finalization without changing normal Export
- Narrowed new finished-video imports to the validated H.264 MP4 workflow; MOV/ProRes and M4V remain recognizable only for legacy cleanup and as independently handled reference media
- Moved normal Export source-video decoding into FFmpeg and composited the transparent 60fps Electron UI layer separately, preventing delayed Chromium video paints from extending source-frame holds while preserving the source brightness without a duplicate limited-range conversion
- Replaced the README's model-review attribution with a direct description of the current exporter behavior
- Removed the hidden Premiere project path from the public MP4 fixture and added binary privacy regression checks
- Rechecked Current Job state at reference-import completion and rejected stale completion instead of overwriting newer Job edits
- Preserved orphaned source/reference files when `job.json` is missing instead of replacing them with the starter demo
- Split reference import/delete ownership from `main.cjs` into a focused lifecycle module with an isolated regression check
- Refreshed the public Premiere fixture to 13 seconds with a real blended upper-track clip, excluded Adjustment Layer, final Color Matte, and matching README/landing demo animation
- Added an optional rolling EDIT number ticker and grouped it with the persistent project-wide `REFERENCE 3D POP` option under `EDIT DISPLAY`; the static number and original flat stagger remain defaults, and both reference motions share the same LEAD-IN and SHOT-transition timing

## 0.1.0-beta.1

- Released the legacy-xmeml PRIMARY timeline and SHOT reference workflow
- Safe separation of UPDATE XML and NEW JOB
- Transaction rollback and recovery for Windows file locks
- XML, video, and reference drop zones
- Split out the pure parser, PRIMARY timeline, SHOT, and reference-mapping core
- Split the classic render spec from the presentation CSS
- Isolated smoke and Export smoke that never touch the real current-job
- Premiere Pro 2026 synthetic XML and MP4 fixture
