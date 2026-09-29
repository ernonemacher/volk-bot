/**
 * Composes the layer map as a JPEG, server side, with no browser.
 *
 * The basemap comes from the SquadCalc API; everything on top is drawn as an
 * SVG overlay and flattened with sharp. A render takes a few hundred
 * milliseconds once the basemap is cached, which is what makes free hosting
 * viable.
 *
 * Styling deliberately follows SquadCalc's own map so the two read as one
 * tool: 300m keypad grid, translucent white circles for objectives, green for
 * what has been taken, red for mains. The one deliberate departure is
 * labelling every live objective, because a static image has no hover.
 *
 * Usage:
 *   node render-map.js Yehorivka_RAAS_v2
 *   node render-map.js Yehorivka_RAAS_v2 B1 B2
 *   node render-map.js Yehorivka_RAAS_v2 --team2
 */

import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import {
    API_URL,
    buildFlags,
    centreOf,
    fetchLayer,
    isMain,
    laneState,
    makeProjector,
    shortName,
} from "./layer.js";

/** Final image width. Everything is composed at this size, never at 4096. */
const OUTPUT_WIDTH = 1600;

/** Squad's keypad squares are 300m across. */
const KEYPAD_METRES = 300;

/**
 * Lifted verbatim from SquadCalc's `mapObjectives.scss`.
 *
 * Flags are coloured by their hop count from the chosen main, not by whether
 * they are reachable: that is the whole visual language of the original, where
 * `.flag2`..`.flag7` each get a colour and `.next` is red. `circleFlag` is the
 * shape SquadCalc uses, a 30px circle with a 3px outline, scaled up here
 * because this image is read at a glance instead of zoomed.
 */
const FLAG_COLOUR = {
    1: ["rgba(197,0,0,0.80)", "rgb(143,0,0)"],
    2: ["rgba(0,255,0,0.20)", "rgb(68,255,68)"],
    3: ["rgba(0,0,255,0.20)", "rgb(0,0,255)"],
    4: ["rgba(255,255,0,0.20)", "rgb(255,255,0)"],
    5: ["rgba(43,255,255,0.20)", "rgb(43,255,255)"],
    6: ["rgba(200,48,102,0.20)", "rgb(200,48,102)"],
    7: ["rgba(255,105,0,0.20)", "rgb(255,105,0)"],
};

const STYLE = {
    flagFill: "rgba(255,255,255,0.40)",
    flagStroke: "rgb(104,104,104)",
    nextFill: "rgb(197,0,0)",
    nextStroke: "rgb(143,0,0)",
    takenFill: "rgb(0,128,0)",
    takenStroke: "rgb(0,90,0)",
    mainFill: "rgb(197,0,0)",
    mainStroke: "rgb(143,0,0)",
    mainOutline: "rgb(58,58,58)",
    mainBracket: "rgb(255,193,7)",
    protection: "rgb(200,40,40)",
    noDeploy: "rgb(230,150,60)",
    capZone: "rgb(255,255,255)",
    path: "rgb(255,255,255)",
    grid: "rgba(0,0,0,0.45)",
    frame: "#0d0d0d",
    text: "#FFFFFF",
    halo: "#000000",
};

/** Black frame carrying the keypad letters and numbers, as in SquadCalc. */
export const MARGIN = 58;

/**
 * Layers whose exported border is wrong: in game it is overwritten by a mask
 * generated at runtime, which cannot be exported. Same list SquadCalc keeps.
 * https://github.com/yobaNGE/squad-map-data-CUE4Parse/issues/38
 */
const BUGGED_BORDERS = new Set([
    "GC_BespinPlatforms_AAS_V2",
    "GC_BespinPlatforms_SKM_V1",
    "SD_AlBasrah_Legacy_Invasion_v1",
    "SD_AlBasrah_Legacy_Invasion_v2",
    "SD_AlBasrah_Legacy_Invasion_v3",
    "SD_AlBasrah_Legacy_RAAS_v1",
    "GC_Ryloth_AAS_V1",
    "GC_Ryloth_AAS_V2",
    "GC_Ryloth_AAS_V3",
    "GC_Ryloth_INV_V1",
    "GC_Ryloth_INV_V2",
]);

