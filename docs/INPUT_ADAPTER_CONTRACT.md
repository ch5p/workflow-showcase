# Input Adapter Contract

This contract defines how a future input format reaches the existing timeline renderer without rewriting the legacy xmeml parser, PRIMARY calculation, SHOT identity, reference mapping, or Job safety code.

The current production input is Final Cut Pro 7 XML (`xmeml`), including XML exported by Adobe Premiere Pro. Modern `.fcpxml`, CapCut projects, and VIDEO ONLY automatic cut detection are not implemented.

## Normalized parsed timeline

An input adapter must produce this JavaScript shape before the existing PRIMARY and SHOT core runs:

```js
{
  fps,          // positive frames per second
  duration,     // total duration in integer frames
  name,         // user-facing sequence name
  clips: [{
    track,      // positive integer; a larger number is visually above a smaller number
    name,       // source/clip label
    start,      // inclusive timeline frame
    end,        // exclusive timeline frame; end > start
    in,         // inclusive source frame corresponding to clip start
    out,        // source-frame endpoint
    enabled,    // false excludes the clip from PRIMARY selection
    fileId,     // format-local source identifier, or an empty string
    sourceId,   // stable identity used to group repeated edits of the same source
  }],
  warns: [],    // non-fatal, user-reportable adapter warnings
  workArea,     // null or { in, out } in timeline frames
}
```

All time values passed to the existing core are frames, not seconds, milliseconds, or microseconds. `duration`, clip boundaries, source ranges, and work-area boundaries must be finite integers. Every retained clip must satisfy `start >= 0`, `end > start`, and `duration >= end`.

`sourceId` is the identity contract. Repeated edits of the same source must receive the same stable value, while different sources must not collide. Never persist a raw absolute source path in Job data. A parser may normalize a source path in memory to derive identity, as the current xmeml parser does, but the saved SHOT descriptor remains anonymous.

## Existing downstream model

Do not make an adapter emit Job mappings directly. The normalized timeline goes through the existing modules in this order:

1. format-specific parsing and unsupported-layer filtering;
2. `src/core/primary-timeline.js`, which selects the highest enabled track at each boundary;
3. `src/core/shot-model.js`, which derives anonymous SHOT descriptors;
4. `timeline-reconcile.cjs`, which rematches previous mappings during UPDATE;
5. the existing preview and renderer.

The SHOT inspection result contains:

```js
{
  fps,
  durationFrames,
  name,
  edits,
  shots: [{
    id,
    identityKey,
    nameKey,
    edits,
    startFrame,
    endFrame,
    occurrences: [{ startFrame, endFrame, inFrame, outFrame }],
  }],
}
```

`identityKey` and `nameKey` are anonymous fingerprints created by the existing SHOT core. An adapter must not invent replacements for those keys or bypass reconciliation.

## Input-boundary checklist

Adding one parser file is not sufficient. Before implementation, report every affected boundary:

- editor extension/drop routing in `src/mvp-app.js` and `src/output-preview.html`;
- Main file picker and file-size/type inspection in `main.cjs`;
- candidate filename, extension validation, commit, rollback, and recovery in `job-lifecycle.cjs` or a deliberately separate lifecycle;
- parser dispatch in `src/output-preview.html` and the offscreen Export path;
- canonical stored filename and `job.json` descriptor;
- format-specific unsupported-layer policy before PRIMARY inspection;
- public fixture, malformed-input fixture, and regression checks;
- README, compatibility, Project Map, troubleshooting, and public-tree inclusion.

The current lifecycle is intentionally hard-coded to `.xml`, `candidate.xml`, and `source/timeline.xml`. A new extension or VIDEO ONLY source must make an explicit storage/lifecycle decision. Do not disguise another format as XML or silently reuse the XML transaction without verifying rollback and recovery.

## Format-specific rules

### Legacy xmeml

- Keep `src/core/xmeml-parser.js` unchanged.
- Keep `src/adapters/xmeml-unsupported-layers.js` before PRIMARY inspection.
- The current function name `parseSupportedFCPXML()` is historical and parses legacy xmeml; it does not mean modern Apple FCPXML is supported.

### Modern FCPXML

- Implement a separate parser that normalizes roles, resources, timing rationals, enabled state, source identity, and layered video into the shared frame model.
- Define the sequence FPS and rounding rules before converting rational time to frames.
- Do not add support by weakening the existing `.xml` validation or rewriting the xmeml parser.

### VIDEO ONLY / automatic cut detection

- Treat detected boundaries as an approximate adapter result and expose that limitation to the user.
- Do not claim repeated-source identity when the finished video cannot provide it. A safe initial contract is one deterministic synthetic source identity per detected cut, meaning one CUT equals one SHOT.
- Record detection warnings and sensitivity/settings needed to reproduce the same boundaries.
- Preserve the original video import preflight and commit contract. Detection must not replace or weaken video validation.

### CapCut

- Do not claim official CapCut project support without an official interchange format.
- An experimental local-draft reader must be read-only, version-gated, and isolated as a format adapter. It must never modify the user's CapCut project.
- Prefer the editor-neutral VIDEO ONLY path when exact draft parsing is unavailable.

## Conformance and QA

Every new adapter requires:

1. a redistributable synthetic fixture with provenance;
2. a valid parse result with deterministic normalized fields;
3. malformed/unsupported input rejection that leaves the Current Job unchanged;
4. PRIMARY/SHOT expectations for the fixture;
5. UPDATE reconciliation expectations when timing changes;
6. preview and offscreen Export parity;
7. `npm.cmd run check`, isolated smoke, and real visual QA;
8. documentation that states supported versions, unverified cases, and known loss of information.

Do not create a plugin registry before a real second adapter exists. When the second adapter is implemented, introduce only the smallest dispatch surface required by both real formats.
