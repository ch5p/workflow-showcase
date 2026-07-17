# Classic presentation

`tokens.css` owns the classic color and typography tokens. `classic.css` owns the 1280 × 1080 placement.

Layout changes do not modify the parser or timeline calculations in `src/core`. For a different fixed aspect ratio, see [Customizing](../../../CUSTOMIZING.md) and [Classic Layout](../../../docs/CLASSIC_LAYOUT.md).

Local map:

- Callout and reference-card visual selectors live in `classic.css`.
- Fixed panel height also uses `CONFIG.panelHeight`, `applyLayout()`, and `fitScale()` in `../../output-preview.html`.
- Reference-card density also uses the packing-only values inside `positionReferenceDock()`; do not rewrite its LEAD-IN, crossfade, visibility, or cleanup logic.
- A second coexisting layout requires an explicit architecture decision. Do not silently add a selector, registry, or Job layout field.
