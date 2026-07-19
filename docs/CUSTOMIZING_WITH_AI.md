# Customizing with AI — remix it without reading code

`English` · [`한국어 →`](./CUSTOMIZING_WITH_AI.ko.md)

This guide is for people who want to change the app to their taste **without reading the code**, by telling an LLM (Codex, Claude, etc.) "change this to that." The project was built to be used this way.

It covers:

1. A **base instruction** to paste before asking the LLM for changes
2. A **traffic light**: what is free to change vs. what to be careful with
3. An **intent table**: "if you want to change X, say this"
4. How to **verify** a change and how to **roll it back**

> This document itself is safe to edit freely. It is pure guidance with no effect on app behavior.

---

## 0. Base instruction to paste first

When you ask for a change, paste this before or after your request. It sharply lowers the chance the LLM breaks something.

```
Before editing this repo, read AGENTS.md, the contracts in docs/PROJECT_MAP.md,
and the Safe/Stable split in CUSTOMIZING.md.
If my request touches the Red Zone or Stable core, tell me first instead of editing.
For a runtime failure, follow docs/TROUBLESHOOTING.md before changing code.
Preserve existing uncommitted work and first list the files and reasons for this change.
After the change, run npm.cmd run check, then npm.cmd run smoke.
If the Export contract changed, also run npm.cmd run smoke:export.
If the change is visual, tell me exactly what to click to verify it.
```

What this does: it makes the LLM (1) learn the danger zones first, (2) preserve existing work, (3) run the automated checks after editing, and (4) leave you a way to verify visually.

---

## 1. Traffic light — what is free vs. what to be careful with

| Zone | What | Can the LLM finish it alone? |
|---|---|---|
| 🟢 **Free** | On-screen **text/help**, **button labels**, shared **colors/design tokens** (`tokens.css`) | Yes. It can edit and run automated checks. |
| 🟡 **Ask first** | **Output resolution/aspect ratio**, classic **layout** (`classic.css`), window size, subtitle (callout) size/color | Possible, but get a "what will change" report first. Aspect ratio/resolution should go through the fork guide in [`../CUSTOMIZING.md`](../CUSTOMIZING.md). |
| 🟢 **Free** | INTRO scene **layout/color/type** in the shared `src/intro-preroll.html` | Yes, if preview and offscreen output stay deterministic and identical. |
| 🔴 **Report + verify yourself / avoid** | **Save, path checks, XML/video import**, the **encoder/codec contract**, INTRO **source selection/FFmpeg/concat/finalization**, the **callout timing driven by video time**, the **XML parser and PRIMARY calculation** (`src/core`) | No. Getting this wrong can silently break data or output. |

The instinct: **on-screen text and color = free**, **layout/resolution = ask first**, **save/import/codec/parser/timing = risky**.

---

## 2. "If you want to change X, say this" intent table

| What you want | Say something like | Watch out |
|---|---|---|
| Rename a button | "Change the top toolbar button label to ○○" | 🟢 Keep what the button **does**; change only the **text** |
| Edit help/hint text | "Change the preview help / drop-zone text to ○○" | 🟢 Free |
| Change color/font tone | "Change the shared classic accent token to ○○" | 🟢 Region-specific fixed values also live in `classic.css`; inspect both. |
| Subtitle (title callout) color/size | "Make the video subtitle bigger / a different color" | 🟡 Always add "keep the video-time timing unchanged" (see §3) |
| Adjust the bottom layout | "Rearrange the reference cards and timeline like ○○" | 🟡 Start with `classic.css`. Card size/density also has a narrow packing seam documented in `../CUSTOMIZING.md`; do not rewrite reference timing or `src/core`. |
| Change output resolution / aspect ratio (e.g. vertical 4:5) | "Make a fixed ○:○ fork by changing render-spec width/height and classic presentation values, following `../CUSTOMIZING.md`" | 🟡 Re-lay-out for the new canvas and account for `CONFIG.panelHeight`. fps/bitrate are a separate Export contract; do not change them as part of the aspect-ratio request. |
| Restyle the INTRO scene | "Change only the shared `src/intro-preroll.html` presentation and keep its scene-time output deterministic" | 🟢 The builder preview and offscreen intro render use the same file. Keep the fixed question/project/model/reasoning fields unless explicitly requested. |
| Change INTRO conversation, typing time, or sound | "Keep the existing `introPreroll` schema and edit only prompt, reply, the 1/2-second typing choice, or SOUND ON/OFF" | 🟡 Do not add selected Export or asset paths to `job.json`. UPDATE XML preserves these settings; NEW JOB resets them. |
| Change INTRO source selection or concat | (avoid) "First report the INTRO controller contract and risks" | 🔴 Keep `intro-demo-controller.cjs` separate from `exporter.cjs`; source video is stream-copied, audio is normalized to AAC, and verified finalization/cancel cleanup must remain intact. |
| Add a new feature | "Add ○○ as an option **without changing existing behavior**" | 🟡 Say "extend, don't replace" |
| Change encoder/codec | (avoid) "First tell me whether it's possible and risky" | 🔴 BGRA capture and source-audio stream copy are fixed boundaries. The official default is 60 fps; changing fps is a separate Export-contract change. |
| Save fails / path error | "Don't fix it yet — follow `docs/TROUBLESHOOTING.md`, inspect the latest 20–50 events in `current-job/logs/app.log`, and tell me the failing phase" | 🔴 Diagnose first, edit later; one final line is not enough for a transaction |