/**
 * How many decoded basemaps to keep.
 *
 * Each one costs tens of megabytes once libvips has it resident, and a bot that
 * follows a rotation would otherwise accumulate every map in the game: six was
 * enough to take the process from 60 MB to 423 MB. Insertion order is the
 * eviction order, which is a plain LRU once a hit re-inserts.
 */
const BASEMAP_CACHE_SIZE = 4;
const basemapCache = new Map();

// libvips keeps its own operation cache on top of ours, unbounded enough to
// matter on a small host. These are the numbers the bot actually needs: one
// render at a time, no file cache, a small operation cache.
sharp.cache({ memory: 64, files: 0, items: 32 });
sharp.concurrency(1);

/**
 * Basemap, already downscaled to the output size and cached.
 *
 * Source textures are 4096x4096. Compositing at that size and shrinking
 * afterwards costs about 4.5s; shrinking first drops it to a fraction of that.
 */
async function fetchBasemap(mapId, style = "terrainmap") {
    const key = `${mapId}/${style}/${OUTPUT_WIDTH}`;
    if (basemapCache.has(key)) {
        const hit = basemapCache.get(key);
        basemapCache.delete(key); // re-insert so it becomes the newest
        basemapCache.set(key, hit);
        return hit;
    }

    const url = `${API_URL}/img/maps/${mapId.toLowerCase()}/${style}.webp`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`basemap ${style} answered ${res.status}`);

    const small = await sharp(Buffer.from(await res.arrayBuffer()))
        .resize({ width: OUTPUT_WIDTH, withoutEnlargement: true })
        .png()
        .toBuffer();

    basemapCache.set(key, small);
    while (basemapCache.size > BASEMAP_CACHE_SIZE) {
        basemapCache.delete(basemapCache.keys().next().value);
    }
    return small;
}

const factionCache = new Map();

/**
 * Circular faction badge for a main, the same asset SquadCalc puts inside its
 * main marker (`/img/flags/circles/<factionID>.webp`).
 *
 * Converted to PNG because librsvg, which rasterises the overlay, will not
 * decode a WebP behind a data URI.
 */
async function fetchFactionIcon(factionId) {
    if (!factionId) return null;
    const key = String(factionId);
    if (factionCache.has(key)) return factionCache.get(key);

    let png = null;
    try {
        const res = await fetch(
            `${API_URL}/img/flags/circles/${encodeURIComponent(key)}.webp`,
            { signal: AbortSignal.timeout(15000) },
        );
        if (res.ok) {
            png = await sharp(Buffer.from(await res.arrayBuffer()))
                .resize(96, 96, { fit: "cover" })
                .png()
                .toBuffer();
        }
    } catch {
        // An unknown faction just falls back to the plain red marker.
    }

    factionCache.set(key, png);
    return png;
}

const esc = (s) =>
    String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);

/** Text with a dark halo, so it stays readable over any terrain. */
function label(x, y, text, size) {
    const common =
        `x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="Arial,Helvetica,sans-serif" ` +
        `font-size="${size}" font-weight="bold" text-anchor="middle"`;
    return (
        `<text ${common} fill="none" stroke="${STYLE.halo}" stroke-width="${size / 4}" ` +
        `stroke-linejoin="round" opacity="0.9">${esc(text)}</text>` +
        `<text ${common} fill="${STYLE.text}">${esc(text)}</text>`
    );
}

/**
 * One capture zone, ported from SquadCalc's `createCapZone`.
 *
 * The maths is copied faithfully (sphere radius, box half-extents with
 * scaling and z-rotation, capsule as a rectangle plus two end circles); what
 * could not be copied is the Leaflet `Circle`/`Rectangle` objects it builds,
 * since those need a live DOM. These are SVG equivalents.
 *
 * SquadCalc keeps capzones at opacity 0 and reveals them on zoom, which a
 * static image cannot do, so they are drawn only for the flags still in play.
 */
