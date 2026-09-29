/**
 * The annotated map for the usage guide (P10 in docs/GUIA-SPEC.md): the same
 * render as src/render-map.js, with a numbered callout on each of the six
 * things post 2 explains. The legend for the numbers lives in the post text,
 * so the image needs no translation.
 *
 * Every position comes from the lane state and the projector, never from typed
 * coordinates, so it works on whatever layer the guide was captured on.
 *
 * Usage (same arguments as render-map.js):
 *   node tools/annotate-map.mjs Narva_RAAS_v1 A1 B2 --team1=WPMC --team2=PLAAGF
 *   node tools/annotate-map.mjs Narva_RAAS_v1 A1 B2 --out=docs/guia/prints/P10-mapa-anotado.jpg
 */
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { buildFlags, centreOf, fetchLayer, makeProjector, shortName } from "../src/layer.js";
import { MARGIN, gridStep, renderLayer } from "../src/render-map.js";

const BADGE_R = 22;
const FLAG_R = 25;

const [, , layerName, ...args] = process.argv;
if (!layerName) {
    console.error("usage: node tools/annotate-map.mjs <Layer> [flag...] [--team2] [--team1=X] [--team2=Y] [--out=file]");
    process.exit(1);
}
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const perspective = args.includes("--team2") ? "team2" : "team1";
const out = option("out") ?? `preview-${layerName}-anotado.jpg`;

const data = await fetchLayer(layerName);
const flags = buildFlags(data);
const picked = args
    .filter((a) => !a.startsWith("--"))
    .map((s) => {
        const hit = flags.find((f) => f.name.toLowerCase() === s.toLowerCase() || shortName(f.key) === s);
        if (!hit) throw new Error(`flag not found: ${s}`);
        return hit.key;
    });

const { image, state, width, height } = await renderLayer(layerName, picked, {
    perspective,
    factions: { team1: option("team1"), team2: option("team2") },
});

// renderLayer projects onto the basemap and then adds the frame, so every
// point here is shifted by the same margin.
const mapW = width - 2 * MARGIN;
const mapH = height - 2 * MARGIN;
const toMap = makeProjector(data, mapW, mapH);
const at = (x, y) => {
    const [px, py] = toMap(x, y);
    return [px + MARGIN, py + MARGIN];
};

const taken = state.alive
    .filter((f) => f.taken && f.steps.length === 1)
    .sort((a, b) => a.steps[0] - b.steps[0]);
const next = state.nextFlags.toSorted((a, b) => b.percentage - a.percentage)[0];
const later = state.alive.find(
    (f) => !f.taken && !f.next && f.steps.length === 1 && f.depth === state.currentPosition + 1,
);
const main = at(...centreOf(state.clusters[state.start]));

// Obstacles the badges keep clear of: every marker, its name above it and its
// odds below it, plus both mains.
const obstacles = state.alive.flatMap((f) => {
    const [x, y] = at(f.x, f.y);
    return [[x, y], [x, y - 26], [x, y + 40]];
});
for (const node of Object.keys(data.objectives ?? {}).filter((n) => /main/i.test(n))) {
    const [x, y] = at(...centreOf(data.objectives[node]));
    obstacles.push([x, y], [x, y - 36]);
}

// Numbered in the order post 2 explains them. A number whose target does not
// exist on this layer is skipped, never reassigned, so the legend stays fixed.
const callouts = [];
const mark = (n, target, radius, badge) => target && callouts.push({ n, target, radius, badge });

mark(1, taken.length && at(taken[0].x, taken[0].y), FLAG_R);
mark(2, next && at(next.x, next.y), FLAG_R);
mark(3, later && at(later.x, later.y), FLAG_R);
if (taken.length) {
    // The white line: between two consecutive confirmations when there are
    // two, otherwise the leg from the main to the first one.
    const pair =
        taken.length > 1 && taken[1].steps[0] === taken[0].steps[0] + 1
            ? [at(taken[0].x, taken[0].y), at(taken[1].x, taken[1].y)]
            : [main, at(taken[0].x, taken[0].y)];
    mark(4, [(pair[0][0] + pair[1][0]) / 2, (pair[0][1] + pair[1][1]) / 2], 4);
}
// The main itself rather than its protection zone: some layers (Narva) store
// the zone as a box, which render-map.js does not draw.
mark(5, main, 30);

