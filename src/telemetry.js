/**
 * What the bot did, and what it cost, written to a local SQLite file.
 *
 * The bot ran blind before this: 26 `console.*` calls in prose, no structure and
 * no persistence, so "who clicked", "which server is actually used" and "what
 * broke last night" had no answer once the journal rotated.
 *
 * Three rules shape everything here, and breaking any of them is worse than
 * losing the metric:
 *
 *   1. Telemetry never takes the bot down. Every public function swallows its
 *      own errors. A full disk must not cost anyone their panel.
 *   2. The existing log lines are an interface, not a detail. `tools/control`
 *      recovers the bot's state by grepping what it prints, so this writes to a
 *      parallel channel and never replaces a `console.*` call.
 *   3. Writes stay off the hot path. `laneState` runs the solver in a loop; no
 *      I/O belongs anywhere near it.
 *
 * One wide, sparse table rather than a normalised schema: the volume is
 * thousands of rows a day, and joins would cost more in maintenance than the
 * disk they save. `meta` carries a JSON blob so a new field does not mean a
 * migration.
 *
 * From phase 6 this same file also holds the guild configuration, which makes
 * the retention sweep the most dangerous statement in the project: it must only
 * ever touch `events`. See `purge`.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

// The repo root, one level up from src/, matching store.js.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = process.env.VOLK_DB ?? join(ROOT, "volk_db");

/** How long an event carrying a Discord user id is kept. */
export const RETENTION_DAYS = Number(process.env.TELEMETRY_RETENTION_DAYS ?? 90);

const DAY_MS = 86400000;

/**
 * The tables config moves into in phase 6, created empty now so that migration
 * does not have to alter the database file the bot is already writing to.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY,
  at        INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  action    TEXT,
  guild_id  TEXT,
  user_id   TEXT,
  server_id TEXT,
  layer     TEXT,
  gamemode  TEXT,
  ms        INTEGER,
  ok        INTEGER,
  detail    TEXT,
  meta      TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_at       ON events(at);
CREATE INDEX IF NOT EXISTS idx_events_kind_at  ON events(kind, at);
CREATE INDEX IF NOT EXISTS idx_events_guild_at ON events(guild_id, at);
CREATE INDEX IF NOT EXISTS idx_events_user_at  ON events(user_id, at);
-- Percentiles walk the durations in order; without this the latency report is a
-- full sort of every render row in the window.
CREATE INDEX IF NOT EXISTS idx_events_ms        ON events(kind, ms) WHERE ms IS NOT NULL;

CREATE TABLE IF NOT EXISTS guilds (
  guild_id TEXT PRIMARY KEY,
  record   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let db = null;
let insert = null;
/** Set once a failure has been reported, so a broken disk logs once, not hourly. */
let degraded = false;

/**
 * Opens the database on first use.
 *
 * Returns null instead of throwing when the file cannot be opened: a read-only
 * disk or a missing StateDirectory costs the metrics, never the panel.
 */
function connect() {
    if (db || degraded) return db;

    try {
        db = new Database(DB_PATH);
        // Losing the last event to a power cut is acceptable; stalling the event
        // loop on every click is not.
        db.pragma("journal_mode = WAL");
        db.pragma("synchronous = NORMAL");
        db.exec(SCHEMA);

        insert = db.prepare(
            `INSERT INTO events
               (at, kind, action, guild_id, user_id, server_id, layer, gamemode, ms, ok, detail, meta)
             VALUES
               (@at, @kind, @action, @guild_id, @user_id, @server_id, @layer, @gamemode, @ms, @ok, @detail, @meta)`,
        );
        console.log(`[TELEMETRY] recording to ${DB_PATH}`);
    } catch (e) {
        degraded = true;
        db = null;
        console.error(`[TELEMETRY] disabled, cannot open ${DB_PATH}: ${e.message}`);
    }
    return db;
}