function capZone(cap, project, pxPerMetre) {
    const parts = [];
    const [cx, cy] = project(cap.location_x, cap.location_y);
    const common = `fill="none" stroke="${STYLE.capZone}" stroke-width="2" opacity="0.55"`;

    if (cap.isSphere) {
        const r = (Number(cap.sphereRadius) / 100) * pxPerMetre;
        if (r > 1) parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" ${common}/>`);
        return parts.join("");
    }

    if (cap.isBox || cap.isCapsule) {
        const e = cap.boxExtent ?? {};
        // Capsules lying on their side carry the tilt in rotation_y;
        // SquadCalc folds x and y back into the z rotation for those.
        let rotation = e.rotation_z ?? 0;
        if (Math.abs(e.rotation_y ?? 0) > 89 && Math.abs(e.rotation_y ?? 0) < 91) {
            rotation += (e.rotation_y > 0 ? -1 : 1) * ((e.rotation_x ?? 0) + e.rotation_y);
        }

        const rx = cap.isBox
            ? (e.extent_x / 100) * (e.scaling_x ?? 1) * pxPerMetre
            : (Number(cap.capsuleRadius) / 100) * pxPerMetre;
        const ry = cap.isBox
            ? (e.extent_y / 100) * (e.scaling_y ?? 1) * pxPerMetre
            : ((Number(cap.capsuleLength) - Number(cap.capsuleRadius)) / 100) * pxPerMetre;

        if (!(rx > 1) || !(ry > 1)) return "";

        parts.push(
            `<rect x="${(cx - rx).toFixed(1)}" y="${(cy - ry).toFixed(1)}" ` +
                `width="${(rx * 2).toFixed(1)}" height="${(ry * 2).toFixed(1)}" ` +
                `transform="rotate(${rotation.toFixed(2)} ${cx.toFixed(1)} ${cy.toFixed(1)})" ${common}/>`,
        );

        if (cap.isCapsule) {
            const r = (Number(cap.capsuleRadius) / 100) * pxPerMetre;
            for (const dy of [-ry, ry]) {
                const a = (rotation * Math.PI) / 180;
                const ex = cx - dy * Math.sin(a);
                const ey = cy + dy * Math.cos(a);
                parts.push(`<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="${r.toFixed(1)}" ${common}/>`);
            }
        }
    }
    return parts.join("");
}

/**
 * The keypad grid, the most recognisable part of a Squad map.
 *
 * Squares are 300m, labelled A.. across and 1.. down, matching what players
 * call out in game, so a screenshot of this panel can be read aloud directly.
 */
/**
 * Darkens everything outside the playable area, ported from SquadCalc's
 * `createSplineBorders`.
 *
 * The border is a closed Hermite spline, so each point carries the tangents the
 * curve arrives and leaves with; the cubic Bezier controls are those tangents
 * scaled by a third. Shading is one path holding the full rectangle *and* the
 * spline, filled `evenodd`, so the inside is punched out of the outside.
 */
