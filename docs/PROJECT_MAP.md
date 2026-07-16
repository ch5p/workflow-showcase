# Project Map

## App

- `main.cjs`: Electron window, file selection, the XML UPDATE/NEW JOB decision boundary, portable copy, `job.json` CAS save, app log
- `durable-file.cjs`: UUID staging, fsync, Windows rename retry, and preservation of failed staging for ordinary Jobs and completed Exports
- `owned-path.cjs`: lexical, lstat, and realpath no-follow checks for the Current Job owned root
- `strings.cjs`: EN/KR user-facing strings for the Main process and the exporter, plus the `ui.language` → OS-locale resolution rule
- `preload.cjs`: the minimal local file API exposed to the screen, plus restricted IPC for XML/video/reference drop
- `job-lifecycle.cjs`: prepare/commit/rollback/crash recovery and Windows-safe staged replace for XML UPDATE/NEW JOB
- `video-lifecycle.cjs`: prepare/commit/rollback/crash recovery and Windows-safe staged replace for source video replacement
- `timeline-reconcile.cjs`: 1:1 rematching of anonymous SHOT descriptors and orphan preservation
- `render-spec.cjs`: the central classic width/height and pixel/color contract, plus default output fps/bitrate; an existing Job may override fps/bitrate through `output`
- `export-preload.cjs`: the start/cancel/progress/open-folder API exposed only to the Export popup
- `exporter.cjs`: offscreen BGRA frame capture, FFmpeg H.264 output with optional source-audio stream copy, progress, cancel, and fallback
- `src/index.html`: the editing screen and the SHOT rail
- `src/mvp-app.js`: the editing screen, Job store, and output-preview wiring
- `src/core/*`: the pure core for the legacy xmeml parser, PRIMARY timeline, SHOT descriptor, and reference mapping
- `src/adapters/xmeml-unsupported-layers.js`: excludes pathless Premiere Adjustment Layers before the stable PRIMARY/SHOT core runs; effect metadata is not exposed or persisted
- `src/layouts/classic/tokens.css`, `classic.css`: the official classic presentation tokens and placement
- `src/output-preview.html`: named presentation regions, the playback clock, and the `window.portablePreview` bridge
- `src/export-dialog.html`, `src/export-dialog.js`: the standalone Export window that confirms the saved title and render spec and shows progress and the completed path

## Current Job Contract

- `current-job/job.json`: the reference file for references and SHOT mappings
- `demo: true`: optional marker used only by the untouched bundled first-run sample. It is absent from ordinary user Jobs and removed when the sample is replaced or the user first saves a real edit/import.
- `jobId`, `revision`: the new-Job identity and the change generation within the same Job. Every renderer mutation sends the two values it read, and Main rejects any stale save where even one differs.
- Ordinary `job.json` changes are staged with a fsync'd UUID staging file rather than a fixed `.tmp`, then swapped in. Under a persistent file lock, the existing Job and the completed staging are preserved and an error is returned.
- `current-job` and `source`, `references`, `output`, `logs` must be real directories; symlinks/junctions are not allowed. Stored files are re-checked all the way to the real path, inside the owned root, immediately before use.
- `projectTitle`: an optional field of up to 40 characters that is reflected in the preview as soon as it is typed in the edit panel and auto-saved. If the field is absent, `UNTITLED PROJECT` is used; an explicit empty string is used as an empty title.
- `callout`: an optional field with `enabled`, `position`, `style`, `startSeconds`, `durationSeconds`, `subtitle`, used identically by the output preview and the offscreen render.
- `ui.language`: optional `"en"` or `"ko"`. Absent means follow the OS locale. Toggled by the editor's EN/KR button and saved through the normal `job:save` ui merge; the Export popup reads it from the summary `language` field.
- `shotMappings.<shotId>`: may add the optional field `leadInSeconds: 1` to the existing `mode`, `refs`; when absent it is treated as `0`.
- `timelineShots`: rematching descriptors that store only `identityKey`, `nameKey`, and timeline/source in-out occurrence, without original names or paths
- `orphanedShotMappings`: existing mappings that did not clearly match the new timeline 1:1. Only `descriptor`, `mapping`, and `reason` are stored, and they can be reattached in the next UPDATE.
- `current-job/source/timeline.xml`: the XML imported into the app
- `current-job/source/video.*`: the finished video imported into the app
- `current-job/references/`: copies of image/video references
- `current-job/output/`: `workflow_showcase_export_*.mp4` and QA artifacts. Exports created by older builds keep their original filenames.
- `current-job/logs/app.log`: diagnostic events as JSONL
- `backup/<YYYY-MM-DD_HH-mm-ss>/`: manual settings snapshots containing `job.json`, recorded timeline XML, recorded references, and a hash manifest; only source video, exports, and logs are excluded

All stored paths are relative to the app folder. Internal identifiers and JSON keys are not changed.

## Import Contract