// The keypad letter in the frame above the next candidate's column. Its badge
// goes straight below the letter: beside it, "D 6" reads as a keypad.
const step = gridStep(data, mapW);
const column = Math.floor(((next ? at(next.x, next.y)[0] : mapW / 2) - MARGIN) / step);
const letter = [MARGIN + column * step + step / 2, MARGIN - 23];
mark(6, letter, 16, [letter[0], MARGIN + 52]);

// Each badge goes where it is farthest from anything drawn, among a ring of
// candidates around its target, and never outside the map area.
const placed = [];
for (const c of callouts) {
    if (!c.badge) {
        let best = null;
        for (const distance of [85, 115, 145]) {
            for (let k = 0; k < 16; k++) {
                const a = (k / 16) * Math.PI * 2;
                const p = [c.target[0] + Math.cos(a) * distance, c.target[1] + Math.sin(a) * distance];
                const inside =
                    p[0] > MARGIN + BADGE_R && p[0] < MARGIN + mapW - BADGE_R &&
                    p[1] > MARGIN + BADGE_R && p[1] < MARGIN + mapH - BADGE_R;
                if (!inside) continue;
                const clear = Math.min(
                    ...obstacles.map(([x, y]) => Math.hypot(p[0] - x, p[1] - y)),
                    ...placed.map(([x, y]) => Math.hypot(p[0] - x, p[1] - y) - BADGE_R),
                );
                const score = clear - distance / 10;
                if (!best || score > best.score) best = { p, score };
            }
        }
        c.badge = best.p;
    }
    placed.push(c.badge);
}

const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`];
for (const c of callouts) {
    const [bx, by] = c.badge;
    const [tx, ty] = c.target;
    const d = Math.hypot(tx - bx, ty - by);
    const ux = (tx - bx) / d;
    const uy = (ty - by) / d;
    const x1 = bx + ux * BADGE_R;
    const y1 = by + uy * BADGE_R;
    const x2 = tx - ux * c.radius;
    const y2 = ty - uy * c.radius;
    const line = `x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"`;
    svg.push(
        // Black, not white: a white leader reads as the lane line.
        `<line ${line} stroke="#fff" stroke-width="8" stroke-opacity="0.35" stroke-linecap="round"/>`,
        `<line ${line} stroke="#000" stroke-width="4" stroke-linecap="round"/>`,
        // Square, because every flag on the map is a numbered circle.
        `<rect x="${(bx - BADGE_R).toFixed(1)}" y="${(by - BADGE_R).toFixed(1)}" width="${BADGE_R * 2}" ` +
            `height="${BADGE_R * 2}" rx="7" fill="#fff" stroke="#000" stroke-width="4"/>`,
        `<text x="${bx.toFixed(1)}" y="${(by + 9).toFixed(1)}" font-family="Arial,Helvetica,sans-serif" ` +
            `font-size="26" font-weight="bold" text-anchor="middle" fill="#000">${c.n}</text>`,
    );
}
svg.push("</svg>");

const annotated = await sharp(image)
    .composite([{ input: Buffer.from(svg.join("")), top: 0, left: 0 }])
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
await writeFile(out, annotated);

console.log(`output : ${out}  ${(annotated.length / 1024).toFixed(0)} KB  ${width}x${height}`);
const missing = [1, 2, 3, 4, 5, 6].filter((n) => !callouts.some((c) => c.n === n));
console.log(`marks  : ${callouts.map((c) => c.n).join(" ")}${missing.length ? `  (missing ${missing.join(" ")})` : ""}`);