function unplayableArea(layerData, project, width, height) {
    const border = layerData.border ?? [];
    if (border.length <= 2) return "";
    if (BUGGED_BORDERS.has(layerData.rawName)) return "";

    // `project` is a linear rescale, so subtracting the origin turns a position
    // into a pure direction, which is what a tangent needs.
    const [zeroX, zeroY] = project(0, 0);
    const vector = (x, y) => {
        const [px, py] = project(x || 0, y || 0);
        return [px - zeroX, py - zeroY];
    };

    const clamp = (v, max) => Math.min(Math.max(v, 0), max);
    const points = border.map((b) => {
        const [x, y] = project(b.location_x, b.location_y);
        return {
            at: [clamp(x, width), clamp(y, height)],
            leave: vector(b.leaveTangent_x, b.leaveTangent_y),
            arrive: vector(b.arriveTangent_x, b.arriveTangent_y),
        };
    });

    const xy = ([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`;
    const d = [`M 0 0 L ${width} 0 L ${width} ${height} L 0 ${height} Z`, `M ${xy(points[0].at)}`];

    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const cur = points[i];
        const cp1 = [prev.at[0] + prev.leave[0] / 3, prev.at[1] + prev.leave[1] / 3];
        const cp2 = [cur.at[0] - cur.arrive[0] / 3, cur.at[1] - cur.arrive[1] / 3];
        d.push(`C ${xy(cp1)}, ${xy(cp2)}, ${xy(cur.at)}`);
    }
    d.push("Z");

    return `<path d="${d.join(" ")}" fill="#111111" fill-opacity="0.75" fill-rule="evenodd"/>`;
}

/**
 * The chain through the confirmed objectives, ported from SquadCalc's
 * `_drawPath`.
 *
 * Only points adjacent in the chain are joined. Knowing step 1 and step 4 says
 * nothing about the legs between them, so one line across the map would draw a
 * route nobody confirmed; each run of consecutive steps gets its own line. A
 * confirmed point whose depth is still open has no place in the chain yet.
 */
function walkPath(state, project) {
    const byKey = new Map(state.alive.map((f) => [f.key, f]));
    const points = state.walk
        .map((key) => byKey.get(key))
        .filter((flag) => flag?.steps.length === 1)
        .map((flag) => ({ step: flag.steps[0], at: project(flag.x, flag.y) }))
        .sort((a, b) => a.step - b.step);

    if (!points.length) return "";

    // The mains bracket the chain: the one the depths count from sits a step
    // before the first objective, and the far one joins only once a confirmed
    // point sits at the deepest step.
    const main = state.clusters[state.start];
    if (main) points.unshift({ step: 0, at: project(...centreOf(main)) });

    const farName = state.start === state.mains.team1 ? state.mains.team2 : state.mains.team1;
    const far = state.clusters[farName];
    if (far && state.routeComplete) {
        points.push({ step: points[points.length - 1].step + 1, at: project(...centreOf(far)) });
    }

    const runs = [[points[0]]];
    for (let i = 1; i < points.length; i++) {
        if (points[i].step === points[i - 1].step + 1) runs[runs.length - 1].push(points[i]);
        else runs.push([points[i]]);
    }

    return runs
        .filter((run) => run.length > 1)
        .map(
            (run) =>
                `<polyline points="${run
                    .map(({ at }) => `${at[0].toFixed(1)},${at[1].toFixed(1)}`)
                    .join(" ")}" fill="none" stroke="${STYLE.path}" stroke-width="4" ` +
                `stroke-opacity="0.9" stroke-linejoin="round" stroke-linecap="round"/>`,
        )
        .join("");
}

export function gridStep(layerData, width) {
    const [c0, c1] = layerData.mapTextureCorners;
    const metres = Math.abs(c1.location_x - c0.location_x) / 100;
    return (KEYPAD_METRES / metres) * width;
}

/** Keypad lines, drawn in map space. */
function gridLines(step, width, height) {
    if (!Number.isFinite(step) || step < 20) return "";
    const parts = [];
    for (let i = 1; i * step < width; i++) {
        const x = (i * step).toFixed(1);
        parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="${STYLE.grid}" stroke-width="1"/>`);
    }
    for (let i = 1; i * step < height; i++) {
        const y = (i * step).toFixed(1);
        parts.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${STYLE.grid}" stroke-width="1"/>`);
    }
    return parts.join("");
}

/**
 * Keypad letters and numbers in the black frame around the map.
 *
 * SquadCalc puts them in the map's own gutter rather than over the terrain,
 * which is the only way they stay readable at this size.
 */
function gridFrame(step, width, height) {
    if (!Number.isFinite(step) || step < 20) return "";
    const parts = [`<rect x="0" y="0" width="${width + 2 * MARGIN}" height="${height + 2 * MARGIN}" fill="none" stroke="${STYLE.frame}" stroke-width="${2 * MARGIN}"/>`];
    for (let i = 0; (i + 1) * step <= width; i++) {
        parts.push(label(MARGIN + i * step + step / 2, MARGIN - 14, String.fromCharCode(65 + i), 27));
    }
    for (let i = 0; (i + 1) * step <= height; i++) {
        parts.push(label(MARGIN / 2, MARGIN + i * step + step / 2 + 10, String(i + 1), 27));
    }
    return parts.join("");
}

/**
 * Main base: SquadCalc's red square marker inside yellow brackets, wrapped by
 * the dashed protection zone.
 */