- The `XML` click/drop zone uses one prepare/commit path. The current dialog labels are `타임라인만 업데이트` (`Update timeline only`, default), `새 Job으로 불러오기` (`Load as a new Job`), and `취소` (`Cancel`).
- XML validation, UPDATE, NEW JOB, preview, and Export all exclude Premiere Adjustment Layers before PRIMARY/SHOT inspection. Adjustment filter data is neither rendered nor stored in the Job.
- When `current-job/job.json` does not exist, Main copies the existing public fixture XML/MP4 into `current-job/source`, creates a `demo: true` sample Job, and logs `starter_demo_seeded`. It never seeds over an existing Job. If fixture seeding fails, it logs `starter_demo_seed_failed` and falls back to the empty Job contract.
- A valid XML selected while `demo: true` bypasses the UPDATE choice and enters the existing NEW JOB transaction, so the disposable sample XML/video are removed while output/logs remain. The candidate is parsed before this decision. Ordinary Jobs keep the normal UPDATE/NEW JOB dialog.
- On selection cancel, file-pick cancel, or validation failure, the existing `job.json`, source, and references are unchanged.
- UPDATE replaces only `source/timeline.xml` and preserves video/reference/GLOBAL/title/callout/`ui`/`output`. It prefers exact source identity, falls back only when there is unique name + source range/occurrence evidence, and keeps ambiguous/unmatched mappings as orphans.
- NEW JOB cleans up the source XML/video and reference files when explicitly chosen for an ordinary Job, or automatically after a valid XML is selected for `demo: true`. It resets `references`, `globalReferenceIds`, previous `shotMappings`/orphans, `projectTitle`, and `callout`. It stores the new XML's anonymous descriptors in `timelineShots`, and preserves `current-job/output/`, `current-job/logs/`, existing `ui`, and `output`.
- The `VIDEO` click/drop zone uses one two-step transaction. A candidate releases the renderer media handle and commits only after a detached Electron video probe reads metadata and the first frame. A preflight failure discards only the candidate and does not change the existing video, Job, or revision. Main owns the existing video/Job backup, replacement, and rollback.
- Every mutation compares `jobId + revision`, so an earlier debounced save arriving after an XML UPDATE or NEW JOB cannot overwrite the current state.
- XML/video transactions retry Windows rename lock errors 4 times, and on persistent failure replace the manifest and Job files via durable copy, fsync, and SHA-256 verification. A valid primary manifest is always the reference; a staging manifest is used only when the primary is missing or corrupted.
- Locked fixed staging files are bypassed with UUID staging. The rollback completion marker is also fsync'd to UUID staging, then verified and swapped, recording `state: rolled_back`. An interruption before the marker re-runs candidate removal idempotently based on the `moved` inventory and any remaining backup. Transaction cleanup restores the fallback to primary, then removes staging and backup/candidate, and deletes the primary manifest last. A transient cleanup failure of a `prepared`/`committed`/`rolled_back` transaction is recorded as `deferred` and does not block current Job mutation or Export.
- Restore authority for `backup/job.json` is `hadJob: true` in the durable manifest. In an early backup crash with `hadJob: null`, the current `job.json` is kept even if a final backup file exists, because the live Job is still untouched.

## Test Fixtures

- `fixtures/premiere-export-kit/media/`: 5 neutral source cards that build a real Premiere Sequence
- `fixtures/premiere-export-kit/PREMIERE_EXPORT_GUIDE.md`: the 24 fps, 12-second fixture production/export procedure
- `fixtures/premiere-export-kit/public-fixture/`: the publicly cleaned real Premiere `xmeml` and the final MP4 of the same Sequence
- `fixtures/premiere-export-kit/public-fixture/SOURCE_NOTES.md`: provenance, cleanup record, validation contract, and SHA-256 records

The raw XML that Premiere first produced and the original attachments are not added to Git. When adding `tests/fixtures/`, do not duplicate the real Premiere integration fixture; keep only hand-written `xmeml` edge cases and Job-scoped fixtures.

`scripts/run-smoke.cjs` creates a test-only Job root and Electron userData in an OS temp folder, verifies that first launch seeds the public XML/MP4 as a `SAMPLE JOB`, and reads the public XML via `PORTABLE_SMOKE_XML`. Main rejects a smoke that has no test root or points inside the app folder. `smoke:export` prepares its own explicit Job, produces 1 second of output, then deletes the entire temp folder.

Lifecycle regression checks run only in an OS temp Job root and forcibly verify: persistent `EPERM` on manifest/Job backup/install/restore, valid primary + stale `.tmp`, corrupted primary + valid UUID fallback, locked fixed-staging bypass, cleanup interruption after rollback, candidate-install interruption when there was no prior timeline/video, re-recovery after a marker write failure, a valid `.partial` + a truncated Job backup final, and the identical-Job hash replace skip. Real `current-job` access is failed by a guard.

`scripts/check-runtime-safety.cjs` checks, in an OS temp folder, the ordinary Job atomic save, staging/existing-Job preservation under a persistent lock, symlink/junction escape blocking, and Export final collision avoidance and completed-part preservation. The isolated smoke additionally checks normal/corrupted video preflight and Job invariance, and uses an asynchronous secondary probe to verify that a second Electron is blocked on the same test `userData` without blocking the primary event loop.

Before the Export popup shows `READY`, `main.cjs` resolves the stored XML, video, and every registered reference with `mustExist: true` inside its owned Current Job directory. The actual Export start repeats its own source/reference checks; the readiness display does not replace that final guard.

## Contract check

- Document reference: the `current-job` structure above, `job.json` version 1, `jobId + revision`, and the UPDATE/NEW JOB Import Contract
- Real sample: 24 fps, 288 frames, repeated source identity of the Premiere Pro 2026 fixture, and the app's isolated smoke result of 5 EDITS / 4 SHOTS. In a real recovery of a failed transaction, per-file SHA-256 matches for 2 sources / 11 references / the existing Job were confirmed.
- Code assumption: `main.cjs`'s `JOB_ROOT`, `durable-file.cjs`, `owned-path.cjs`, the XML/video lifecycles, timeline reconcile, `src/core/*`, `render-spec.cjs`, the CAS guard, and `hydrateJob()` all read the same structure.
- Mismatch: none
- Handling: when the structure changes, verify the document, the real sample, and the code together.
