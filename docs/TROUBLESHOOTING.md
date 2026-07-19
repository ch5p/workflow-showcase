# Troubleshooting Contract

This is the public diagnostic entrypoint for agents. Diagnose from evidence before changing code. `HANDOFF.md` may contain additional maintainer context, but this document is the stable public procedure.

## First response

1. Preserve `current-job/job.json`, transaction folders, `.tmp` files, and completed `.part.mp4` files under the app-root `output/` folder.
2. Read the latest 20–50 JSONL events from `current-job/logs/app.log`, not only the final line.
3. Identify the operation and failing phase: prepare, preflight, commit, rollback, recovery, finalization, or cancel.
4. Correlate related events by `transactionId` when present, then by operation, `jobId`, and `revision`.
5. Compare stored relative paths with the real files under `current-job`.
6. Run `npm.cmd run check`. Use `npm.cmd run smoke` only through the isolated runner already defined by the package scripts; use `npm.cmd run smoke:intro` for the independent INTRO media pipeline.
7. Report the evidence and proposed recovery before editing Stable-core code.

On Windows, a short tail can be read with:

```powershell
Get-Content .\current-job\logs\app.log -Tail 50
```

Stored Job paths are relative to the `current-job` root. A correct timeline value is `source/timeline.xml`, not an absolute path and not `current-job/source/timeline.xml`.

## XML update and NEW JOB

Read the operation in this order:

1. `job_xml_prepared`
2. `job_xml_mode_selected`
3. `job_xml_commit_started`
4. `job_xml_commit_committed` or `job_xml_commit_rollback_*`
5. `job_xml_recovery_*` after a restart, when recovery was required
6. `renderer_xml_update_applied` for the resulting SHOT reconciliation

For UPDATE XML, compare `timelineShots`, `shotMappings`, and `orphanedShotMappings` with the reported `preserved`, `newShots`, `orphaned`, `ambiguous`, and `reattached` counts. The existing video and reference file hashes should remain unchanged.

For NEW JOB, the source XML/video, references, mappings, title, callout, `referenceMotion`, `editNumberTicker`, and `introPreroll` are reset to their defaults. Current Job logs, UI language, and Job output settings remain. Completed normal Export and INTRO demo files are outside the replaceable Job in the app-root `output/` folder and must remain unchanged.

If a rollback-failure event appears, stop all app processes. Do not reload the same XML, delete `.job-import-*`, discard a valid primary manifest, or overwrite `job.json` with a `.tmp` file. Restart and confirm the matching `job_xml_recovery_*` sequence first.

## Video replacement

Read the operation in this order:

1. `video_import_prepared`
2. `video_import_preflight_passed` or `video_import_preflight_failed`
3. `job_video_commit_started`
4. `job_video_commit_committed` or `job_video_commit_rollback_*`
5. `job_video_recovery_*` after a restart, when recovery was required

A preflight failure must not have a commit event. The previous video, `job.json`, `jobId`, and `revision` must remain unchanged. A commit failure must restore the previous video and Job together.

If `video_import_prepare_failed` reports `INSUFFICIENT_DISK_SPACE`, the copy was rejected before video preflight or Job replacement. Free space on the Current Job drive and retry. Video/reference copies reserve the selected bytes plus `max(512 MiB, 10%)`, capped at 8 GiB. A failed streaming copy removes its partial destination; do not weaken the reserve or switch back to a blocking copy to work around the error.

If `reference_import_stale_discarded` appears, another process or external file change advanced the Current Job while files were copying. The copied files were removed and newer Job data was preserved; reload the Current Job, then add the references again. Do not attach the discarded records manually to `job.json`.

If `starter_demo_seed_skipped_existing_payload` appears, `job.json` was missing but files remained under `current-job/source` or `current-job/references`. The app preserved those files and created an empty Job instead of installing the sample. Copy the preserved files elsewhere before manually loading the intended XML/video again.

## Export

Read the operation in this order:

1. `export_dialog_opened`
2. `export_started`
3. `export_space_checked` after the duration-based output estimate passes
4. `export_encoder_fallback` when NVENC failed and the CPU retry began
5. `export_finalize_failed`, `export_completed`, `export_failed`, or `export_cancelled`

For a completed Export with source-video judder, confirm that `export_completed.composition` is `ffmpeg_source_plus_ui`. The source video is decoded directly by FFmpeg, so `repeatedUiFrames` concerns only the transparent UI layer and does not mean source frames were duplicated. Compare the source and result with `ffprobe` before blaming Electron playback. A missing composition marker means the result came from an older real-time full-window capture build.

If the composited source appears uniformly darker, inspect `buildCompositeFilter()` before changing layout colors or the source. The overlay result must not be passed through another `out_range=tv` conversion; stream color metadata remains `bt709`, while the source/UI composite is converted to `yuv420p` only once.

`INSUFFICIENT_DISK_SPACE` before `export_space_checked` means FFmpeg did not start. Free space in the app-root `output/` drive and retry; there is no completed part to recover from that attempt.

If `export_finalize_failed` appears and a `.part.mp4` remains under app-root `output/`, treat it as a completed file whose final rename failed. Do not delete it. Quit the app, preserve the file, and rename it to `.mp4` manually after confirming the event.

If the popup does not open, inspect `export_dialog_opened`, its `sandbox: true` window preference, and whether `export-preload.cjs` loaded. If progress stalls, inspect the latest Export progress state and FFmpeg log instead of repeatedly opening new Export windows.

Source audio is copied without transcoding. AAC is the validated fixture codec; other audio codecs are not preflighted or transcoded. If video import succeeds but Export fails while attaching audio, create an H.264 MP4 with AAC audio and load that version.