function mainMarker(x, y, teamId, faction, zone, pxPerMetre, icon) {
    const parts = [];

    const sphere = (zone?.objects ?? []).find((o) => o.isSphere);
    if (sphere) {
        const protect = (Number(sphere.sphereRadius) / 100) * pxPerMetre;
        parts.push(
            `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${protect.toFixed(1)}" fill="none" ` +
                `stroke="${STYLE.protection}" stroke-width="3" stroke-dasharray="14,10" opacity="0.85"/>`,
        );

        // Nothing can be built inside this one: the protection radius plus the
        // zone's own deployable lock distance.
        const lock = Number(zone.deployableLockDistance ?? 0);
        if (lock > 0) {
            const noDeploy = ((Number(sphere.sphereRadius) + lock) / 100) * pxPerMetre;
            parts.push(
                `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${noDeploy.toFixed(1)}" fill="none" ` +
                    `stroke="${STYLE.noDeploy}" stroke-width="2" stroke-dasharray="6,10" opacity="0.7"/>`,
            );
        }
    }

    const half = 24;
    const arm = 13;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const cx = x + sx * half;
        const cy = y + sy * half;
        parts.push(
            `<path d="M ${(cx - sx * arm).toFixed(1)} ${cy.toFixed(1)} L ${cx.toFixed(1)} ${cy.toFixed(1)} ` +
                `L ${cx.toFixed(1)} ${(cy - sy * arm).toFixed(1)}" fill="none" stroke="${STYLE.mainBracket}" ` +
                `stroke-width="4" stroke-linecap="square"/>`,
        );
    }

    const r = 18;
    if (icon) {
        const clip = `mainclip${teamId}`;
        parts.push(
            `<clipPath id="${clip}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}"/></clipPath>` +
                `<image href="data:image/png;base64,${icon.toString("base64")}" ` +
                `x="${(x - r).toFixed(1)}" y="${(y - r).toFixed(1)}" width="${r * 2}" height="${r * 2}" ` +
                `clip-path="url(#${clip})"/>` +
                `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="none" ` +
                `stroke="${STYLE.mainOutline}" stroke-width="2.5"/>`,
        );
    } else {
        parts.push(
            `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${STYLE.mainFill}" ` +
                `stroke="${STYLE.mainStroke}" stroke-width="4"/>`,
        );
    }

    parts.push(label(x, y - 36, faction ? `Team ${teamId} : ${faction}` : `Team ${teamId}`, 21));
    return parts.join("");
}

/**
 * @param {string} layerName
 * @param {string[]} picked                 cluster nodes already chosen
 * @param {{perspective?: "team1"|"team2", style?: string,
 *   factions?: {team1?: string, team2?: string}}} [options]
 */
