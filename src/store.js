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
 * Backed by a JSON file. Free hosting usually gives an ephemeral disk, so this
 * will need a real store before the bot runs anywhere but a machine with a
 * volume. The surface here is deliberately tiny, three reads and two writes, so
 * that swap touches this file and nothing else.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The repo root, one level up from src/, is where config.json lives.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STORE_PATH = process.env.SQUADCALC_STORE ?? join(ROOT, "config.json");

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

const EMPTY = {
    version: 2,
    discovery: { active: true, minPlayers: 50, count: 8 },
    defaults: structuredClone(DEFAULTS),
    guilds: {},
};

let cache = null;

/**
 * Version 1 kept a single guild's settings at the top level, from when the bot
 * served one channel out of the .env. Those become the defaults every guild
 * starts from, so an upgrade keeps the settings that were already in use.
 */
function migrate(raw) {
    if (raw?.version === 2) return raw;

    const { discovery, ...rest } = raw ?? {};
    return {
        version: 2,
        discovery: { ...EMPTY.discovery, ...(discovery ?? {}) },
        defaults: { ...structuredClone(DEFAULTS), ...rest },
        guilds: {},
    };
}

async function readStore() {
    if (cache) return cache;
    try {
        cache = migrate(JSON.parse(await readFile(STORE_PATH, "utf8")));
    } catch {
        cache = structuredClone(EMPTY);
    }
    await flush();
    return cache;
}

/** Written through a temporary file: a crash mid-write must not truncate it. */
async function flush() {
    const tmp = `${STORE_PATH}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(cache, null, 2) + "\n");
    await rename(tmp, STORE_PATH);
}

/** The guild's record, filled in from the defaults. Not persisted until saved. */
export async function guildConfig(guildId) {
    const store = await readStore();
    const saved = store.guilds[guildId] ?? {};
    return {
        ...structuredClone(store.defaults),
        ...saved,
        // Nested objects would otherwise be replaced wholesale by a partial one.
        auto: { ...store.defaults.auto, ...(saved.auto ?? {}) },
        roles: { ...store.defaults.roles, ...(saved.roles ?? {}) },
        guildId,
    };
}

export async function saveGuild(guildId, config) {
    const store = await readStore();
    const { guildId: _ignored, ...record } = config;
    store.guilds[guildId] = record;
    await flush();
    return config;
}


export async function readDiscovery() {
    return (await readStore()).discovery;
}

export async function saveDiscovery(discovery) {
    const store = await readStore();
    store.discovery = { ...store.discovery, ...discovery };
    await flush();
    return store.discovery;
}
