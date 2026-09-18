/**
 * Everything the bot must remember across a restart, one record per guild.
 *
 * Split in three, because the three have different owners:
 *
 *   discovery  global. Which BattleMetrics servers are worth surfacing is the
 *              same question for everyone, so one setting serves all guilds.
 *   defaults   what a guild starts from the first time the bot sees it.
 *   guilds     per guild: its panel channel, its pinned servers, its language,
 *              its roles. None of these can be shared, which is the whole
 *              reason this file exists.
 *
 * Backed by the same SQLite file the usage events go to. The JSON file this
 * replaced was written whole on every change, which is fine for a handful of
 * guilds and stops being fine well before it breaks: one torn write loses every
 * guild's channel binding at once.
 *
 * The four functions below kept their signatures, including `async` ones that
 * no longer await anything. better-sqlite3 is synchronous, but changing the
 * shape would have meant touching every caller for no gain, and a promise that
 * resolves immediately costs nothing.
 *
 * An existing `config.json` is imported once, on first use, and then left alone
 * on disk. It is not deleted: if this migration read a field wrong, the file it
 * came from is the only way to notice.
 */

import { readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { database } from "./telemetry.js";

// The repo root, one level up from src/, is where config.json lives.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY_PATH = process.env.SQUADCALC_STORE ?? join(ROOT, "config.json");

const DEFAULTS = {
    pinned: [
        { id: "28601902", label: "FEB #1" },
        { id: "36076789", label: "FEB #2" },
    ],
    serverId: "28601902",
    language: "en",
    mapType: "terrainmap",
    auto: {
        // On by default: the panel's main job is noticing a layer change on its
        // own, and upstream data for the servers we watch measured around 30s
        // old, so a minute keeps up without hammering anything.
        active: true,
        intervalSeconds: 60,
    },
    // Empty means "anyone may operate the panel"; see permissions.js.
    roles: { admin: [], operator: [] },
    // Where failures are reported. Null means nothing is sent: the events are
    // still recorded, so this is a notification channel, not the record.
    logChannelId: null,
};

const DISCOVERY = { active: true, minPlayers: 50, count: 8 };

/**
 * Last-resort store for when SQLite could not be opened.
 *
 * Telemetry can afford to disappear; configuration cannot. Without this a
 * database that fails to open would make `guildConfig` throw on every refresh
 * and take every panel down, which is precisely the failure this phase was
 * separated out to avoid.
 */
const memory = { guilds: new Map(), settings: new Map() };

let ready = false;

/** Opens the database and imports `config.json` the first time. */
function connect() {
    const db = database();
    if (db && !ready) {
        ready = true;
        importLegacy(db);
    }
    return db;
}

// --- settings --------------------------------------------------------------

function readSetting(key, fallback) {
    const db = connect();
    if (!db) return memory.settings.get(key) ?? structuredClone(fallback);
    try {
        const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
        return row ? JSON.parse(row.value) : structuredClone(fallback);
    } catch (e) {
        console.error(`[STORE] read ${key} failed: ${e.message}`);
        return structuredClone(fallback);
    }
}

function writeSetting(key, value) {
    const db = connect();
    if (!db) {
        memory.settings.set(key, value);
        return;
    }
    db.prepare(
        "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, JSON.stringify(value));
}

const readDefaults = () => ({ ...structuredClone(DEFAULTS), ...readSetting("defaults", {}) });

// --- migration -------------------------------------------------------------

/**
 * Copies an existing `config.json` in, once.
 *
 * Guarded by a marker row rather than by the file's absence: the file stays on
 * disk afterwards as a backup, so "does it exist" cannot tell a fresh install
 * from one already imported, and re-running it would undo every change made
 * since.
 *
 * Version 1 kept a single guild's settings at the top level, from when the bot
 * served one channel out of the .env. Those become the defaults every guild
 * starts from, so an upgrade keeps the settings that were already in use.
 */
function importLegacy(db) {
    const done = db.prepare("SELECT value FROM settings WHERE key = 'migrated'").get();
    if (done || !existsSync(LEGACY_PATH)) return;

    let raw;
    try {
        raw = JSON.parse(readFileSync(LEGACY_PATH, "utf8"));
    } catch (e) {
        console.error(`[STORE] ${LEGACY_PATH} unreadable, starting fresh: ${e.message}`);
        return;
    }

    const isV2 = raw?.version === 2;
    const { discovery, ...rest } = raw ?? {};
    const defaults = isV2 ? (raw.defaults ?? {}) : rest;
    const guilds = isV2 ? (raw.guilds ?? {}) : {};

    // One transaction: a crash halfway must not leave some guilds imported and
    // the marker unwritten, which on the next boot would import them twice.
    db.transaction(() => {
        const put = db.prepare(
            "INSERT INTO guilds(guild_id, record) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET record = excluded.record",
        );
        for (const [guildId, record] of Object.entries(guilds)) {
            put.run(guildId, JSON.stringify(record));
        }
        const set = db.prepare(
            "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        );
        set.run("defaults", JSON.stringify(defaults));
        set.run("discovery", JSON.stringify({ ...DISCOVERY, ...(discovery ?? {}) }));
        set.run("migrated", JSON.stringify({ at: Date.now(), from: LEGACY_PATH }));
    })();

    const n = Object.keys(guilds).length;
    console.log(`[STORE] imported ${n} guild(s) from ${LEGACY_PATH}; the file is kept as a backup`);

    // Renamed so nobody edits it later expecting an effect. Best effort: a
    // read-only directory is not a reason to fail the boot.
    try {
        renameSync(LEGACY_PATH, `${LEGACY_PATH}.migrated`);
    } catch {
        // Left in place; the marker row already prevents a second import.
    }
}

// --- guilds ----------------------------------------------------------------

/** The guild's record, filled in from the defaults. Not persisted until saved. */
export async function guildConfig(guildId) {
    const db = connect();
    const defaults = readDefaults();

    let saved = {};
    if (!db) {
        saved = memory.guilds.get(guildId) ?? {};
    } else {
        try {
            const row = db.prepare("SELECT record FROM guilds WHERE guild_id = ?").get(guildId);
            if (row) saved = JSON.parse(row.record);
        } catch (e) {
            console.error(`[STORE] read guild ${guildId} failed: ${e.message}`);
        }
    }

    return {
        ...defaults,
        ...saved,
        // Nested objects would otherwise be replaced wholesale by a partial one.
        auto: { ...defaults.auto, ...(saved.auto ?? {}) },
        roles: { ...defaults.roles, ...(saved.roles ?? {}) },
        guildId,
    };
}

export async function saveGuild(guildId, config) {
    const db = connect();
    const { guildId: _ignored, ...record } = config;

    if (!db) {
        memory.guilds.set(guildId, record);
        return config;
    }
    db.prepare(
        "INSERT INTO guilds(guild_id, record) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET record = excluded.record",
    ).run(guildId, JSON.stringify(record));
    return config;
}

/**
 * Records what a guild currently *is* (its name and icon), as opposed to how
 * it is configured.
 *
 * Kept apart from `saveGuild` on purpose. These are observed from Discord on
 * every mount rather than chosen by an admin, and they change without anyone
 * touching the bot. Writing them through `saveGuild` would mean handing it a
 * whole config object just to update a name, and a caller holding a slightly
 * stale config would silently revert a rename. This merges the two fields into
 * whatever record is on disk and leaves the rest alone.
 *
 * Only useful to the control panel, which otherwise has ids and nothing else to
 * show for a guild.
 */
export async function saveGuildIdentity(guildId, { name, icon }) {
    const db = connect();
    const identity = { name: name ?? null, icon: icon ?? null };

    if (!db) {
        memory.guilds.set(guildId, { ...(memory.guilds.get(guildId) ?? {}), ...identity });
        return;
    }
    try {
        const row = db.prepare("SELECT record FROM guilds WHERE guild_id = ?").get(guildId);
        const record = row ? JSON.parse(row.record) : {};
        // Nothing changed: skip the write. Mounts are frequent and this runs on
        // every one of them.
        if (record.name === identity.name && record.icon === identity.icon) return;
        db.prepare(
            "INSERT INTO guilds(guild_id, record) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET record = excluded.record",
        ).run(guildId, JSON.stringify({ ...record, ...identity }));
    } catch (e) {
        // A name on a panel is not worth failing a mount over.
        console.error(`[STORE] guild ${guildId} identity failed: ${e.message}`);
    }
}

// --- discovery -------------------------------------------------------------

export async function readDiscovery() {
    return { ...DISCOVERY, ...readSetting("discovery", {}) };
}

export async function saveDiscovery(discovery) {
    const merged = { ...(await readDiscovery()), ...discovery };
    writeSetting("discovery", merged);
    return merged;
}

/**
 * Writes the current state back out as JSON, for a backup or to inspect it.
 *
 * The database is the record now; this is a convenience, and deliberately not
 * the path the bot itself reads.
 */
export async function exportJson(path) {
    const db = connect();
    const guilds = {};
    if (db) {
        for (const row of db.prepare("SELECT guild_id, record FROM guilds").all()) {
            guilds[row.guild_id] = JSON.parse(row.record);
        }
    } else {
        for (const [id, record] of memory.guilds) guilds[id] = record;
    }
    const payload = {
        version: 2,
        discovery: await readDiscovery(),
        defaults: readDefaults(),
        guilds,
    };
    writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
    return payload;
}
