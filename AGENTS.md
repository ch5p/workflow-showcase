# Agent Working Rules

This repository is meant to be customized by non-coders through LLM agents. Before changing anything, load the guardrails and respect them.

## Read first

- The `Current Job Contract` and `Import Contract` in `docs/PROJECT_MAP.md`.
- The Safe customization surface vs. Stable core split in `CUSTOMIZING.md`.
- For failures, `docs/TROUBLESHOOTING.md` before changing runtime code.
- For a new input format, read `docs/INPUT_ADAPTER_CONTRACT.md` before changing extension gates, storage, parser dispatch, or timeline data.
- If a maintainer workspace also contains `HANDOFF.md`, read its `Red Zone` and `Hot Debug` before touching runtime state.

## Document authority

- `AGENTS.md`: agent behavior and read order.
- `CUSTOMIZING.md`: presentation surface vs. Stable core.
- `docs/PROJECT_MAP.md`: file ownership and runtime contracts.
- `docs/INPUT_ADAPTER_CONTRACT.md`: normalized timeline and input-boundary contract.
- `docs/TROUBLESHOOTING.md`: public log and recovery procedure.
- `HANDOFF.md`: maintainer-only current state; it may add context but does not replace the public contracts above.
- If a request touches the Red Zone or the Stable core (`src/core`, save/import transactions, path checks, encoder/codec, callout timing), report the relevant contract first and do not edit until the user confirms.

## Review evidence and product scope

- This is a small template for short AI-video workflows, usually a single-digit set of still/video references and short 720p/1080p outputs. It is not a digital-asset manager, bulk-ingest tool, or long-form media pipeline.
- Separate a code-level invariant from claimed user impact. Report a proven contract violation as such, but do not assign user-visible severity to a hypothetical delay, freeze, or workflow burden without reproducing it on representative local storage or asking the maintainer for observed QA.
- Treat concerns that require unusually slow storage, unsupported bulk workloads, or extreme files outside the intended workflow as future hardening unless they also cause privacy exposure, path escape, silent corruption, or another reproducible contract violation.
- Do not infer that an operation is perceptibly slow from file size or asynchronous code alone. Record the tested file, environment, elapsed time, and visible result when performance is the finding.
- For customization audits, prioritize whether an agent can locate the documented presentation surface, avoid the Stable core, run the focused checks, and recover through Git. The repository provides guardrails and regression checks; it does not claim that arbitrary agent edits are impossible to break.

## Red Zone / hard rules

- Never rewrite the legacy FCP XML parser or the pure logic in `src/core/*`.
- Add new features as options that extend the existing output preview and Electron bridge; do not replace existing behavior without reporting first.
- Never put absolute user paths or email addresses in code or Job data. Stored Job paths are relative to the `current-job` root: use `source/timeline.xml`, not an absolute path and not `current-job/source/timeline.xml`.
- Current Job reads/writes and persistent renderer file access go only through `preload.cjs` IPC. The standalone preview may inspect a user-provided browser `File`, but do not enable Node APIs in any renderer.
- Reference inspection, streamed import, final revision commit, mapping cleanup, and owned-file deletion belong to `reference-lifecycle.cjs`. Keep `main.cjs` limited to the picker and IPC wiring; do not duplicate this lifecycle in a renderer.
- Before editing, leave the latest file intact enough to roll back, and describe which files you will change and why.

## Docs and encoding

- English is the default public and agent-contract language: `README.md`, `CUSTOMIZING.md`, `docs/CUSTOMIZING_WITH_AI.md`, `AGENTS.md`, and `docs/PROJECT_MAP.md` use UTF-8 **without** BOM.
- Korean editions use the `*.ko.md` suffix and UTF-8 **with** BOM. Existing Korean fixture/layout/template docs without the suffix also keep their BOM.
- `scripts/check.cjs` enforces both directions across the public documentation surface.

## Verify

- Run `npm.cmd run check` first, then `npm.cmd run smoke`, briefly, after changes.
- Do not run smoke flags directly; they must go through `scripts/run-smoke.cjs` with an isolated temp Job root outside the app.
- Log errors as reproducible events in `current-job/logs/app.log`.
