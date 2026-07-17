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
- Routed embedded-preview drops through the official XML/video import transaction
- Made English the default public documentation, added Korean `.ko.md` editions, and published the AI customization guardrails
- Kept the primary Electron process responsive while the smoke test verifies second-instance rejection
- Added an `ADD FILES` picker to `REFERENCE FILES` while preserving drag and drop
- Made the Export popup verify that its stored XML, video, and reference files still exist before showing `READY`
- Removed the unimplemented `DURATION Δ` claim and documented the actual orphan behavior and audio-codec limits
- Limited GitHub Actions to read-only repository access and a bounded run time

## 0.1.0-beta.1

- Released the legacy-xmeml PRIMARY timeline and SHOT reference workflow
- Safe separation of UPDATE XML and NEW JOB
- Transaction rollback and recovery for Windows file locks
- XML, video, and reference drop zones
- Split out the pure parser, PRIMARY timeline, SHOT, and reference-mapping core
- Split the classic render spec from the presentation CSS
- Isolated smoke and Export smoke that never touch the real current-job
- Premiere Pro 2026 synthetic XML and MP4 fixture
