# SpecExporter — Design Decisions & Context

An After Effects ScriptUI panel that exports selected keyframes as Spectrum-compatible JSON.

---

## What This Is

A dockable AE panel (`.jsx` ExtendScript) that a motion designer uses during spec-making:
1. Animate something in After Effects
2. Select the keyframes you want to spec
3. Set the scale factor
4. Click "Copy JSON"
5. Paste into Spectrum (or any downstream viewer/tool)

It is **not** a Lottie exporter, not a full animation exporter, and not tied to any particular layer structure. It only captures what the designer explicitly selects.

---

## Scope Decisions

### Works on selected keyframes, not selected layers
The unit of work is keyframe selection in the timeline — not layer selection in the comp panel. This mirrors how InspectorSpacetime works and matches the designer workflow: you pick exactly the keyframes that matter for the spec, nothing more.

### Multi-keyframe sequences supported
Each animated property exports one animation entry per consecutive keyframe pair. With 3 selected keyframes on Scale you get two entries: k1→k2 then k2→k3. Each segment has its own timing, easing, and spring marker lookup (spring lookup uses the segment's own start time). The viewer renders these as separate rows — one per segment — matching how multi-step animations (scale up then spring down, rotate pause rotate back) are already manually spec'd in Spectrum.

Two selected keyframes = one pair = one entry, identical to the old behaviour.

### Baked spring keyframes collapse into one entry
Sproing bakes a spring by writing many consecutive linear keyframes between a blue start key and a blue end key, with a layer marker at the start key containing the spring parameters. Selecting all of those keyframes would generate dozens of useless intermediate entries with the naive consecutive-pair loop.

Detection: `findSpringDataExact` checks whether a keyframe has a Sproing marker at its **exact** time (within 1ms). The regular `findSpringData` has a fuzzy second-pass fallback that would incorrectly match intermediate baked keyframes (they're near the spring-start marker in time but don't own one). The exact version is used only for boundary detection; the fuzzy version is still available for pseudo-effect properties where timing may drift slightly.

When a spring start is detected, the loop scans forward to find the last selected key before the next spring start (or the last selected key overall), and generates **one** entry spanning that full range.

### Zero-change pairs (pauses) are skipped
If a keyframe pair has identical start and end values it represents a pause — no motion, no animation to spec. These are silently dropped. Previously they produced "X stays at Y" rows in the viewer. A rotate→pause→rotate-back selection correctly yields two rotation entries with a natural timing gap, no pause row.

### Scale factor divides pixel values to logical (1x) pixels
The dropdown (1x–6x, default 2x) represents the resolution of the AE comp. Pixel values are **divided** by this factor to output logical 1x pixel values. The assumption is: the designer is working in a native-resolution AE comp and wants the spec to show logical pixel values for engineers.

- 2x comp (1608px wide) → set to 2x → values ÷ 2 → logical pixels
- 4x comp (3216px wide) → set to 4x → values ÷ 4 → logical pixels
- 1x comp → set to 1x → values unchanged

Properties that get scaled: `Position`, `X Position`, `Y Position`, `Z Position`, `Anchor Point`, `Width`, `Height`, `Size`.

Properties that do NOT get scaled: `Opacity` (%), `Rotation` (degrees), `Scale` (%), `Unified Radius` / corner radius values.

### Compound properties split into dimensions
AE's `Position` property is a 2D array `[x, y]`. The output splits this into two separate animation entries: `X Position` and `Y Position`. This matches Spectrum's convention. Only X and Y are captured for now (no Z/3D).

If the user has "Separate Dimensions" enabled on a position property, AE already exposes them as individual scalar properties — the script handles both cases correctly.

---

## Output Format

The JSON schema is designed to be directly paste-able into Spectrum's "Paste Spec" modal. Full structure:

```json
{
  "compName": "MyComp",
  "workArea": { "duration": 800 },
  "layers": [
    {
      "layerName": "Button",
      "parenting": { "parentId": "2", "parentName": "Root" },
      "animations": [
        {
          "property": "X Position",
          "timing": { "delay": 0, "duration": 300 },
          "easing": { "type": "custom", "cubicBezier": "0.4,0,0.2,1" },
          "values": {
            "formatted": { "startValue": "0", "endValue": "240" }
          }
        }
      ]
    }
  ]
}
```

- Durations and delays are in **milliseconds**
- Values are **strings** (Spectrum's convention)
- `parenting` is included when the layer has a parent, omitted otherwise
- `description` fields (per-animation natural language) are intentionally absent here — those get generated downstream in the viewer/Spectrum, not in AE

---

## Easing Conversion

AE stores easing as influence (0–100) and speed per keyframe handle, not as cubic bezier. The conversion approximation:

```
x1 = outInfluence / 100
x2 = 1 - (inInfluence / 100)
y1 = (outSpeed ≈ 0) ? 0 : x1    // flat tangent → y=0, sloped → tracks x
y2 = (inSpeed  ≈ 0) ? 1 : x2
```

Common presets are detected and named (`linear`, `ease`, `ease-in`, `ease-out`). Everything else outputs as `{ "type": "custom", "cubicBezier": "x1,y1,x2,y2" }`.

This is an approximation — AE's speed-based easing doesn't map 1:1 to cubic bezier. It's accurate for standard ease presets but may drift for heavily customized graph editor curves. A more precise conversion would require sampling the velocity curve, which is a future improvement if needed.

---

## Technical Notes

### ExtendScript (ES3) constraints
AE scripts run in ExtendScript, which is ES3 — no `JSON.stringify`, no `Array.forEach`, no arrow functions, no `const`/`let`. The file includes a hand-rolled JSON serializer and uses `var` throughout.

### Clipboard
Uses `system.callSystem` with `pbcopy` (Mac) or `clip` (Windows), writing through a temp file. AE's ExtendScript has no native clipboard API.

### No external dependencies
The script is a single self-contained `.jsx` file. No npm, no build step, no aeQuery library (unlike InspectorSpacetime). Drop it in the ScriptUI Panels folder and it works.

---

## Spring Data (Sproing Integration)

When a Sproing-baked spring is on the layer, the `easing` field is replaced entirely with a spring physics object instead of a cubic bezier. The curve easing is irrelevant for spring animations — the baked keyframes are just a rendering artifact; the parameters are the ground truth.

**Spring easing shape:**
```json
{
  "type": "spring",
  "preset": "Standard Spring",
  "stiffness": 100,
  "damping": 12.5,
  "dampingRatio": 0.5,
  "mass": 1,
  "initialVelocity": [15.5, -8.2]
}
```

- `preset` — the named preset from Sproing's UI (e.g. "Fast Spring", "Custom Spring"). Included when present, omitted otherwise.
- `initialVelocity` — only present if the user explicitly set it in Sproing (Sproing omits it when zero). Can be a single number (scalar properties) or an array (2D properties like Position).
- `mass` is always 1 in current Sproing — included for completeness.

**How the lookup works:**
1. Get the layer's `ADBE Marker` property
2. For each marker, check if `abs(markerTime - keyStartTime) < 0.001s`
3. If match found, split the marker comment on `=======` to get blocks
4. Find the block containing `| Property: <prop.matchName>`
5. Parse `Stiffness`, `Damping`, `Damping Ratio`, `Mass`, and optional `Initial Velocity` lines

**Velocity scaling:** `initialVelocity` values are scaled by the same factor as pixel positions. Sproing stores velocity in AE comp units; our scale factor converts to the target resolution, so velocity must match.

**Fallback:** If no marker is found at the keyframe time (or the marker doesn't contain a block for that property), the script falls back to normal curve-based easing extraction. The two paths are completely independent.

---

## Fit to Shape Effect

"Fit to shape" is a third-party AE effect that scales and aligns a layer to fit inside a parent shape layer. When present on a layer, we read its parameters and include them in the layer entry.

**Output shape — `isFitToShape` + details on both layer and each animation:**
```json
{
  "layerName": "Start a new search",
  "isFitToShape": true,
  "animations": [
    {
      "property": "Opacity",
      "isFitToShape": true,
      "fitToShape": {
        "containerLayerName": "Search Container",
        "alignment": 1,
        "scaleTo": 1
      }
    }
  ]
}
```

`containerLayerName` is the parent layer's name (the shape it fits to). `alignment` and `scaleTo` are stored as 1-based integers matching AE's dropdown indices.

**Alignment options** (AE uses non-consecutive values matching Spectrum viewer — skips 4 and 8):
- 1: Center, 2: Center Left, 3: Center Right
- 5: Top Center, 6: Top Left, 7: Top Right
- 9: Bottom Center, 10: Bottom Left, 11: Bottom Right

**Scale To options (1–4):**
1. Width
2. Height
3. Stretch
4. None

The lookup tables `FTS_ALIGNMENT` and `FTS_SCALE_TO` in the script map these integers to strings for documentation, but the JSON stores the raw integers to match the reference plugin's schema.

Effect detection is by display name `"fit to shape"` (case-insensitive). Properties are read by index (1 = Alignment, 2 = Scale To) since third-party effect matchNames are not standardized.

---

## Reference Projects

- **Spectrum** (`~/Documents/Prototypes/Spectrum`) — the downstream viewer this JSON feeds into. Has a "Paste Spec" modal that accepts this exact schema. Source of truth for the JSON format.
- **InspectorSpacetime** (https://github.com/google/inspectorspacetime) — the main inspiration for the AE-side approach. Uses selected keyframes as the unit of work, same as this tool. Their output format is different (seconds not ms, no start/end values, easing as array not string) so we did not adopt it directly.

---

## Fields We Intentionally Don't Output

These fields appear in the reference plugin's JSON but are either viewer-authored, Figma-specific, or not derivable from AE:

| Field | Reason skipped |
|---|---|
| `hideBezel` | Added by the Spectrum viewer, not by the exporter |
| `parentingDescription` | HTML annotation string, manually authored in the viewer |
| `customColor` / `customColorPerVideo` | Color coding per video reference, viewer-only |
| `isFitToShape` / `fitToShape` | Read directly from AE — see "Fit to Shape" section below |
| `durationUserSet` | Can't distinguish user-set vs physics-determined from keyframe data alone |
| `customEasing` (string) | Only appears on placeholder/annotation rows with no real keyframes — we never produce those |
| `isGrouped` / `groupType` / `groupedAnimations` | Spectrum re-groups flat X/Y position entries itself via `groupAnimations()` on paste |
| `animatingProperties` in parenting | Computed by the viewer from the animation list |
| `via` in parenting | Manually authored viewer annotation |
| `cubicBezierPreset` | Airbnb/Figma named curve library, not available in AE |

---

## Planned / Not Yet Built

- **Natural language descriptions** — per-animation `description` field. Intentionally deferred to the downstream viewer. The viewer generates these from the timing/easing/value data.
- **Hold keyframe handling** — currently outputs `{ "type": "hold" }` but Spectrum's behavior with hold keyframes is untested.
- **Easing precision** — more accurate cubic bezier conversion by sampling the AE velocity curve rather than approximating from influence/speed.