For anything not in the table, paste the §0 base instruction and ask "is this a risky area or not?" first.

---

## 3. Requests a naive LLM will break things on (prevent up front)

These sound natural enough that an LLM may just do them, but they break the app. When you want these, always add "without touching the ○○ contract."

- **"Make the subtitle fade in smoothly"** → The subtitle must appear **in sync with video time** so the preview and final output match. Switching to a CSS wall-clock animation desyncs the output. → "Keep the timing logic, change only the look."
- **"Rewrite the XML reader cleanly"** → The parser and PRIMARY calculation in `src/core` are the stable core. Do not rewrite them.
- **"Make the export lighter/smaller"** (vaguely) → Vague requests are dangerous. If you want a different resolution, name the width/height and layout work from the aspect-ratio row above. Do not touch the encoder/codec itself.
- **"Make INTRO remember the newest Export"** → INTRO must not persist an absolute Export path or guess by modification time. An exact Export completed in the current app session may be selected transiently; after restart, press `SELECT EXPORT` explicitly.
- **"Put the INTRO concat into the exporter"** → Normal Export must remain unchanged. The independent controller re-renders only the intro, stream-copies the main H.264 video, normalizes audio to AAC, and owns concat/finalization.
- **"Make saving faster/simpler"** → Saving is deliberately crash-safe mid-write. Do not simplify it.

---

## 4. How to verify a change (QA)

**1) Automated checks (the LLM runs them)**

Ask it to run `npm.cmd run check`, then `npm.cmd run smoke`. `CHECK_OK` and `SMOKE_OK` mean the current automated regression scope passed; they do not prove every behavior or visual detail.

**2) Look with your eyes (you do this)**

Automated checks cannot judge whether a color looks wrong or a position feels off. Visual changes to the screen or subtitle must be seen by running the app. Ask the LLM to tell you, in order, what to click.

**3) Export changes**

`npm.cmd run smoke:export` verifies a temporary Export path and then deletes the result. For final visual QA, export a separate video through the real app's `EXPORT H.264` control and inspect it yourself.

**4) INTRO changes**

Create or select a normal Export, open `INTRO`, confirm the large independent builder shows the same scene as its output, edit prompt/reply and both typing choices, then build a demo. Confirm the source Export remains unchanged and the new file appears as `output/workflow_showcase_demo_*.mp4`. Restart once and confirm the builder requires `SELECT EXPORT` instead of choosing the newest file automatically.

---

## 5. Rolling back when something goes wrong

- **Before committing**: first inspect the Git diff and revert **only the changes made for the current request**. If a file already contained unrelated work, tell the LLM not to restore the whole file or use `reset`/`checkout` without your approval.
- **When the cause is unclear**: do not edit code first — follow [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md), inspect the latest 20–50 events in `current-job/logs/app.log`, and correlate the operation/transaction before deciding what failed.
- **When the app will not start or save**: do not delete files at random; get a status report first. Most originals are designed to be preserved.

---

## One-line summary

**"Read the contracts, preserve existing work, ask before risky changes, run check and smoke"** — make these a habit and you can direct changes safely without reading code.
