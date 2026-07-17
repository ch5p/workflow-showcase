# Troubleshooting Contract

This is the public diagnostic entrypoint for agents. Diagnose from evidence before changing code. `HANDOFF.md` may contain additional maintainer context, but this document is the stable public procedure.

## First response

1. Preserve `current-job/job.json`, transaction folders, `.tmp` files, and completed `.part.mp4` files under the app-root `output/` folder.
2. Read the latest 20–50 JSONL events from `current-job/logs/app.log`, not only the final line.
3. Identify the operation and failing phase: prepare, preflight, commit, rollback, recovery, finalization, or cancel.
4. Correlate related events by `transactionId` when present, then by operation, `jobId`, and `revision`.
5. Compare stored relative paths with the real files under `current-job`.
6. Run `npm.cmd run check`. Use `npm.cmd run smoke` only through the isolated runner already defined by the package scripts.
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

For NEW JOB, the source XML/video, references, mappings, title, and callout are reset. Current Job logs, UI language, and Job output settings remain. Completed files are outside the replaceable Job in the app-root `output/` folder and must remain unchanged.

If a rollback-failure event appears, stop all app processes. Do not reload the same XML, delete `.job-import-*`, discard a valid primary manifest, or overwrite `job.json` with a `.tmp` file. Restart and confirm the matching `job_xml_recovery_*` sequence first.

## Video replacement

Read the operation in this order:

1. `video_import_prepared`
2. `video_import_preflight_passed` or `video_import_preflight_failed`
3. `job_video_commit_started`
4. `job_video_commit_committed` or `job_video_commit_rollback_*`
5. `job_video_recovery_*` after a restart, when recovery was required

A preflight failure must not have a commit event. The previous video, `job.json`, `jobId`, and `revision` must remain unchanged. A commit failure must restore the previous video and Job together.

## Export

Read the operation in this order:

1. `export_dialog_opened`
2. `export_started`
3. `export_encoder_fallback` when NVENC failed and the CPU retry began
4. `export_finalize_failed`, `export_completed`, `export_failed`, or `export_cancelled`

If `export_finalize_failed` appears and a `.part.mp4` remains under app-root `output/`, treat it as a completed file whose final rename failed. Do not delete it. Quit the app, preserve the file, and rename it to `.mp4` manually after confirming the event.

If the popup does not open, inspect `export_dialog_opened` and whether `export-preload.cjs` loaded. If progress stalls, inspect the latest Export progress state and FFmpeg log instead of repeatedly opening new Export windows.

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