/** The handle, for stats.js. Null when telemetry could not start. */
export const database = () => connect();

/**
 * SQLite binds only primitives, and `undefined` is not one of them: an absent
 * field has to reach the statement as an explicit null or the insert throws.
 */
const value = (v) => (v === undefined || v === "" ? null : v);

/**
 * Records one event. Never throws, never returns anything worth checking.
 *
 * @param {string} kind  click | render | error | lifecycle | command | layer_change
 * @param {object} fields
 */
export function track(kind, fields = {}) {
    if (!connect()) return;

    const { action, guildId, userId, serverId, layer, gamemode, ms, ok, detail, ...rest } = fields;

    try {
        insert.run({
            at: Date.now(),
            kind,
            action: value(action),
            guild_id: value(guildId),
            user_id: value(userId),
            server_id: value(serverId),
            layer: value(layer),
            gamemode: value(gamemode),
            ms: ms === undefined ? null : Math.round(ms),
            ok: ok === undefined ? null : ok ? 1 : 0,
            // Discord embeds cap well below this; the cut only guards the file.
            detail: value(typeof detail === "string" ? detail.slice(0, 500) : detail),
            meta: Object.keys(rest).length ? JSON.stringify(rest) : null,
        });
    } catch (e) {
        if (!degraded) {
            degraded = true;
            console.error(`[TELEMETRY] insert failed, disabling: ${e.message}`);
        }
    }
}

/**
 * Records a failure. `scope` is what was being attempted, not where the throw
 * happened: "render", "refresh", "command", so the dedup key stays stable when
 * the message carries a changing id.
 */
export function trackError(scope, error, fields = {}) {
    track("error", {
        ...fields,
        action: scope,
        ok: false,
        detail: error?.message ?? String(error),
        // The constructor name separates a timeout from a 500 without parsing
        // the message, which differs per upstream.
        error_type: error?.name ?? null,
    });
}

/**
 * Runs `fn`, records how long it took, and hands back whatever it returned.
 *
 * The failure is recorded before rethrowing, because a render that throws is
 * exactly the one worth knowing the duration of. Callers keep their own
 * try/catch: this changes nothing about how errors propagate.
 */
export async function timed(kind, fields, fn) {
    const started = Date.now();
    try {
        const result = await fn();
        track(kind, { ...fields, ms: Date.now() - started, ok: true });
        return result;
    } catch (e) {
        track(kind, {
            ...fields,
            ms: Date.now() - started,
            ok: false,
            detail: e?.message,
        });
        throw e;
    }
}

/**
 * Drops events past the retention window.
 *
 * Scoped to `events` on purpose and permanently: from phase 6 the guild
 * configuration lives in this same file, and a sweep that reached the wrong
 * table would take every panel offline rather than lose a metric.
 *
 * @returns {number} rows removed
 */
export function purge(days = RETENTION_DAYS) {
    if (!connect()) return 0;
    try {
        const cutoff = Date.now() - days * DAY_MS;
        const { changes } = db.prepare("DELETE FROM events WHERE at < ?").run(cutoff);
        if (changes) console.log(`[TELEMETRY] purged ${changes} events older than ${days}d`);
        return changes;
    } catch (e) {
        console.error(`[TELEMETRY] purge failed: ${e.message}`);
        return 0;
    }
}

/** Erases one member's events, for a request to be forgotten. */
export function forget(userId) {
    if (!connect()) return 0;
    try {
        const { changes } = db.prepare("DELETE FROM events WHERE user_id = ?").run(String(userId));
        return changes;
    } catch (e) {
        console.error(`[TELEMETRY] forget failed: ${e.message}`);
        return 0;
    }
}

/** Closes the handle so WAL is checkpointed into the database file. */
export function closeTelemetry() {
    if (!db) return;
    try {
        db.close();
    } catch {
        // Shutting down anyway.
    }
    db = null;
    insert = null;
}
