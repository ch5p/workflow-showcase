# Input Adapter Contract

This contract defines how a future input format reaches the existing timeline renderer without rewriting the legacy xmeml parser, PRIMARY calculation, SHOT identity, reference mapping, or Job safety code.

The stable production input is Final Cut Pro 7 XML (`xmeml`). Adobe Premiere Pro and DaVinci Resolve 21.0.2 exports have been validated in the app. VEGAS Pro can export the same named interchange format and may work, but remains unverified without a real fixture. An experimental second adapter reads local Windows CapCut Desktop 9.x projects through `draft_content.json`. Modern `.fcpxml` is not implemented, and the beta application itself is Windows-only.

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

The lifecycle is format-aware but intentionally small. xmeml uses `candidate.xml` and `source/timeline.xml`; the experimental CapCut adapter uses `candidate.capcut.json` and `source/timeline.capcut.json`. Both use the same verified transaction journal, but their candidate names, canonical names, parser dispatch, and rollback identities remain explicit. Do not disguise another format as XML.

## Format-specific rules

### Legacy xmeml

- Keep `src/core/xmeml-parser.js` unchanged.
- Keep `src/adapters/xmeml-unsupported-layers.js` before PRIMARY inspection.
- The current function name `parseSupportedFCPXML()` is historical and parses legacy xmeml; it does not mean modern Apple FCPXML is supported.
- Premiere Pro and DaVinci Resolve are validated exporters. VEGAS Pro is only a plausible exporter until a real fixture passes the same checks.

### CapCut Desktop 9.x local draft (experimental)

- `src/adapters/capcut-draft-parser.js` accepts a Windows CapCut Desktop 9.x `draft_content.json` selected by the user. The app does not scan or watch every CapCut project in the background.
- Main reads the selected file only long enough to validate it and create an app-owned snapshot. The raw CapCut JSON, device identifiers, account data, and absolute media paths are not copied into Current Job.
- The snapshot stores only normalized integer-frame timeline data, anonymous source identities, the selected project name, and the verified CapCut editor version.
- Target and source ranges are converted from microseconds with `Math.round(microseconds * fps / 1_000_000)`. Segment `render_index` determines video-layer order; a larger value is visually above a smaller value. `visible: false` excludes a segment.
- Only ordinary video materials are retained. Audio, text, stickers, effects, transitions, and other CapCut materials are not reconstructed because the separately loaded finished MP4 remains the visual source.
- UPDATE is allowed only between inputs of the same format. Switching between xmeml and CapCut requires NEW JOB because source-identity evidence is editor-specific.
- CapCut mobile/cloud-only projects, compound or nested editing structures, other desktop major versions, and encrypted or structurally different drafts are unverified and must fail before Current Job mutation.

### Modern FCPXML

- Implement a separate parser that normalizes roles, resources, timing rationals, enabled state, source identity, and layered video into the shared frame model.
- Define the sequence FPS and rounding rules before converting rational time to frames.
- Do not add support by weakening the existing `.xml` validation or rewriting the xmeml parser.

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

The CapCut conformance fixture is `fixtures/capcut-9x/public-fixture/draft_content.json`. Its expected PRIMARY order is A, C, B, A at 24 fps and 186 frames, producing four EDITS and three SHOTS. `scripts/check-capcut-adapter.cjs` verifies parsing, anonymized snapshot creation, NEW JOB install, same-format UPDATE, and preservation of the existing video during UPDATE.

The current two-format dispatch is intentionally explicit. Do not replace it with a plugin registry until another real adapter proves that a registry is needed; extend only the smallest input boundary required by verified formats.
