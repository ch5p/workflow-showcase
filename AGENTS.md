# Agent Working Rules

This repository is meant to be customized by non-coders through LLM agents. Before changing anything, load the guardrails and respect them.

## Read first

- The `Current Job Contract` and `Import Contract` in `docs/PROJECT_MAP.md`.
- The Safe customization surface vs. Stable core split in `CUSTOMIZING.md`.
- For failures, `docs/TROUBLESHOOTING.md` before changing runtime code.
- For a new input format or VIDEO ONLY mode, `docs/INPUT_ADAPTER_CONTRACT.md` before changing extension gates, storage, parser dispatch, or timeline data.
- If a maintainer workspace also contains `HANDOFF.md`, read its `Red Zone` and `Hot Debug` before touching runtime state.

## Document authority

- `AGENTS.md`: agent behavior and read order.
- `CUSTOMIZING.md`: presentation surface vs. Stable core.
- `docs/PROJECT_MAP.md`: file ownership and runtime contracts.
- `docs/INPUT_ADAPTER_CONTRACT.md`: normalized timeline and input-boundary contract.
- `docs/TROUBLESHOOTING.md`: public log and recovery procedure.
- `HANDOFF.md`: maintainer-only current state; it may add context but does not replace the public contracts above.
- If a request touches the Red Zone or the Stable core (`src/core`, save/import transactions, path checks, encoder/codec, callout timing), report the relevant contract first and do not edit until the user confirms.

## Red Zone / hard rules

- Never rewrite the legacy FCP XML parser or the pure logic in `src/core/*`.
- Add new features as options that extend the existing output preview and Electron bridge; do not replace existing behavior without reporting first.
- Never put absolute user paths or email addresses in code or Job data. Stored Job paths are relative to the `current-job` root: use `source/timeline.xml`, not an absolute path and not `current-job/source/timeline.xml`.
- Current Job reads/writes and persistent renderer file access go only through `preload.cjs` IPC. The standalone preview may inspect a user-provided browser `File`, but do not enable Node APIs in any renderer.
- Before editing, leave the latest file intact enough to roll back, and describe which files you will change and why.

## Docs and encoding

- English is the default public and agent-contract language: `README.md`, `CUSTOMIZING.md`, `docs/CUSTOMIZING_WITH_AI.md`, `AGENTS.md`, and `docs/PROJECT_MAP.md` use UTF-8 **without** BOM.
- Korean editions use the `*.ko.md` suffix and UTF-8 **with** BOM. Existing Korean fixture/layout/template docs without the suffix also keep their BOM.
- `scripts/check.cjs` enforces both directions across the public documentation surface.

## Verify

- Run `npm.cmd run check` first, then `npm.cmd run smoke`, briefly, after changes.
- Do not run smoke flags directly; they must go through `scripts/run-smoke.cjs` with an isolated temp Job root outside the app.
- Log errors as reproducible events in `current-job/logs/app.log`.
