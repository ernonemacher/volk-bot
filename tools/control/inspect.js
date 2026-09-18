/**
 * What the bot did, read straight from its database, for the control panel.
 *
 * The supervisor used to know only what the bot printed: it recovered the tag,
 * the guilds and an error count by grepping log lines, because there was
 * nowhere else to look. There is now. This reads `volk_db` directly, which is
 * both richer and honest about the past — the log buffer holds 500 lines and
 * dies with the process, while the database remembers last week.
 *
 * Opened **read-only, and reopened on demand**. The bot owns this file and is
 * writing to it in WAL mode; a second writer would be a corruption risk for no
 * reason, and holding a handle open across a restart of the bot would serve a
 * stale snapshot. Every failure here degrades to "no data" rather than taking
 * the panel down: the panel's first job is to start and stop the bot, and it
 * has to keep doing that when the database is missing entirely, which is
 * exactly the state of a fresh clone.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

/**
 * Where the bot will put its database.
 *
 * The supervisor does not load `.env` — it hands its own environment to the
 * child, and dotenv runs there. So a `VOLK_DB` set only in `.env` would have
 * the bot writing one file while the panel read another, and the panel would
 * quietly show an empty database forever. Read the file here for that one key.
 */
function resolveDbPath() {
    if (process.env.VOLK_DB) return process.env.VOLK_DB;
    try {
        const env = readFileSync(join(ROOT, ".env"), "utf8");
        const line = env.match(/^\s*VOLK_DB\s*=\s*(.+)$/m);
        const value = line?.[1]?.trim().replace(/^["']|["']$/g, "");
        if (value) return value;
    } catch {
        // No .env, or unreadable: the default below is right.
    }
    return join(ROOT, "volk_db");
}

export const DB_PATH = resolveDbPath();

/**
 * Runs `fn` against a short-lived read-only handle.
 *
 * @returns {*} whatever `fn` returns, or `fallback` if the database is not
 *              there, is locked, or predates the table being asked about.
 */
function read(fn, fallback) {
    if (!existsSync(DB_PATH)) return fallback;
    let db;
    try {
        db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
        return fn(db);
    } catch {
        // A fresh database with no tables yet, or a read racing a checkpoint.
        // Both are ordinary; the panel shows what it has.
        return fallback;
    } finally {
        db?.close();
    }
}

const HOUR = 3600000;
const DAY = 86400000;

/**
 * The numbers the panel's header shows.
 *
 * Deliberately over the last 24h rather than all time: "12 errors" means
 * nothing without a window, and the question being asked is always "is it
 * healthy right now".
 */
export function health() {
    return read((db) => {
        const since = Date.now() - DAY;
        const count = (sql, params = { since }) => db.prepare(sql).get(params)?.n ?? 0;

        return {
            errors24h: count("SELECT COUNT(*) n FROM events WHERE kind='error' AND at >= @since"),
            clicks24h: count(
                "SELECT COUNT(*) n FROM events WHERE kind='click' AND ok=1 AND at >= @since",
            ),
            operators24h: count(
                "SELECT COUNT(DISTINCT user_id) n FROM events WHERE kind='click' AND ok=1 AND user_id IS NOT NULL AND at >= @since",
            ),
            renders24h: count("SELECT COUNT(*) n FROM events WHERE kind='render' AND at >= @since"),
            events: count("SELECT COUNT(*) n FROM events", {}),
            // Median render time, by offset rather than by pulling every row.
            renderP50: medianRender(db, since),
        };
    }, null);
}

function medianRender(db, since) {
    const n =
        db
            .prepare(
                "SELECT COUNT(*) n FROM events WHERE kind='render' AND ok=1 AND ms IS NOT NULL AND at >= @since",
            )
            .get({ since })?.n ?? 0;
    if (!n) return null;
    return (
        db
            .prepare(
                "SELECT ms FROM events WHERE kind='render' AND ok=1 AND ms IS NOT NULL AND at >= @since ORDER BY ms LIMIT 1 OFFSET @off",
            )
            .get({ since, off: Math.floor(n / 2) })?.ms ?? null
    );
}

/**
 * Recent failures, folded by scope and message shape.
 *
 * Folded for the same reason the Discord reporter folds: an unstable upstream
 * produces the same line every minute, and a list of sixty identical rows hides
 * the one failure that happened once and mattered.
 */
export function recentErrors(limit = 12) {
    return read(
        (db) =>
            db
                .prepare(
                    `SELECT action AS scope,
                            detail,
                            guild_id,
                            COUNT(*) n,
                            MAX(at) last_at
                       FROM events
                      WHERE kind = 'error' AND at >= @since
                      GROUP BY action, detail
                      ORDER BY last_at DESC
                      LIMIT @limit`,
                )
                .all({ since: Date.now() - 7 * DAY, limit }),
        [],
    );
}

/**
 * What each guild is configured for and what it has been doing.
 *
 * This is the part the log could never answer. The supervisor knows a guild is
 * "ok" because a line said so at boot; this says which server it watches, which
 * layer it last drew and whether anyone has touched it today.
 */
export function guilds() {
    return read((db) => {
        const rows = db.prepare("SELECT guild_id, record FROM guilds").all();
        const since = Date.now() - DAY;

        const lastLayer = db.prepare(
            `SELECT layer, at FROM events
              WHERE guild_id = @g AND layer IS NOT NULL
              ORDER BY at DESC LIMIT 1`,
        );
        const activity = db.prepare(
            `SELECT COUNT(*) n FROM events
              WHERE guild_id = @g AND kind = 'click' AND ok = 1 AND at >= @since`,
        );
        const trouble = db.prepare(
            `SELECT action, MAX(at) at FROM events
              WHERE guild_id = @g AND kind IN ('error','unplayable') AND at >= @since
              GROUP BY action ORDER BY at DESC LIMIT 1`,
        );

        return rows.map(({ guild_id, record }) => {
            let cfg = {};
            try {
                cfg = JSON.parse(record);
            } catch {
                // A record we cannot parse is still a guild worth listing.
            }
            const seen = lastLayer.get({ g: guild_id });
            return {
                id: guild_id,
                // What Discord calls this guild, recorded by the bot on mount.
                // Absent until it has mounted once, so the page falls back to
                // the id rather than showing nothing.
                name: cfg.name ?? null,
                icon: cfg.icon ?? null,
                channelId: cfg.channelId ?? null,
                serverId: cfg.serverId ?? null,
                language: cfg.language ?? null,
                logChannelId: cfg.logChannelId ?? null,
                auto: cfg.auto?.active ? (cfg.auto.intervalSeconds ?? 60) : null,
                pinned: Array.isArray(cfg.pinned) ? cfg.pinned.length : 0,
                layer: seen?.layer ?? null,
                layerAt: seen?.at ?? null,
                clicks24h: activity.get({ g: guild_id, since })?.n ?? 0,
                trouble: trouble.get({ g: guild_id, since })?.action ?? null,
            };
        });
    }, []);
}

/**
 * The most recent panel interactions, newest first.
 *
 * User ids are shown raw: this page is loopback-only and is the one place the
 * operator behind a click can actually be identified, which is the whole reason
 * the id is stored in clear.
 */
export function recentClicks(limit = 15) {
    return read(
        (db) =>
            db
                .prepare(
                    `SELECT at, action, guild_id, user_id, ok, meta
                       FROM events
                      WHERE kind = 'click' AND at >= @since
                      ORDER BY at DESC LIMIT @limit`,
                )
                .all({ since: Date.now() - 2 * DAY, limit })
                .map((r) => {
                    let meta = {};
                    try {
                        meta = r.meta ? JSON.parse(r.meta) : {};
                    } catch {
                        // Meta is a convenience here, never load-bearing.
                    }
                    return { ...r, meta, denied: r.ok === 0 };
                }),
        [],
    );
}

/**
 * Everything the panel asks for, in one call.
 *
 * One function so the HTTP layer has a single thing to poll and the page has a
 * single shape to render.
 */
export function inspect() {
    return {
        db: { path: DB_PATH, present: existsSync(DB_PATH) },
        health: health(),
        guilds: guilds(),
        errors: recentErrors(),
        clicks: recentClicks(),
        at: Date.now(),
    };
}

/** True when the database has a render slower than this in the last hour. */
export function slowRenders(thresholdMs = 8000) {
    return read(
        (db) =>
            db
                .prepare(
                    "SELECT COUNT(*) n FROM events WHERE kind='render' AND ms > @t AND at >= @since",
                )
                .get({ t: thresholdMs, since: Date.now() - HOUR })?.n ?? 0,
        0,
    );
}
