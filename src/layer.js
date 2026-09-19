/**
 * Layer data and lane graph, straight from the public SquadCalc API.
 *
 * No browser and no session involved: everything here comes from
 * `/get/layer`, which is static for a given layer name. That is what makes
 * the rendered map cacheable forever per layer.
 */

import SquadLaneSolver from "./lane-solver.js";

/**
 * API base. Beta carries the modded layers (31 extra for Yehorivka alone) and
 * classifies gamemodes the production build still reports as "Unknown"; it is
 * the `dev` branch, so it can break without notice. Override with
 * SQUADCALC_API when that matters.
 */
export const API_URL = process.env.SQUADCALC_API ?? "https://beta.squadcalc.app/api";

/**
 * The site matching that API, so the "Open in SquadCalc" link shows the same
 * build the panel is drawn from. Pointing them at different ones sends people
 * to a page that does not know the layer they are looking at.
 */
export const APP_URL = API_URL.replace(/\/api\/?$/, "");

const cache = new Map();

/** Raw layer payload, memoised: the same layer never changes. */
export async function fetchLayer(layerName) {
    if (cache.has(layerName)) return cache.get(layerName);

    const res = await fetch(`${API_URL}/get/layer?name=${encodeURIComponent(layerName)}`, {
        signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`layer API answered ${res.status}`);

    const data = await res.json();
    cache.set(layerName, data);
    return data;
}

/** "B3-BP_CaptureZoneCluster" -> "B3" */
export const shortName = (node) => String(node).split("-")[0];

/** Mains sit in `objectives` too, but they are not pickable objectives. */
export const isMain = (node) => /main/i.test(node);

/**
 * Gamemodes whose route is drawn at match start, so the lane has to be walked
 * one flag at a time. Mirrors SquadCalc's own `isRandomized`.
 *
 * Invasion belongs here despite being asymmetric: the attacker's route is
 * randomised the same way, it is only the starting main that is fixed.
 */
const RANDOMISED = new Set(["RAAS", "RVAAS", "RINV", "Invasion"]);

/** Gamemodes with a fixed chain of objectives, known before the match. */
const LINEAR = new Set(["AAS", "Seed", "Skirmish"]);

const isLinear = (gamemode) => LINEAR.has(gamemode);

/** Everything else (Destruction, TC, TDM, GLOP, Training) has no lane to draw. */
export const hasLane = (gamemode) => RANDOMISED.has(gamemode) || LINEAR.has(gamemode);

/**
 * Centre of a cluster in world coordinates.
 *
 * Objective clusters carry `avgLocation` (they group several capture points);
 * mains carry their coordinates at the top level instead.
 */
export function centreOf(entry) {
    const c = entry.avgLocation ?? entry;
    return [c.location_x, c.location_y];
}



/** The two mains, as they appear in the graph. */
function mainsOf(layerData) {
    const names = Object.keys(layerData.objectives ?? {});
    return {
        team1: names.find((n) => /team ?1/i.test(n)) ?? names.find(isMain),
        team2: names.find((n) => /team ?2/i.test(n)),
    };
}

/**
 * Whether the member gets to choose which main to walk from.
 *
 * RAAS and RVAAS are symmetric, so either main is a valid point of view and
 * SquadCalc lets you click one. Invasion is asymmetric: only the attacker
 * advances, so the perspective is fixed and offering a choice would be wrong.
 */
export const needsPerspective = (gamemode) => gamemode === "RAAS" || gamemode === "RVAAS";

/**
 * The clickable flags of a layer.
 *
 * A flag is a *capture point*, not a cluster. One cluster can hold several
 * points that sit far apart (Bay Comeau East and Lost Reservists are two
 * separate objectives in the same cluster), and the same point can belong to
 * several clusters when lanes overlap. Drawing cluster centres instead, as an
 * earlier version did, averaged two distant objectives into one marker in
 * empty terrain and collapsed the choice between them.
 *
 * Points closer than SquadCalc's `areLatLngsClose` threshold (3 units on its
 * 256-unit map) are the same flag, and the clusters they came from accumulate
 * on it.
 */
export function buildFlags(layerData) {
    const [c0, c1] = layerData.mapTextureCorners;
    const threshold = (Math.abs(c1.location_x - c0.location_x) * 3) / 256;

    const flags = [];
    for (const [clusterName, cluster] of Object.entries(layerData.objectives ?? {})) {
        if (isMain(clusterName) || cluster.name === "Main") continue;

        // AAS, Seed and Skirmish list their objectives as points directly,
        // without the cluster wrapper the randomised modes use.
        const points = cluster.points ?? [cluster];

        for (const point of points) {
            const hit = flags.find(
                (f) => Math.hypot(f.x - point.location_x, f.y - point.location_y) < threshold,
            );
            if (hit) {
                if (!hit.clusters.includes(clusterName)) hit.clusters.push(clusterName);
                if (point.objectName && !hit.ids.includes(point.objectName)) {
                    hit.ids.push(point.objectName);
                }
                continue;
            }
            flags.push({
                // objectName, never objectDisplayName: display names repeat
                // across unrelated locations (16 of 42 layers the SquadCalc
                // author checked), and Discord rejects a select menu with two
                // options sharing a value.
                key: point.objectName ?? point.objectDisplayName ?? point.name,
                name: point.name,
                x: point.location_x,
                y: point.location_y,
                point,
                clusters: [clusterName],
                // The solver addresses candidates by objectName, and one flag
                // owns several when the randomiser offers the same location on
                // more than one route or at more than one depth.
                ids: [point.objectName].filter(Boolean),
            });
        }
    }
    return flags;
}

/**
 * Readable name of the unit a team is running.
 *
 * The server reports it as an object name ("BAF_LO_Mechanized"); the layer
 * payload carries the name players actually see ("1 Yorks Battle Group").
 */
export function unitNameOf(layerData, unitObjectName) {
    if (!unitObjectName) return null;
    const pools = [
        ...(layerData?.units?.team1Units ?? []),
        ...(layerData?.units?.team2Units ?? []),
    ];
    const unit = pools.find((u) => u.unitObjectName === unitObjectName);
    return unit?.displayName ?? unit?.shortName ?? null;
}

/** Keypad of a world position, the way players call it out: "K10". */
export function keypadOf(layerData, x, y) {
    const [c0, c1] = layerData.mapTextureCorners;
    const minX = Math.min(c0.location_x, c1.location_x);
    const minY = Math.min(c0.location_y, c1.location_y);
    const cell = 300 * 100; // Squad's keypad square is 300 m, in centimetres
    const col = Math.floor((x - minX) / cell);
    const row = Math.floor((y - minY) / cell);
    if (col < 0 || row < 0) return null;
    return `${String.fromCharCode(65 + col)}${row + 1}`;
}

const solverCache = new Map();

/** One solver per layer: route enumeration is the expensive part and static. */
function solverFor(layerName, layerData) {
    if (!solverCache.has(layerName)) solverCache.set(layerName, new SquadLaneSolver(layerData));
    return solverCache.get(layerName);
}

/**
 * State of a lane walk, resolved by SquadCalc's lane solver.
 *
 * Every route from main to main is enumerated up front, so each confirmed flag
 * is a constraint that removes the routes unable to carry it. That gives a real
 * probability for *every* point still in play, not just the next one, and it
 * accepts confirmations in any order: a point learned at depth 3 narrows the
 * board even when depths 1 and 2 are still unknown.
 *
 * @param {string[]} picked  flag keys confirmed so far, in the order clicked
 */
export function laneState(layerData, picked = [], perspective = "team1", layerName = "") {
    const clusters = layerData.objectives ?? {};
    const mains = mainsOf(layerData);
    const flags = buildFlags(layerData);
    const byKey = new Map(flags.map((f) => [f.key, f]));
    const linear = isLinear(layerData.gamemode);

    // Walking from team 2's main means numbering the depths from the far end.
    const reversed =
        needsPerspective(layerData.gamemode) && perspective === "team2" && Boolean(mains.team2);

    const solver = solverFor(layerName || layerData.rawName || JSON.stringify(mains), layerData);

    const base = {
        gamemode: layerData.gamemode,
        perspective,
        reversed,
        mains,
        clusters,
        linear,
        start: (reversed ? mains.team2 : mains.team1) ?? null,
    };

    // Linear and lane-less modes have nothing to solve: every objective stands.
    if (linear || !solver.ok) {
        return {
            ...base,
            currentPosition: 1,
            walk: [],
            alive: flags.map((f) => ({ ...f, steps: [], depth: 0, percentage: 0, taken: false, next: false })),
            nextFlags: [],
            routeComplete: false,
            stepCount: 0,
            lanes: { alive: 0, total: 0 },
        };
    }

    /** Depths a set of candidate ids can still sit at, under `constraints`. */
    const stepsOf = (result, ids) => {
        const steps = new Set();
        for (const id of ids) for (const step of result.byId.get(id)?.steps ?? []) steps.add(step);
        return [...steps].sort((a, b) => a - b);
    };

    /** Shallowest depth nobody has been pinned to yet. */
    const openStep = (confirmed) => {
        const pinned = new Set(confirmed.map((c) => c.step).filter((s) => s != null));
        let step = 1;
        while (pinned.has(step)) step++;
        return step;
    };

    const confirmed = [];
    const constraints = () => confirmed.map(({ ids, step }) => ({ ids, step }));

    /**
     * Confirms a flag the way a click does. A point that could fill the next
     * open depth is pinned there; a deeper one is confirmed without a depth,
     * because pinning it to its shallowest option would silently discard the
     * routes carrying it further along.
     */
    const confirm = (key) => {
        const flag = byKey.get(key);
        if (!flag || confirmed.some((c) => c.key === key)) return false;

        const options = stepsOf(solver.solve(constraints(), reversed), flag.ids);
        if (!options.length) return false;

        const step = openStep(confirmed);
        confirmed.push({ key, ids: flag.ids, step: options.includes(step) ? step : null });
        return true;
    };

    /**
     * Gives a depth to confirmations that were made out of order, once the
     * solver leaves them only one.
     *
     * A flag confirmed deeper than the next open step is stored with no depth,
     * because pinning it to its shallowest option would discard the routes
     * carrying it further along. But `openStep` counts pinned depths only, so
     * that step stays "open" even though the point occupying it is already
     * confirmed. Filling the steps before it then left the panel asking for a
     * depth nothing could fill: no candidate, an empty menu, and a lane that
     * read as finished with a dozen points still live and `routeComplete`
     * false. Confirming Antenna Compound and then Alma on Manicouagan RAAS v2
     * was enough to reach it.
     *
     * Narrowing is what makes this safe: once a confirmation has a single
     * remaining option, pinning it there discards nothing.
     */
    const pinSettled = () => {
        for (let pass = 0; pass <= confirmed.length; pass++) {
            const result = solver.solve(constraints(), reversed);
            let settled = false;
            for (const c of confirmed) {
                if (c.step != null) continue;
                const options = stepsOf(result, c.ids);
                if (options.length !== 1) continue;
                // One pin per pass: it changes the constraints, so the rest are
                // judged against a solve that no longer reflects them.
                c.step = options[0];
                settled = true;
                break;
            }
            if (!settled) return;
        }
    };

    /**
     * Confirms every depth that has only one possible point, in order.
     *
     * Each confirmation opens the following depth, so this repeats until a
     * depth has a real choice in it.
     */
    const cascade = () => {
        for (let guard = 0; guard <= flags.length; guard++) {
            const result = solver.solve(constraints(), reversed);
            const step = openStep(confirmed);
            const candidates = flags.filter(
                (f) => !confirmed.some((c) => c.key === f.key) && stepsOf(result, f.ids).includes(step),
            );
            if (candidates.length !== 1 || !confirm(candidates[0].key)) break;
            // The cascade can settle an out-of-order confirmation: once the
            // steps around it are taken, its own stops being ambiguous.
            pinSettled();
        }
    };

    // Cascade before each pick, not only after the last one.
    //
    // `confirm` pins to the next depth nobody occupies, and a forced step the
    // cascade has not run yet still counts as free. On Tallil RAAS v1 the
    // first step has a single candidate (Eridu, which owns one objectName per
    // route), so a member's first pick is really the second step: it was
    // offered depth 1, could not hold it, and was stored with no depth at all.
    // A second pick did the same, and with both ambiguous `pinSettled` had
    // nothing to settle, leaving the panel with an empty menu and five steps
    // unwalked. Running the cascade first means each pick is offered a depth
    // that is genuinely open.
    cascade();
    for (const key of picked) {
        confirm(key);
        pinSettled();
        cascade();
    }

    const result = solver.solve(constraints(), reversed);
    const nextStep = openStep(confirmed);
    const taken = new Set(confirmed.map((c) => c.key));

    const alive = flags.flatMap((flag) => {
        const steps = stepsOf(result, flag.ids);
        if (!steps.length) return [];

        let probability = 0;
        for (const id of flag.ids) probability += result.byId.get(id)?.probability ?? 0;

        return [
            {
                ...flag,
                steps,
                // Colour and ordering follow the shallowest depth it can hold.
                depth: steps[0],
                percentage: probability * 100,
                taken: taken.has(flag.key),
                next: steps.includes(nextStep),
            },
        ];
    });

    // The chain reaches the enemy main only once a confirmed point is pinned to
    // the deepest step. "Nothing left to confirm" is not the same thing: a
    // confirmation made out of order carries no depth, and using it as a proxy
    // drew a line to the enemy main across objectives nobody had walked.
    const routeComplete = alive.some(
        (f) => f.taken && f.steps.length === 1 && f.steps[0] === solver.stepCount,
    );

    return {
        ...base,
        currentPosition: nextStep,
        routeComplete,
        stepCount: solver.stepCount,
        // Ordered by depth, not by click. Confirmations are unordered by
        // design, and printing them as they arrived drew the lane out of
        // sequence (Antenna Compound, then Alma, then the Lumber Mill that
        // sits between them). One still without a depth keeps its position
        // rather than being pushed to either end.
        walk: confirmed
            .map((c, i) => ({ key: c.key, step: c.step, i }))
            .sort((a, b) => (a.step ?? Infinity) - (b.step ?? Infinity) || a.i - b.i)
            .map((c) => c.key),
        alive,
        nextFlags: alive.filter((f) => f.next && !f.taken),
        // How much of the layer is still open, which is the headline number.
        lanes: { alive: result.alive, total: result.total },
    };
}

/**
 * World (centimetres, Unreal) -> pixel in the map texture.
 *
 * The basemap image spans exactly the rectangle given by `mapTextureCorners`,
 * so the mapping is a plain linear rescale. No need to reproduce SquadCalc's
 * Leaflet coordinate space.
 */
export function makeProjector(layerData, width, height) {
    const [c0, c1] = layerData.mapTextureCorners;
    const minX = Math.min(c0.location_x, c1.location_x);
    const maxX = Math.max(c0.location_x, c1.location_x);
    const minY = Math.min(c0.location_y, c1.location_y);
    const maxY = Math.max(c0.location_y, c1.location_y);

    return (x, y) => [
        ((x - minX) / (maxX - minX)) * width,
        ((y - minY) / (maxY - minY)) * height,
    ];
}
