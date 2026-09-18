/**
 * Reads the event table back as answers.
 *
 * Every query is scoped to a time window and, optionally, to one guild, because
 * those are the two questions anyone actually asks: what happened lately, and
 * did it happen here.
 *
 * Two traps this file exists to avoid:
 *
 *   - `laneState` returns a degenerate branch for linear modes and unsolved
 *     boards where `stepCount` and `lanes` are zero. Those zeros are not
 *     measurements, so anything averaging lane numbers filters on `solver_ok`.
 *   - A click recorded with `ok = 0` is a *refused* click, not a mistake by the
 *     member. Counting it as usage would overstate activity in exactly the
 *     guilds whose permissions are misconfigured.
 */

import { database } from "./telemetry.js";

/** Windows `/volk stats` offers, in milliseconds. */
export const PERIODS = {
    "24h": 86400000,
    "7d": 604800000,
    "30d": 2592000000,
};

export const isValidPeriod = (p) => Object.hasOwn(PERIODS, p);

/**
 * Runs a query against the event table, returning [] when telemetry is off.
 *
 * Reading must never throw into a command handler: a corrupt file should cost
 * the report, not the reply.
 */
function query(sql, params = {}) {
    const db = database();
    if (!db) return [];
    try {
        return db.prepare(sql).all(params);
    } catch (e) {
        console.error(`[STATS] query failed: ${e.message}`);
        return [];
    }
}

/** `guild_id = @guildId` only when a guild was named, as a reusable fragment. */
const scope = (guildId) => (guildId ? "AND guild_id = @guildId" : "");

/**
 * Everything `/volk stats` reports, in one pass.
 *
 * @param {string} period  a key of PERIODS
 * @param {string|null} guildId  null for every guild
 */
export function summary(period = "7d", guildId = null) {
    const since = Date.now() - (PERIODS[period] ?? PERIODS["7d"]);
    const p = { since, guildId };
    const where = scope(guildId);

    const one = (rows, fallback = 0) => rows[0]?.n ?? fallback;

    return {
        period,
        guildId,

        clicks: query(
            `SELECT action, COUNT(*) n FROM events
              WHERE kind = 'click' AND ok = 1 AND at >= @since ${where}
              GROUP BY action ORDER BY n DESC`,
            p,
        ),

        // Refused clicks answer a different question: whether a guild's operator
        // roles are set too tight for anyone to use the panel.
        denied: one(
            query(
                `SELECT COUNT(*) n FROM events
                  WHERE kind = 'click' AND ok = 0 AND at >= @since ${where}`,
                p,
            ),
        ),

        operators: one(
            query(
                `SELECT COUNT(DISTINCT user_id) n FROM events
                  WHERE kind = 'click' AND ok = 1 AND user_id IS NOT NULL
                    AND at >= @since ${where}`,
                p,
            ),
        ),

        // The mention is what the plain user id buys: `<@id>` renders as a name
        // in Discord without the bot storing one.
        topOperators: query(
            `SELECT user_id, COUNT(*) n FROM events
              WHERE kind = 'click' AND ok = 1 AND user_id IS NOT NULL
                AND at >= @since ${where}
              GROUP BY user_id ORDER BY n DESC LIMIT 5`,
            p,
        ),

        topServers: query(
            `SELECT server_id, COUNT(*) n FROM events
              WHERE server_id IS NOT NULL AND at >= @since ${where}
              GROUP BY server_id ORDER BY n DESC LIMIT 5`,
            p,
        ),

        topLayers: query(
            `SELECT layer, COUNT(*) n FROM events
              WHERE kind = 'layer_change' AND layer IS NOT NULL AND at >= @since ${where}
              GROUP BY layer ORDER BY n DESC LIMIT 5`,
            p,
        ),

        // Capped like every other list: the scopes are a closed set in normal
        // operation, but an unbounded GROUP BY is what would silently push the
        // report past Discord's message limit and truncate the footer.
        errors: query(
            `SELECT action AS scope, COUNT(*) n FROM events
              WHERE kind = 'error' AND at >= @since ${where}
              GROUP BY action ORDER BY n DESC LIMIT 8`,
            p,
        ),

        errorTotal: query(
            `SELECT COUNT(*) n FROM events WHERE kind = 'error' AND at >= @since ${where}`,
            p,
        )[0]?.n ?? 0,

        renders: one(
            query(
                `SELECT COUNT(*) n FROM events
                  WHERE kind = 'render' AND at >= @since ${where}`,
                p,
            ),
        ),

        renderFailures: one(
            query(
                `SELECT COUNT(*) n FROM events
                  WHERE kind = 'render' AND ok = 0 AND at >= @since ${where}`,
                p,
            ),
        ),

        latency: renderLatency(since, guildId),

        // Refreshes that found nothing to draw. A server offline or seeding for
        // days produces no clicks and no renders, so without this it is
        // indistinguishable from a quiet week.
        unplayable: query(
            `SELECT action AS state, server_id, COUNT(*) n FROM events
              WHERE kind = 'unplayable' AND at >= @since ${where}
              GROUP BY action, server_id ORDER BY n DESC LIMIT 5`,
            p,
        ),

        // Deliberately unscoped: "how many guilds are alive" has one answer, and
        // narrowing it to the calling guild would only ever return 1. Named so
        // that reading it from a guild-scoped summary is not misleading.
        activeGuildsGlobal: one(
            query(
                `SELECT COUNT(DISTINCT guild_id) n FROM events
                  WHERE kind = 'click' AND at >= @since AND guild_id IS NOT NULL`,
                { since },
            ),
        ),
    };
}

