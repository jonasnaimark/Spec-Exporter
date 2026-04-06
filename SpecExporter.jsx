/**
 * SpecExporter.jsx
 * After Effects ScriptUI Panel
 *
 * Exports selected keyframe pairs as Spectrum-compatible JSON.
 * Reads Sproing layer markers to include spring physics parameters.
 * Select keyframes on one or more layers, set the scale factor,
 * then click "Copy JSON" — output is ready to paste into Spectrum.
 *
 * Install: Copy to After Effects/Scripts/ScriptUI Panels/
 */

(function (thisObj) {

    // ─── Constants ─────────────────────────────────────────────────────────────

    var VERSION       = "1.0.0";
    var SCALE_OPTIONS = ["1x", "2x", "3x", "4x", "5x", "6x"];
    var DEFAULT_SCALE = 1; // index → "2x"

    // Properties where values are in pixels (divided by scale to get logical 1x pixels)
    var PIXEL_PROPS = {
        "Position":     true,
        "X Position":   true,
        "Y Position":   true,
        "Z Position":   true,
        "Anchor Point": true,
        "Width":        true,
        "Height":       true,
        "Size":         true
    };

    // Compound position stays as [x,y] — Spectrum uses animatingAxes to determine
    // which axes to describe. Separated dimensions ("X Position"/"Y Position") already
    // come in as individual scalar properties and are handled in the scalar path.

    // Tolerance (seconds) for matching a marker time to a keyframe time
    var MARKER_TIME_EPSILON = 0.001;


    // ─── UI ────────────────────────────────────────────────────────────────────

    var panel = (thisObj instanceof Panel)
        ? thisObj
        : new Window("palette", "Spec Exporter", undefined, { resizeable: false });

    panel.orientation   = "column";
    panel.alignChildren = ["fill", "top"];
    panel.margins       = 12;
    panel.spacing       = 10;

    var scaleGroup = panel.add("group");
    scaleGroup.orientation   = "row";
    scaleGroup.alignChildren = ["left", "center"];
    scaleGroup.spacing       = 6;

    var scaleLabel = scaleGroup.add("statictext", undefined, "Scale:");
    scaleLabel.preferredSize.width = 38;

    var scaleDropdown = scaleGroup.add("dropdownlist", undefined, SCALE_OPTIONS);
    scaleDropdown.selection           = DEFAULT_SCALE;
    scaleDropdown.preferredSize.width = 58;

    var copyBtn = panel.add("button", undefined, "Copy JSON");
    copyBtn.preferredSize.height = 28;

    var statusText = panel.add("statictext", undefined, "Select keyframes, then copy.");
    statusText.alignment  = "center";
    statusText.characters = 30;


    // ─── Button handler ────────────────────────────────────────────────────────

    copyBtn.onClick = function () {
        statusText.text = "";
        try {
            var json = buildJson();
            writeToClipboard(json);
            statusText.text = "\u2713 Copied!";
        } catch (e) {
            statusText.text = "Error: " + e.message;
        }
    };


    // ─── Build JSON ────────────────────────────────────────────────────────────

    function buildJson() {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            throw new Error("Open a composition first.");
        }

        var scale   = parseInt(scaleDropdown.selection.text, 10);
        var compTs  = String((new Date()).getTime()); // shared timestamp for layer IDs

        // Pre-generate all layer IDs so parentId references match exactly
        var layerIds = {};
        for (var i = 1; i <= comp.numLayers; i++) {
            layerIds[comp.layer(i).index] = "l_" + compTs + "_" + randomStr(8);
        }

        var compStart = comp.workAreaStart; // delays are relative to work area start
        var layers  = [];

        for (var i = 1; i <= comp.numLayers; i++) {
            var layer      = comp.layer(i);
            var fts        = getFitToShape(layer); // null if effect not present
            var animations = [];
            collectAnimations(layer, layer, animations, scale, fts, compStart);

            if (animations.length > 0 || fts) {
                var entry = {
                    layerName:  layer.name,
                    animations: animations,
                    layerType:  getLayerType(layer),
                    id:         layerIds[layer.index]
                };
                if (layer.parent) {
                    entry.parenting = {
                        parentId:   layerIds[layer.parent.index],
                        parentName: layer.parent.name
                    };
                }
                // isFitToShape on layer — includes parentingDescription so the viewer
                // shows "Scales to fit width of X - Aligned Y" without needing an annotation entry
                if (fts) {
                    entry.isFitToShape          = true;
                    entry.fitToShape            = fts;
                    entry.parentingDescription  = ftsParentingDescription(fts);
                }
                layers.push(entry);
            }
        }

        if (layers.length === 0) {
            throw new Error("No selected keyframe pairs found.");
        }

        var spec = {
            compName: comp.name,
            name:     comp.name,
            workArea: {
                start:    Math.round(comp.workAreaStart    * 1000),
                duration: Math.round(comp.workAreaDuration * 1000)
            },
            layers: layers,
            metadata: {
                version:     VERSION,
                timestamp:   new Date().toString(),
                exportedBy:  "SpecExporter",
                composition: {
                    width:             comp.width,
                    height:            comp.height,
                    frameRate:         comp.frameRate,
                    appliedScale:      scaleDropdown.selection.text,
                    scaleMode:         "manual",
                    scaleSettingIndex: scaleDropdown.selection.index
                }
            }
        };

        return jsonStringify(spec);
    }


    // ─── Property traversal ────────────────────────────────────────────────────

    function collectAnimations(layer, propGroup, animations, scale, fts, compStart) {
        var n;
        try { n = propGroup.numProperties; } catch (e) { return; }

        for (var i = 1; i <= n; i++) {
            var prop;
            try { prop = propGroup.property(i); } catch (e) { continue; }
            if (!prop) continue;

            try {
                if (prop.propertyType === PropertyType.PROPERTY) {
                    var sel = prop.selectedKeys;
                    if (sel && sel.length >= 2) {
                        var entries = extractEntries(layer, prop, sel, scale, fts, compStart);
                        for (var j = 0; j < entries.length; j++) animations.push(entries[j]);
                    }
                } else {
                    collectAnimations(layer, prop, animations, scale, fts, compStart);
                }
            } catch (e) {}
        }
    }


    // ─── Extract animation entries ─────────────────────────────────────────────

    function extractEntries(layer, prop, selectedKeys, scale, fts, compStart) {
        var name    = prop.name;
        var results = [];
        var s = 0;

        while (s < selectedKeys.length - 1) {
            var k1        = selectedKeys[s];
            var startTime = prop.keyTime(k1);

            // Use exact-time spring detection for boundary logic.
            // The fuzzy second-pass in findSpringData would falsely match baked
            // intermediate keyframes (they sit near the spring-start marker in time),
            // so we only use it for actual parameter extraction below.
            var springData = findSpringDataExact(layer, startTime, prop.matchName);

            var k2, endTime, endIdx;

            if (springData) {
                // ── Spring segment ──────────────────────────────────────────────
                // Find the end of this spring: last selected key before the next
                // spring start marker, or the last selected key if none found.
                endIdx = selectedKeys.length - 1;
                for (var t = s + 1; t < selectedKeys.length - 1; t++) {
                    if (findSpringDataExact(layer, prop.keyTime(selectedKeys[t]), prop.matchName)) {
                        endIdx = t - 1;
                        break;
                    }
                }
                k2      = selectedKeys[endIdx];
                endTime = prop.keyTime(k2);
                s       = endIdx; // advance past all baked intermediate keyframes

            } else {
                // ── Curve segment ───────────────────────────────────────────────
                // Single consecutive pair.
                endIdx  = s + 1;
                k2      = selectedKeys[endIdx];
                endTime = prop.keyTime(k2);
                s       = endIdx;
            }

            var delay    = Math.round((startTime - compStart) * 1000);
            var duration = Math.round((endTime - startTime) * 1000);
            if (duration <= 0) continue;

            var rawStart = prop.keyValue(k1);
            var rawEnd   = prop.keyValue(k2);
            var easing   = springData
                ? buildSpringEasing(springData, name, scale)
                : extractCurveEasing(prop, k1, k2);

            if (rawStart instanceof Array) {
                // Compound array property (Position, Scale, Anchor Point, etc.)
                var applyScale = !!PIXEL_PROPS[name];
                var svArr = [], evArr = [];
                for (var d = 0; d < Math.min(rawStart.length, 2); d++) {
                    var sv = rawStart[d], ev = rawEnd[d];
                    if (applyScale) { sv = sv / scale; ev = ev / scale; }
                    svArr.push(sv);
                    evArr.push(ev);
                }
                results.push(makeEntry(
                    name, delay, duration, easing,
                    svArr, evArr,
                    { isSpring: !!springData, fts: fts }
                ));
            } else {
                // Scalar property
                var sv = rawStart, ev = rawEnd;
                if (PIXEL_PROPS[name]) { sv = sv / scale; ev = ev / scale; }
                results.push(makeEntry(
                    name, delay, duration, easing,
                    sv, ev,
                    { dimension: dimFromName(name), isSpring: !!springData, fts: fts }
                ));
            }
        }

        return results;
    }

    function makeEntry(propName, delay, duration, easing, startVal, endVal, opts) {
        opts = opts || {};
        var isSpring = !!opts.isSpring;

        var entry = {
            property:     propName,
            hasKeyframes: true,
            easing:       easing,
            timing:       { delay: delay, duration: duration },
            values:       makeValues(propName, startVal, endVal, opts.dimension),
            movement:     null
        };

        if (isSpring) {
            entry.calculatedSpringDuration = duration;
        }

        // Fit to Shape: flag + details on each animation (matches reference schema)
        if (opts.fts) {
            entry.isFitToShape = true;
            entry.fitToShape   = opts.fts;
        }

        return entry;
    }


    // ─── Values object ─────────────────────────────────────────────────────────

    function makeValues(propName, startVal, endVal, dimension) {
        var type = getValueType(propName);

        if (startVal instanceof Array) {
            var change = [];
            for (var i = 0; i < startVal.length; i++) {
                change.push(endVal[i] - startVal[i]); // full precision
            }
            var obj = {
                startValue: startVal, // full AE float precision
                endValue:   endVal,
                change:     change,
                type:       type,
                formatted: {
                    startValue: fmtArrVal(propName, startVal),
                    endValue:   fmtArrVal(propName, endVal),
                    change:     fmtArrChange(propName, change)
                }
            };
            // Compound Position: add animatingAxes so the viewer only describes moving axes
            if (propName === "Position") {
                var xMove = change.length > 0 && Math.abs(change[0]) > 0.5;
                var yMove = change.length > 1 && Math.abs(change[1]) > 0.5;
                obj.animatingAxes = {
                    x:       xMove,
                    y:       yMove,
                    both:    xMove && yMove,
                    neither: !xMove && !yMove
                };
            }
            return obj;
        }

        // Scalar
        var change = endVal - startVal; // full precision
        return {
            startValue: startVal, // full AE float precision
            endValue:   endVal,
            change:     change,
            type:       type,
            formatted: {
                startValue: fmtScalarVal(propName, startVal, dimension),
                endValue:   fmtScalarVal(propName, endVal,   dimension),
                change:     fmtScalarChange(propName, change, dimension)
            }
        };
    }

    // Corner radius property names (AE uses various names depending on layer/plugin)
    var CORNER_RADIUS_PROPS = {
        "Unified Radius": true,
        "Roundness":      true,
        "Round Corners":  true,
        "Corner Radius":  true,
        "All corners":    true
    };

    function getValueType(propName) {
        if (propName === "Position" || propName === "X Position" || propName === "Y Position" || propName === "Z Position") return "position";
        if (propName === "Opacity")    return "opacity";
        if (propName === "Scale")      return "scale";
        if (propName === "Width" || propName === "Height" || propName === "Size") return "dimensional";
        if (propName.indexOf("Rotation") !== -1) return "rotation";
        if (CORNER_RADIUS_PROPS[propName]) return "corner_radius";
        if (PIXEL_PROPS[propName])     return "dimensional";
        return "unknown";
    }

    /** Returns "x" or "y" if the property name implies an axis, otherwise undefined. */
    function dimFromName(propName) {
        if (propName === "X Position") return "x";
        if (propName === "Y Position") return "y";
        if (propName === "Z Position") return "z";
        return undefined;
    }

    function fmtScalarVal(propName, val, dimension) {
        var v = Math.round(val * 100) / 100;
        if (propName === "Opacity") return v + "%";
        if (propName.indexOf("Rotation") !== -1) return v + "deg";
        if (CORNER_RADIUS_PROPS[propName]) return v + "px";
        if (PIXEL_PROPS[propName]) {
            if (dimension === "x") return v + "px (X)";
            if (dimension === "y") return v + "px (Y)";
            return v + "px";
        }
        return String(v);
    }

    function fmtScalarChange(propName, change, dimension) {
        var sign = change >= 0 ? "+" : "";
        var v    = Math.round(change * 100) / 100;
        if (propName === "Opacity") return sign + v + "%";
        if (propName.indexOf("Rotation") !== -1) return sign + v + "deg";
        if (CORNER_RADIUS_PROPS[propName]) return sign + v + "px";
        if (PIXEL_PROPS[propName]) {
            if (dimension === "x") return sign + v + "px (X)";
            if (dimension === "y") return sign + v + "px (Y)";
            return sign + v + "px";
        }
        return sign + String(v);
    }

    function fmtArrVal(propName, arr) {
        var parts = [];
        if (propName === "Scale") {
            // Preserve full AE float precision — matches reference plugin behaviour
            for (var i = 0; i < arr.length; i++) parts.push(arr[i] + "%");
            return parts.join(", ");
        }
        if (propName === "Position") {
            // Compound position: (Xpx, Ypx)
            for (var i = 0; i < arr.length; i++) {
                parts.push((Math.round(arr[i] * 100) / 100) + "px");
            }
            return "(" + parts.join(", ") + ")";
        }
        for (var i = 0; i < arr.length; i++) {
            parts.push((Math.round(arr[i] * 100) / 100) + "px");
        }
        return parts.join(", ");
    }

    function fmtArrChange(propName, change) {
        if (propName === "Scale") {
            // Keep sign (negative = scale down) and full precision
            var sign = change[0] >= 0 ? "+" : "";
            return sign + change[0] + "% scale";
        }
        var parts = [];
        for (var i = 0; i < change.length; i++) {
            parts.push((change[i] >= 0 ? "+" : "") + (Math.round(change[i] * 100) / 100) + "px");
        }
        return parts.join(", ");
    }


    // ─── Sproing marker reading ─────────────────────────────────────────────────

    /**
     * Strict spring-start detection: only matches a marker at exactly keyTime
     * (within MARKER_TIME_EPSILON). Used for spring boundary detection in the
     * extractEntries loop so intermediate baked keyframes (which sit near a
     * spring-start marker but don't own one) are not misidentified as spring starts.
     */
    function findSpringDataExact(layer, keyTime, propMatchName) {
        try {
            var markerProp = getMarkerProp(layer);
            if (!markerProp || markerProp.numKeys === 0) return null;
            for (var m = 1; m <= markerProp.numKeys; m++) {
                if (Math.abs(markerProp.keyTime(m) - keyTime) > MARKER_TIME_EPSILON) continue;
                var block = extractBlock(markerProp.keyValue(m).comment, propMatchName);
                if (block) return parseSpringBlock(block);
            }
        } catch (e) {}
        return null;
    }

    function findSpringData(layer, keyTime, propMatchName) {
        try {
            var markerProp = getMarkerProp(layer);
            if (!markerProp || markerProp.numKeys === 0) return null;

            // First pass: markers near the keyframe start time (exact match)
            for (var m = 1; m <= markerProp.numKeys; m++) {
                var mt = markerProp.keyTime(m);
                if (Math.abs(mt - keyTime) > MARKER_TIME_EPSILON) continue;

                var comment = markerProp.keyValue(m).comment;
                var block   = extractBlock(comment, propMatchName);
                if (block) return parseSpringBlock(block);
            }

            // Second pass: search all markers and return the one closest to keyTime
            // that has a block for this property. Handles pseudo-effect properties
            // where Sproing may place the marker at a slightly different time.
            var bestBlock = null;
            var bestDelta = Infinity;
            for (var m = 1; m <= markerProp.numKeys; m++) {
                var mt      = markerProp.keyTime(m);
                var delta   = Math.abs(mt - keyTime);
                var comment = markerProp.keyValue(m).comment;
                var block   = extractBlock(comment, propMatchName);
                if (block && delta < bestDelta) {
                    bestBlock = block;
                    bestDelta = delta;
                }
            }
            if (bestBlock) return parseSpringBlock(bestBlock);
        } catch (e) {}
        return null;
    }

    function getMarkerProp(layer) {
        for (var i = 1; i <= layer.numProperties; i++) {
            try {
                var p = layer.property(i);
                if (p && p.matchName === "ADBE Marker") return p;
            } catch (e) {}
        }
        return null;
    }

    function extractBlock(comment, propMatchName) {
        var blocks = comment.split(/[=]{3,}/);
        var needle = "| Property: " + propMatchName;
        var suffix = "/" + propMatchName; // AE omits leading path segments (e.g. "Pseudo/85866-0002" vs "4/1/2/Pseudo/85866-0002")
        for (var i = 0; i < blocks.length; i++) {
            var b = blocks[i];
            if (b.indexOf(needle) !== -1) return b;
            if (b.indexOf("| Property: ") !== -1 && b.indexOf(suffix) !== -1) return b;
        }
        return null;
    }

    function parseSpringBlock(block) {
        var result = { preset: null, stiffness: null, damping: null, dampingRatio: null, mass: 1, initialVelocity: null };
        var lines  = block.split(/\r?\n/);

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].replace(/^\s+|\s+$/g, "");
            if (!line || line.indexOf("|") === 0 || line.indexOf("=") === 0) continue;

            if (line.indexOf("Stiffness:") !== -1) {
                var s  = matchNum(line, /Stiffness:\s*([\d.]+)/);
                var d  = matchNum(line, /Damping:\s*([\d.]+)/);
                var dr = matchNum(line, /Damping Ratio:\s*([\d.]+)/);
                var ms = matchNum(line, /Mass:\s*([\d.]+)/);
                if (s  !== null) result.stiffness   = s;
                if (d  !== null) result.damping      = d;
                if (dr !== null) result.dampingRatio = dr;
                if (ms !== null) result.mass         = ms;
                continue;
            }

            if (line.indexOf("Initial Velocity:") !== -1) {
                var velStr = line.replace(/.*Initial Velocity:\s*/, "").replace(/^\s+|\s+$/g, "");
                result.initialVelocity = parseVelocity(velStr);
                continue;
            }

            if (!result.preset && line.indexOf(":") === -1) {
                result.preset = line;
            }
        }

        return (result.stiffness !== null) ? result : null;
    }

    function parseVelocity(str) {
        str = str.replace(/[\[\]\s]/g, "");
        if (str.indexOf(",") !== -1) {
            var parts = str.split(","), out = [];
            for (var i = 0; i < parts.length; i++) {
                var v = parseFloat(parts[i]);
                if (!isNaN(v)) out.push(v);
            }
            return out.length > 0 ? out : null;
        }
        var v = parseFloat(str);
        return isNaN(v) ? null : v;
    }

    function matchNum(str, re) {
        var m = str.match(re);
        return m ? parseFloat(m[1]) : null;
    }


    // ─── Easing builders ───────────────────────────────────────────────────────

    /**
     * Spring easing — matches reference plugin's nested structure:
     * { type: "spring", spring: { preset, custom: { stiffness, damping, dampingRatio, mass } }, source: "marker" }
     */
    function buildSpringEasing(springData, propName, scale) {
        var custom = {
            stiffness:    springData.stiffness,
            damping:      springData.damping,
            dampingRatio: springData.dampingRatio,
            mass:         springData.mass
        };

        if (springData.initialVelocity !== null && springData.initialVelocity !== undefined) {
            var vel = springData.initialVelocity;
            if (PIXEL_PROPS[propName] && scale !== 1) {
                if (vel instanceof Array) {
                    var scaled = [];
                    for (var i = 0; i < vel.length; i++) scaled.push(r3(vel[i] / scale));
                    vel = scaled;
                } else {
                    vel = r3(vel / scale);
                }
            }
            custom.initialVelocity = vel;
        }

        return {
            type:   "spring",
            spring: {
                preset: springData.preset || "Custom Spring",
                custom: custom
            },
            source: "marker"
        };
    }

    /**
     * Curve-based easing — converts AE influence/speed to cubic-bezier.
     * Matches reference format: { type: "cubic-bezier", cubicBezier: "cubic-bezier(x, y, x, y)", source: "keyframes" }
     * Linear shortcut: { type: "linear", source: null }
     */
    function extractCurveEasing(prop, k1, k2) {
        try {
            var outType = prop.keyOutInterpolationType(k1);
            var inType  = prop.keyInInterpolationType(k2);

            if (outType === KeyframeInterpolationType.HOLD) {
                return { type: "hold", source: "keyframes" };
            }
            if (outType === KeyframeInterpolationType.LINEAR &&
                inType  === KeyframeInterpolationType.LINEAR) {
                return { type: "linear", source: null };
            }

            var outEases = prop.keyOutTemporalEase(k1);
            var inEases  = prop.keyInTemporalEase(k2);
            var outE     = outEases[0];
            var inE      = inEases[0];

            // AE influence (0-100) → x-axis bezier handle
            // speed ≈ 0 → flat tangent → y = 0 (out) or 1 (in)
            var x1 = outE.influence / 100;
            var x2 = 1 - (inE.influence / 100);
            var y1 = (outE.speed < 0.001) ? 0 : x1;
            var y2 = (inE.speed  < 0.001) ? 1 : x2;

            // Degenerate case: both control points on the diagonal → mathematically linear
            if (Math.abs(x1 - y1) < 0.01 && Math.abs(x2 - y2) < 0.01) {
                return { type: "linear", source: null };
            }

            var bezierStr = "cubic-bezier(" +
                fmt2(x1) + ", " + fmt2(y1) + ", " +
                fmt2(x2) + ", " + fmt2(y2) + ")";

            return { type: "cubic-bezier", cubicBezier: bezierStr, source: "keyframes" };
        } catch (e) {
            return { type: "linear", source: null };
        }
    }


    // ─── Layer helpers ─────────────────────────────────────────────────────────

    // Alignment values — AE uses the same non-consecutive numbering as the Spectrum viewer
    // (skips 4 and 8): 1=center, 2=center left, 3=center right, 5=top center, 6=top left,
    // 7=top right, 9=bottom center, 10=bottom left, 11=bottom right
    var FTS_ALIGNMENT_TEXT = {
        1: "center",        2: "center left",  3: "center right",
        5: "top center",    6: "top left",     7: "top right",
        9: "bottom center", 10: "bottom left", 11: "bottom right"
    };

    // Scale To values (1-based AE dropdown index)
    var FTS_SCALE_TO_TEXT = { 1: "width", 2: "height", 3: "stretch", 4: "none" };

    function ftsParentingDescription(fts) {
        var scaleTo   = FTS_SCALE_TO_TEXT[fts.scaleTo]    || "unknown";
        var alignment = FTS_ALIGNMENT_TEXT[fts.alignment] || "unknown";
        return "Scales to fit " + scaleTo + " of " + fts.containerLayerName + " - Aligned " + alignment;
    }

    /**
     * Checks if a layer has the "Fit to shape" effect applied.
     * Returns { containerLayerName, alignment, scaleTo } or null.
     * alignment and scaleTo are stored as 1-based integers matching AE's dropdown values.
     * containerLayerName is the parent layer (what the layer is fitted to).
     */
    function getFitToShape(layer) {
        try {
            var effects = layer.property("ADBE Effect Parade");
            if (!effects || effects.numProperties === 0) return null;

            for (var i = 1; i <= effects.numProperties; i++) {
                var effect = effects.property(i);
                if (!effect) continue;

                // Match by name, case-insensitive
                var effectName = effect.name.toLowerCase().replace(/\s+/g, " ");
                if (effectName !== "fit to shape") continue;

                // Alignment is property 1, Scale To is property 2
                var alignVal  = effect.property(1).value; // integer 1–9
                var scaleVal  = effect.property(2).value; // integer 1–4

                return {
                    containerLayerName: layer.parent ? layer.parent.name : null,
                    alignment: alignVal,
                    scaleTo:   scaleVal
                };
            }
        } catch (e) {}
        return null;
    }

    function getLayerType(layer) {
        try {
            if (layer instanceof TextLayer)  return "text";
            if (layer instanceof ShapeLayer) return "shape";
            if (layer instanceof AVLayer) {
                if (layer.source instanceof CompItem) return "precomp";
                return "footage";
            }
        } catch (e) {}
        return "unknown";
    }


    // ─── Numeric helpers ───────────────────────────────────────────────────────

    function r2(val) { return Math.round(val * 100)  / 100; }
    function r3(val) { return Math.round(val * 1000) / 1000; }

    function roundArr(arr) {
        var out = [];
        for (var i = 0; i < arr.length; i++) out.push(r2(arr[i]));
        return out;
    }

    /** Format a number to exactly 2 decimal places: 0.25, 1.00, 0.10 */
    function fmt2(val) {
        var n   = Math.round(val * 100) / 100;
        var str = String(n);
        var dot = str.indexOf(".");
        if (dot === -1) return str + ".00";
        var decimals = str.length - dot - 1;
        if (decimals === 1) return str + "0";
        return str;
    }

    function randomStr(len) {
        var chars  = "abcdefghijklmnopqrstuvwxyz0123456789";
        var result = "";
        for (var i = 0; i < len; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }


    // ─── Clipboard ─────────────────────────────────────────────────────────────

    function writeToClipboard(text) {
        var tmp = new File(Folder.temp.fsName + "/specexporter_tmp.txt");
        tmp.encoding = "UTF-8";
        tmp.open("w");
        tmp.write(text);
        tmp.close();

        var isMac = ($.os.toLowerCase().indexOf("mac") !== -1);
        if (isMac) {
            system.callSystem('cat "' + tmp.fsName + '" | pbcopy');
        } else {
            system.callSystem('type "' + tmp.fsName.replace(/\//g, "\\") + '" | clip');
        }

        tmp.remove();
    }


    // ─── JSON serializer ───────────────────────────────────────────────────────

    function jsonStringify(val) {
        return serialize(val, "  ", "");
    }

    function serialize(val, indent, depth) {
        if (val === null || val === undefined) return "null";
        if (typeof val === "boolean")          return String(val);
        if (typeof val === "number")           return isFinite(val) ? String(val) : "null";
        if (typeof val === "string")           return '"' + escStr(val) + '"';

        if (val instanceof Array) {
            if (val.length === 0) return "[]";
            var next  = depth + indent;
            var items = [];
            for (var i = 0; i < val.length; i++) {
                items.push(next + serialize(val[i], indent, next));
            }
            return "[\n" + items.join(",\n") + "\n" + depth + "]";
        }

        if (typeof val === "object") {
            var keys = [];
            for (var k in val) {
                if (val.hasOwnProperty(k)) keys.push(k);
            }
            if (keys.length === 0) return "{}";
            var next  = depth + indent;
            var pairs = [];
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                pairs.push(next + '"' + k + '": ' + serialize(val[k], indent, next));
            }
            return "{\n" + pairs.join(",\n") + "\n" + depth + "}";
        }

        return '"' + String(val) + '"';
    }

    function escStr(s) {
        return s
            .replace(/\\/g, "\\\\")
            .replace(/"/g,  '\\"')
            .replace(/\n/g, "\\n")
            .replace(/\r/g, "\\r")
            .replace(/\t/g, "\\t");
    }


    // ─── Init ──────────────────────────────────────────────────────────────────

    if (panel instanceof Window) {
        panel.center();
        panel.show();
    } else {
        panel.layout.layout(true);
    }

})(this);
