# XML Compatibility

## Supported in this beta

Character Workflow Portable reads xmeml, the legacy Final Cut Pro 7 XML Interchange Format.

Currently validated scope:

- sequence name, duration, timebase
- video track and clipitem timing
- source in and out
- PRIMARY timeline from track priority
- exclusion of clips whose enabled is FALSE
- source identity from repeated file references
- transitionitem end points included in the sequence content length
- limited duration recovery for clips whose transition-bound start or end is -1

The primary validation fixture was exported as Final Cut Pro XML from Adobe Premiere Pro 2026 v26.2.2 (Build 3).

## Not supported

- modern Final Cut Pro XML (.fcpxml)
- CapCut projects
- Premiere projects (.prproj)
- full interpretation of nested sequences and multicam
- speed changes and time remapping
- reproduction of audio edit structure

CapCut projects are not supported; this beta has no CapCut timeline adapter.

## Effects and transitions

Even when filter or effect metadata exists in the XML, this beta parser does not interpret or reproduce effects.

Examples:

- horizontal flip
- Transform and Crop
- masks
- keyframes
- color adjustment
- the visual effect of dissolves

transitionitem is used only for some clip boundary and content-length calculations. The reference for the final picture is the finished video exported from the same sequence, not the XML.

## Contributions

Propose FCPXML adapter contributions as a separate input adapter that normalizes into the common timeline model without modifying the existing xmeml parser. Synthetic fixtures and regression checks against the existing parser are required.