## INTRO PRE-ROLL

Read the independent INTRO operation in this order:

1. `intro_builder_opened`
2. `intro_source_recorded` or `intro_source_restored` (automatic handoff), or `intro_source_selected` (manual fallback), then `intro_source_prepared` or `intro_source_prepare_failed`
3. `intro_settings_saved`, or `intro_settings_save_rejected_stale` when another save advanced the Job first
4. `intro_build_started`
5. `intro_build_progress`
6. `intro_build_completed`, `intro_build_cancelled`, or `intro_build_failed`; a blocked final rename first emits `intro_finalize_failed` and then `intro_build_failed`
7. `intro_builder_closed` when the window exits

`intro_settings_save_rejected_stale` and `intro_start_rejected_stale` mean another same-Job save advanced the revision while the non-modal builder was open. The builder adopts the current revision and retries once when the Job identity is unchanged; a changed Job loads its current INTRO defaults/settings instead of overwriting them, and a rejected BUILD requires a fresh click.

After a successful normal Export, `current-job/logs/last-showcase-export.json` records only the Job ID, direct app-owned output filename, size, and modification time. The same Job may restore that exact file after restart. If it is missing, changed, belongs to another Job, or fails the direct-output filename check, the builder shows the inline `EXPORT H.264` requirement; do not repair this by persisting an absolute path or scanning `output/` for the newest modified file. A manually selected external MP4 is intentionally session-only.

On `intro_source_prepare_failed`, preserve the selected source and inspect its basename, code, and redacted message through the Main-owned controller. The sandboxed builder must not resolve files or run FFmpeg itself. A selected source path never enters `job.json` or public log detail.

On `intro_build_failed`, confirm the selected normal Export is unchanged, then inspect the latest progress phase and controller FFmpeg detail. The expected pipeline re-renders only `src/intro-preroll.html`, stream-copies the main H.264 video, normalizes audio to AAC, concatenates through MPEG-TS, and verifies the `.part.mp4` before finalization. The app-owned `src/assets/intro-click.wav` and `intro-keyboard.wav` are sanitized inputs resolved by the controller, not stored Job paths.

On `intro_finalize_failed`, preserve the verified `output/workflow_showcase_demo_*.part.mp4`. Quit the app and rename it collision-safely to `.mp4` only after confirming the event; never overwrite or remove the source Export. After `intro_build_cancelled`, incomplete render/TS/audio/temp files and an incomplete part should be gone. If they remain, preserve the log and report the cleanup failure before deleting anything manually.

For source handoff and cleanup diagnostics, also inspect `intro_source_recorded`, `intro_source_restored`, `intro_recorded_source_rejected`, `intro_manual_source_session_only`, `intro_session_export_rejected`, `intro_summary_failed`, `intro_space_checked`, `intro_part_cleanup_failed`, `intro_temp_cleanup_failed`, and `intro_temp_cleanup_refused`. `intro_source_selection_cancelled` and `intro_source_selection_cleared` are ordinary user/session events, not build failures.

The native title-bar close and the builder `CLOSE` control both request a pending-settings flush. If that save fails the window intentionally stays open; do not bypass this by killing the window unless the whole app is being quit for recovery.

If builder preview and output differ, load the same scene time in shared `src/intro-preroll.html`. Different repeated frames indicate random or wall-clock-dependent state, which violates the scene contract. Do not work around it by forking a second offscreen HTML implementation or changing `exporter.cjs`.

## Save and path failures

- `job_write_failed`: preserve both the existing `job.json` and `.job.json.<uuid>.tmp`, quit the app, release the file lock, and restart. Do not overwrite the existing Job arbitrarily.
- `job_*_commit_cleanup_deferred` or `job_*_recovery_cleanup_deferred` alone: the operation result is already confirmed; only temporary cleanup was deferred. Quit and restart so cleanup can retry.
- `STORED_PATH_UNSAFE` or `Current Job path is unsafe`: remove the symlink/junction under `current-job` and recover with real folders and file copies. Do not weaken `owned-path.cjs` checks.
- `job_mutation_rejected_stale`: compare the renderer's expected `jobId + revision` with the current Job. Do not bypass the stale-write guard.

## Preview, references, and UI capture

- Timeline stuck on `PREVIEW RETRY`: inspect `thumbnail_seek_retry`, `thumbnail_generation_retry`, `thumbnail_generation_recovered`, and `thumbnail_generation_failed` with their frame and media-time details.
- Adjustment Layer appears as an EDIT/SHOT: confirm `src/adapters/xmeml-unsupported-layers.js` runs before PRIMARY inspection and run `scripts/check-input-adapters.cjs`. Do not add effect metadata to `job.json` as a workaround.
- Reference gap, flicker, or ghost card: inspect `positionReferenceDock`, `fadeOutgoingReferences`, `immediatePortableIds`, and `.referenceDockItem.leaving`; preserve LEAD-IN and crossfade semantics.
- UI capture failure: inspect `ui_capture_failed` for `scope`, `code`, and expected/actual dimensions. `SCOPE_UNAVAILABLE` means the EDIT PANEL was closed or TITLE CALLOUT was not visible when the shortcut was pressed. Success ends with `ui_capture_completed`.
- Unexpected initial language: inspect `ui_language_resolved`. A valid stored language wins; otherwise preferred system language should be considered before system/application locale fallbacks.

## Recovery boundary

Do not use `git reset`, delete the whole `current-job`, remove transaction folders, replace `job.json` from a staging file, or rewrite save/import code based on one generic error line. If the evidence does not identify a safe recovery, preserve the files and ask the user before taking a destructive action.
