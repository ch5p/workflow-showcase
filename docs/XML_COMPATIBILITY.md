# XML Compatibility

## Supported in this beta

Workflow Showcase reads xmeml, the legacy Final Cut Pro 7 XML Interchange Format.

Currently validated scope:

- sequence name, duration, timebase
- video track and clipitem timing
- source in and out
- PRIMARY timeline from track priority
- exclusion of clips whose enabled is FALSE
- exclusion of Premiere Adjustment Layers before PRIMARY timeline calculation
- source identity from repeated file references
- transitionitem end points included in the sequence content length
- limited duration recovery for clips whose transition-bound start or end is -1

The primary regression fixture was exported as Final Cut Pro XML from Adobe Premiere Pro 2026 v26.2.2 (Build 3). Maintainer visual QA also confirmed that Final Cut Pro 7 XML exported by DaVinci Resolve 21.0.2 follows the same working input path.

VEGAS Pro can export a `Final Cut Pro 7/DaVinci Resolve (*.xml)` project. That output is likely compatible with the same xmeml input, but no real VEGAS fixture has been tested. Treat it as a possibility, not verified support.

## Experimental CapCut input

Workflow Showcase can read a local Windows CapCut Desktop 9.x project folder containing `draft_content.json`. Save the project, leave that project or close CapCut, then select `TIMELINE` > `CAPCUT PROJECT · EXPERIMENTAL`. No XML export is required. The separately exported final H.264 MP4 is still required as the visual source.

The app extracts visible video-segment timing and layer order into an anonymous app-owned snapshot. It does not store the raw CapCut JSON or absolute media paths. Audio, text, stickers, effects, and transitions are not reconstructed; they remain visible only because they are already rendered into the final MP4.

Verified scope: Windows CapCut Desktop 9.x local projects. Other desktop major versions, mobile/cloud-only projects, compound or nested editing structures, and structurally different drafts are not verified.

## Platform

This beta application is Windows-only. macOS execution is not supported. This runtime limit is separate from the XML format: an XML file exported on another system may still be loaded into the Windows app when it is valid legacy xmeml.

## Not supported

- modern Final Cut Pro XML (.fcpxml)
- Premiere projects (.prproj)
- full interpretation of nested sequences and multicam
- speed changes and time remapping
- reproduction of audio edit structure

## Effects and transitions

Even when filter or effect metadata exists in the XML, this beta parser does not interpret or reproduce effects.

Premiere Adjustment Layers are intentionally ignored before EDIT/SHOT detection. Their filter names and parameters are not exposed in the UI or stored in Job data, so a full-length Adjustment Layer cannot replace the actual edited video tracks as PRIMARY.

Examples:

- horizontal flip
- Transform and Crop
- masks
- keyframes
- color adjustment
- the visual effect of dissolves

transitionitem is used only for some clip boundary and content-length calculations. The reference for the final picture is the finished video exported from the same sequence, not the XML.

## Contributions

Propose FCPXML, another editor adapter, or optional Adjustment Layer/effect support as a separate input adapter that follows the [Input Adapter Contract](INPUT_ADAPTER_CONTRACT.md) without modifying the existing xmeml parser or PRIMARY renderer. Synthetic fixtures and regression checks against both current adapters are required.