/**
 * p50 and p95 of successful renders.
 *
 * Computed in JS from the ordered durations rather than in SQL: SQLite has no
 * percentile function without an extension, and the row count here is small
 * enough that sorting it costs nothing.
 */
function renderLatency(since, guildId) {
    const db = database();
    if (!db) return null;

    // Percentiles are taken by offset inside SQLite rather than by pulling every
    // duration into JS and sorting there: SQLite has no percentile function, but
    // it can count and skip. A `LIMIT` on the ordered set would have been the
    // obvious shortcut and is wrong — it truncates the slow tail, which is the
    // half of the distribution p95 exists to report.
    const where = scope(guildId);
    const p = { since, guildId };

    const total =
        query(
            `SELECT COUNT(*) n FROM events
              WHERE kind = 'render' AND ok = 1 AND ms IS NOT NULL
                AND at >= @since ${where}`,
            p,
        )[0]?.n ?? 0;
    if (!total) return null;

    const at = (q) =>
        query(
            `SELECT ms FROM events
              WHERE kind = 'render' AND ok = 1 AND ms IS NOT NULL
                AND at >= @since ${where}
              ORDER BY ms LIMIT 1 OFFSET @offset`,
            { ...p, offset: Math.min(total - 1, Math.floor(total * q)) },
        )[0]?.ms ?? null;

    return { count: total, p50: at(0.5), p95: at(0.95), max: at(1) };
}

/**
 * How many confirmations it takes to close a route, per layer.
 *
 * Only rows where the solver actually ran: the degenerate branch reports zero
 * routes for linear modes, and averaging those in would make every map look
 * easier than it is.
 */
export function laneDifficulty(period = "30d", guildId = null) {
    const since = Date.now() - (PERIODS[period] ?? PERIODS["30d"]);
    return query(
        `SELECT layer,
                COUNT(*) n,
                ROUND(AVG(json_extract(meta, '$.lanes_total')), 1) routes,
                ROUND(AVG(json_extract(meta, '$.picked')), 1) picks
           FROM events
          WHERE kind = 'render' AND ok = 1 AND layer IS NOT NULL
            AND json_extract(meta, '$.solver_ok') = 1
            AND at >= @since ${scope(guildId)}
          GROUP BY layer HAVING n >= 3 ORDER BY routes DESC LIMIT 10`,
        { since, guildId },
    );
}

/** Total rows and the age of the oldest, for the footer of a report. */
export function footprint() {
    const rows = query("SELECT COUNT(*) n, MIN(at) oldest FROM events");
    return { events: rows[0]?.n ?? 0, oldest: rows[0]?.oldest ?? null };
}
