# SpecExporter

An After Effects ScriptUI panel that exports selected keyframes as Spectrum-compatible JSON.

## Install

Copy `SpecExporter.jsx` to:
- **Mac:** `~/Library/Application Support/Adobe/After Effects <version>/Scripts/ScriptUI Panels/`
- **Windows:** `C:\Program Files\Adobe\Adobe After Effects <version>\Support Files\Scripts\ScriptUI Panels\`

Restart AE, then open via **Window → SpecExporter.jsx**.

## Usage

1. Animate a layer in After Effects
2. Select the keyframes you want to spec (exactly 2 per property for a start→end pair)
3. Set the scale dropdown to match your comp resolution (2x for a 1608px-wide comp, etc.)
4. Click **Copy JSON**
5. Paste into Spectrum's "Paste Spec" modal

## Scale Setting

The scale dropdown divides pixel values to output logical 1x pixels:
- Working in a **2x comp** (1608px wide) → set to **2x**
- Working in a **4x comp** (3216px wide) → set to **4x**
- Working in a **1x comp** → set to **1x**

## Dependencies

- None. Single `.jsx` file, no build step.
- Reads [Sproing](https://aescripts.com/sproing/) layer markers for spring physics data when present.
- Reads Fit to Shape and Squircle pseudo-effect parameters when present.

## See Also

`DECISIONS.md` documents all design decisions, the output JSON schema, and known limitations.