export async function renderLayer(layerName, picked = [], options = {}) {
    const { perspective = "team1", style = "terrainmap", factions = {} } = options;

    const data = await fetchLayer(layerName);
    const base = await fetchBasemap(data.mapId ?? data.mapName, style);

    const { width, height } = await sharp(base).metadata();
    const project = makeProjector(data, width, height);
    const state = laneState(data, picked, perspective, layerName);

    const step = gridStep(data, width);
    const map = [
        unplayableArea(data, project, width, height),
        gridLines(step, width, height),
        walkPath(state, project),
    ];

    const [tc0, tc1] = data.mapTextureCorners;
    const pxPerMetre = width / (Math.abs(tc1.location_x - tc0.location_x) / 100);

    // --- objectives --------------------------------------------------------
    // No links are drawn between flags: SquadCalc draws none, and the lane is
    // already expressed by the number and colour inside each marker.
    // Flags ruled out by the walk are dropped rather than greyed, the way
    // SquadCalc fades them off the map.
    for (const flag of state.alive) {
        const [x, y] = project(flag.x, flag.y);

        const [fill, stroke] = flag.taken
            ? [STYLE.takenFill, STYLE.takenStroke]
            : flag.next
              ? [STYLE.nextFill, STYLE.nextStroke]
              : (FLAG_COLOUR[flag.depth] ?? [STYLE.flagFill, STYLE.flagStroke]);

        for (const cap of flag.point.objects ?? []) {
            map.push(capZone(cap, project, pxPerMetre));
        }
        map.push(
            `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="21" fill="${fill}" ` +
                `stroke="${stroke}" stroke-width="4"/>`,
        );

        // A point the randomiser can place at more than one depth shows them
        // all, as SquadCalc's `multiPos` flags do, so the digits shrink to fit.
        // Confirmed flags keep their number too: on a static image the order
        // walked so far is only readable from the flags themselves.
        if (flag.steps.length) {
            const text = flag.steps.join("·");
            const size = flag.steps.length === 1 ? 26 : flag.steps.length === 2 ? 18 : 13;
            map.push(label(x, y + size / 3, text, size));
        }
        map.push(label(x, y - 26, flag.name, 17));

        // Every point still in play carries its odds, not only the next ones:
        // the solver resolves the whole board at once.
        if (!flag.taken && flag.percentage) {
            map.push(label(x, y + 40, `${Math.round(flag.percentage)}%`, 16));
        }
    }

    // --- mains -------------------------------------------------------------
    const zones = data.mapAssets?.protectionZones ?? [];
    for (const [node, cluster] of Object.entries(data.objectives ?? {})) {
        if (!isMain(node)) continue;
        const [x, y] = project(...centreOf(cluster));
        const teamId = /team ?1/i.test(node) ? "1" : "2";
        const faction = factions[`team${teamId}`];
        map.push(
            mainMarker(
                x,
                y,
                teamId,
                faction,
                zones.find((z) => String(z.teamid) === teamId),
                pxPerMetre,
                await fetchFactionIcon(faction),
            ),
        );
    }

    const canvasW = width + 2 * MARGIN;
    const canvasH = height + 2 * MARGIN;
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">` +
        `<g transform="translate(${MARGIN},${MARGIN})">${map.join("")}</g>` +
        gridFrame(step, width, height) +
        "</svg>";

    const overlay = await sharp(Buffer.from(svg), { density: 72 })
        .resize(canvasW, canvasH, { fit: "fill" })
        .png()
        .toBuffer();

    // Two passes on purpose: sharp applies `resize` BEFORE `composite` within a
    // single pipeline, which would shrink the basemap and reject the overlay.
    const flattened = await sharp(base)
        .extend({
            top: MARGIN,
            bottom: MARGIN,
            left: MARGIN,
            right: MARGIN,
            background: STYLE.frame,
        })
        .composite([{ input: overlay, top: 0, left: 0 }])
        .png()
        .toBuffer();

    const image = await sharp(flattened).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
    return { image, state, width: width + 2 * MARGIN, height: height + 2 * MARGIN };
}

// --- direct run ------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    const [, , layerName = "Yehorivka_RAAS_v2", ...args] = process.argv;
    const perspective = args.includes("--team2") ? "team2" : "team1";
    const faction = (side) =>
        args.find((a) => a.startsWith(`--${side}=`))?.split("=")[1];
    const pickedShort = args.filter((a) => !a.startsWith("--"));

    const data = await fetchLayer(layerName);
    const flags = buildFlags(data);
    const picked = pickedShort.map((s) => {
        const hit = flags.find(
            (f) => f.name.toLowerCase() === s.toLowerCase() || shortName(f.key) === s,
        );
        if (!hit) throw new Error(`flag not found: ${s}`);
        return hit.key;
    });

    const started = Date.now();
    const { image, state, width, height } = await renderLayer(layerName, picked, {
        perspective,
        factions: { team1: faction("team1"), team2: faction("team2") },
    });
    const out = `preview-${layerName}.jpg`;
    await writeFile(out, image);

    console.log(`layer      : ${layerName} (${data.gamemode}, ${data.mapSize})`);
    console.log(`perspective: ${perspective}${state.reversed ? " (reversed)" : ""}`);
    console.log(`picked     : ${pickedShort.join(" > ") || "(none)"}`);
    console.log(`still live : ${state.alive.length}`);
    console.log(
        `next step  : ${state.nextFlags.map((f) => `${shortName(f.key)} ${f.name}`).join(" | ") || "(end)"}`,
    );
    console.log(
        `output     : ${out}  ${(image.length / 1024).toFixed(0)} KB  ${width}x${height}  ${Date.now() - started}ms`,
    );
}
