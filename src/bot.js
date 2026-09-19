/**
 * Discord bot that publishes a Squad layer map in a channel.
 *
 * Two messages per guild, edited in place: the text panel with controls on top,
 * the map image below as a bare attachment (Discord renders attachments far
 * larger than images embedded in an embed).
 *
 * Everything runs off public data. The server's current layer comes from the
 * SquadCalc API (itself fed by BattleMetrics), and the lane graph comes from
 * the layer endpoint. No flag state is public anywhere, so members confirm
 * flags through the dropdown and the solver narrows the board, exactly like
 * clicking flags in SquadCalc.
 *
 * No browser and no shared session: a render is a cached basemap plus an SVG
 * composite, which is what makes free hosting viable.
 */

import "dotenv/config";
import { AttachmentBuilder, Client, GatewayIntentBits, MessageFlags } from "discord.js";

import { AUTO_MAX, AUTO_MIN, fetchServerState, labelFor } from "./servers.js";
import { guildConfig, saveGuild, saveGuildIdentity } from "./store.js";
import { renderLayer } from "./render-map.js";
import { translator } from "./i18n.js";
import { canOperate } from "./permissions.js";
import { registerCommands, handleCommand } from "./commands.js";
import { closeTelemetry, purge, timed, track, trackError } from "./telemetry.js";
import { reportError, startErrorReporter } from "./reporter.js";
import {
    buildComponents,
    buildEmbed,
    canPick,
    commitLayer,
    currentState,
    newPanel,
    syncLayer,
} from "./panel.js";

const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {
    console.error("Missing DISCORD_TOKEN in .env");
    process.exit(1);
}

/** A render older than this counts as stalled rather than in flight. */
const STALLED_MS = 60000;

/** One panel per guild. A guild with no channel bound yet has no entry. */
const panels = new Map();

/**
 * Renders run one at a time *per guild*.
 *
 * Two passes editing the same two messages interleave badly: the map of one can
 * land under the text of the other, and the auto timer colliding with a button
 * press is routine. Guilds do not share a queue, so a slow one cannot stall
 * everyone else.
 */
function enqueue(panel, task) {
    const run = panel.queue.then(task, task);
    panel.queue = run.catch(() => {});
    return run;
}

/**
 * Identifies the rendered image: layer, perspective, flags confirmed and the
 * two factions, which are everything the drawing depends on. When it is
 * unchanged we skip re-uploading several hundred kilobytes that would look
 * identical.
 */
const renderKey = (p, status) =>
    `${p.layerName}|${p.perspective}|${p.picked.join(">")}|${status.team1}v${status.team2}`;

// --- refresh ---------------------------------------------------------------

async function refresh(panel) {
    panel.rendering = true;
    panel.renderingSince = Date.now();

    const config = await guildConfig(panel.guildId);
    const t = translator(config.language ?? "en");

    try {
        const channel = await client.channels.fetch(panel.channelId);
        const status = await fetchServerState(panel.serverId);
        const label = await labelFor(panel.serverId, config);

        // Before the offline branch too: it publishes the same two messages, so
        // a deletion left unnoticed there inverts the panel just the same.
        await reconcileMessages(panel, channel);

        if (!status.playable) {
            const reasonKey = status.found ? "reason.seed" : "reason.offline";
            // Controls stay on a dead panel on purpose: a server that went
            // offline is exactly when someone needs the server selector.
            await publishText(
                panel,
                channel,
                buildEmbed({ panel, status: { ...status, live: false, reasonKey }, label, t }),
                await buildComponents(panel, null, t, status, config),
            );
            await publishMap(panel, channel, null, `_${t(reasonKey)}_`);
            // Recorded, because a panel that is up but unplayable looks
            // identical to a healthy one in every other count: without this a
            // server offline for days leaves no trace at all.
            track("unplayable", {
                guildId: panel.guildId,
                serverId: panel.serverId,
                action: status.found ? "seeding" : "offline",
                players: status.players ?? null,
                ok: false,
            });
            return;
        }

        const layerChanged = syncLayer(panel, status.layer);
        const state = await currentState(panel);

        // The richest server-side datum there is: it says how long a match ran
        // and which layers a server actually rotates through.
        if (layerChanged) {
            track("layer_change", {
                guildId: panel.guildId,
                serverId: panel.serverId,
                layer: status.layer,
                gamemode: state?.gamemode,
                players: status.players,
                playTimeMin: status.playTimeMin,
            });
        }

        const key = renderKey(panel, status);
        const needsImage = key !== panel.lastRenderKey;
        const image = needsImage
            ? (
                  await timed(
                      "render",
                      {
                          guildId: panel.guildId,
                          serverId: panel.serverId,
                          layer: panel.layerName,
                          gamemode: state?.gamemode,
                          // laneState zeroes stepCount and lanes on its
                          // degenerate branch (linear modes, or an unsolved
                          // board). Without these two flags those zeros read as
                          // real measurements in any later query.
                          linear: state?.linear ?? null,
                          solver_ok: state ? state.stepCount > 0 : null,
                          picked: panel.picked.length,
                          lanes_alive: state?.lanes?.alive ?? null,
                          lanes_total: state?.lanes?.total ?? null,
                      },
                      () =>
                          renderLayer(panel.layerName, panel.picked, {
                              perspective: panel.perspective,
                              factions: { team1: status.team1, team2: status.team2 },
                          }),
                  )
              ).image
            : null;

        await publishText(
            panel,
            channel,
            buildEmbed({ panel, status: { ...status, live: true }, state, label, t, layerChanged }),
            await buildComponents(panel, state, t, status, config),
        );
        if (needsImage) {
            await publishMap(panel, channel, image);
            panel.lastRenderKey = key;
        }
        commitLayer(panel);
    } catch (e) {
        // This exact wording is parsed by tools/control/server.js to mark the
        // guild as failing. Telemetry goes beside it, never in place of it.
        console.error(`[BOT] refresh failed for guild ${panel.guildId}:`, e.message);
        trackError("refresh", e, {
            guildId: panel.guildId,
            serverId: panel.serverId,
            layer: panel.layerName,
        });
        reportError(client, panel.guildId, "refresh", e);
        // Same reason as the offline branch: an error panel with no controls
        // can only be recovered by restarting the process.
        try {
            const channel = await client.channels.fetch(panel.channelId);
            await publishText(
                panel,
                channel,
                buildEmbed({
                    panel,
                    status: { live: true },
                    label: "Panel",
                    t,
                    error: e.message.slice(0, 300),
                }),
                await buildComponents(panel, null, t, {}, config).catch(() => []),
            );
        } catch {
            // The channel itself is gone; /volk setup rebinds it.
        }
    } finally {
        panel.rendering = false;
        panel.renderingSince = 0;
    }
}

// --- message plumbing ------------------------------------------------------

async function editOrCreate(panel, channel, key, payload) {
    // `attachments: []` means "drop what is already attached", which only makes
    // sense on an edit. Sent alongside an upload on a fresh message it
    // contradicts the file and Discord rejects the whole body.
    const { attachments: _onlyForEdits, ...fresh } = payload;

    if (panel[key]) {
        try {
            const message = await channel.messages.fetch(panel[key]);
            await message.edit(payload);
            return;
        } catch (e) {
            // Deleted by someone, or an edit that referenced an attachment
            // Discord no longer holds. Either way the id is unusable.
            console.warn(`[BOT] ${key} unusable, reposting: ${e.message.split("\n")[0]}`);
            panel[key] = null;
            panel.lastRenderKey = null; // the image has to go up again
        }
    }
    const message = await channel.send(fresh);
    panel[key] = message.id;
}

const publishText = (panel, channel, embed, components) =>
    editOrCreate(panel, channel, "textMessageId", { content: "", embeds: [embed], components });

/**
 * The map goes out as a fresh attachment every time: Discord's CDN caches by
 * URL, so reusing a filename would leave the stale image on screen.
 */
const publishMap = (panel, channel, image, fallback = "") =>
    editOrCreate(panel, channel, "mapMessageId", {
        content: image ? "" : fallback,
        embeds: [],
        attachments: [],
        files: image ? [new AttachmentBuilder(image, { name: `map-${Date.now()}.jpg` })] : [],
    });

/** Removes a panel's two messages from whatever channel they are in. */
async function discardMessages(panel) {
    if (!panel.channelId) return;
    const channel = await client.channels.fetch(panel.channelId);
    for (const id of [panel.textMessageId, panel.mapMessageId].filter(Boolean)) {
        await channel.messages
            .fetch(id)
            .then((m) => m.delete())
            .catch(() => {});
    }
    panel.textMessageId = null;
    panel.mapMessageId = null;
    panel.lastRenderKey = null;
}

/**
 * Notices a panel message someone deleted, so it comes back.
 *
 * Without this the map only reappears when something else changes the render
 * key: delete it during a quiet match and the panel stays half gone for as long
 * as the layer holds.
 */
async function reconcileMessages(panel, channel) {
    const alive = async (id) =>
        Boolean(id) && (await channel.messages.fetch(id).then(() => true, () => false));

    if (!(await alive(panel.textMessageId))) {
        // Both go, not just the text: a new text message would land *under* the
        // surviving map and invert the panel.
        panel.textMessageId = null;
        if (panel.mapMessageId) {
            await channel.messages
                .fetch(panel.mapMessageId)
                .then((m) => m.delete())
                .catch(() => {});
        }
        panel.mapMessageId = null;
        panel.lastRenderKey = null;
        return;
    }

    if (!(await alive(panel.mapMessageId))) {
        panel.mapMessageId = null;
        panel.lastRenderKey = null;
    }
}

/**
 * Adopts the bot's own messages on boot and deletes leftovers, so restarting
 * edits the panel in place instead of stacking a new one.
 */
async function adoptMessages(panel, channel) {
    const recent = await channel.messages.fetch({ limit: 50 });
    const mine = [...recent.values()]
        .filter((m) => m.author.id === client.user.id)
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

    const text = mine.find((m) => m.embeds.length > 0);
    // Not `attachments.size > 0`: offline the map message carries the reason as
    // plain text and no file at all, so requiring an attachment orphaned it,
    // deleted it as a leftover, and let the next refresh post a third message.
    const map = mine.find((m) => m.embeds.length === 0);
    panel.textMessageId = text?.id ?? null;
    panel.mapMessageId = map?.id ?? null;

    const keep = new Set([text?.id, map?.id].filter(Boolean));
    for (const m of mine.filter((m) => !keep.has(m.id))) {
        await m.delete().catch(() => {});
        await new Promise((r) => setTimeout(r, 350));
    }
}

// --- panels ----------------------------------------------------------------

/**
 * Binds a guild's panel to its configured channel, adopting whatever is already
 * there. Returns null when the guild has not run /volk setup.
 */
async function mount(guildId) {
    const config = await guildConfig(guildId);
    if (!config.channelId) return null;

    let channel;
    try {
        channel = await client.channels.fetch(config.channelId);
    } catch (e) {
        // Parsed by tools/control/server.js as the guild's "unreachable" state.
        console.error(`[BOT] guild ${guildId}: channel unreachable (${e.message})`);
        trackError("mount", e, { guildId });
        return null;
    }

    // The control panel has the guild's id and nothing else to call it by, so
    // record what Discord calls it while we have the object in hand. Observed,
    // not configured: a rename or a new icon lands here on the next mount.
    // Awaited but harmless: the store swallows its own failures.
    const guild = channel.guild;
    if (guild) {
        await saveGuildIdentity(guildId, {
            name: guild.name,
            // A guild with no icon returns null, which the panel renders as
            // initials. Size-capped because this is decoration on a local page.
            icon: guild.iconURL?.({ extension: "png", size: 64 }) ?? null,
        });
    }

    const panel = newPanel(config.serverId, { guildId, channelId: config.channelId });
    panels.set(guildId, panel);
    await adoptMessages(panel, channel);
    await enqueue(panel, () => refresh(panel));
    rearmAuto(panel, config);
    console.log(`[BOT] guild ${guildId}: panel on #${channel.name}`);
    return panel;
}

/** Rebinds a guild after a setup, a config change or a manual republish. */
export async function repaint(guildId, { republish = false } = {}) {
    const config = await guildConfig(guildId);
    const panel = panels.get(guildId);

    // Channel moved, or the guild had no panel yet: mount from scratch.
    if (!panel || panel.channelId !== config.channelId) {
        if (panel) {
            stopAuto(panel);
            // Wait for whatever is already rendering before touching the
            // messages. `discardMessages` nulls both ids, and a refresh still
            // in flight reads that as "they are gone" and posts a fresh pair
            // into the channel we are leaving: two messages nobody owns, never
            // updated and never cleaned up, which is the frozen panel this
            // branch exists to prevent.
            await panel.queue.catch(() => {});
            // Clear the old channel first. A panel left behind keeps showing a
            // frozen match and reads as the live one.
            await discardMessages(panel).catch(() => {});
        }
        panels.delete(guildId);
        return mount(guildId);
    }

    rearmAuto(panel, config);
    const channel = await client.channels.fetch(panel.channelId);

    // Inside the queue so it cannot tear a render that is already in flight.
    return enqueue(panel, async () => {
        if (republish) {
            for (const id of [panel.textMessageId, panel.mapMessageId].filter(Boolean)) {
                await channel.messages
                    .fetch(id)
                    .then((m) => m.delete())
                    .catch(() => {});
            }
            panel.textMessageId = null;
            panel.mapMessageId = null;
            panel.lastRenderKey = null;
        }
        return refresh(panel);
    });
}

// --- auto refresh ----------------------------------------------------------

function stopAuto(panel) {
    if (panel.autoTimer) clearInterval(panel.autoTimer);
    panel.autoTimer = null;
}

/**
 * Upstream freshness varies a lot by server: measured 27s for the servers we
 * watch, but up to 758s for ones BattleMetrics polls rarely. A minute keeps up
 * with the good case without hammering the API, and the map upload is skipped
 * when nothing actually changed.
 */
function rearmAuto(panel, config) {
    stopAuto(panel);
    if (!config.auto?.active) return;

    const seconds = Math.min(Math.max(config.auto.intervalSeconds ?? 60, AUTO_MIN), AUTO_MAX);
    panel.autoTimer = setInterval(() => {
        enqueue(panel, () => refresh(panel)).catch((e) => {
            console.error(`[BOT] auto refresh failed for guild ${panel.guildId}:`, e.message);
            trackError("auto", e, { guildId: panel.guildId, serverId: panel.serverId });
        });
    }, seconds * 1000);
}

// --- client ----------------------------------------------------------------

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", async () => {
    // tools/control/server.js reads this exact line to recover the bot's tag.
    console.log(`[BOT] connected as ${client.user.tag}`);
    track("lifecycle", { action: "boot", tag: client.user.tag });
    startErrorReporter(client);
    startRetention();

    const guilds = await client.guilds.fetch();
    if (!guilds.size) {
        // Both scopes, or the install completes without adding the bot to the
        // guild and its commands never register. 125952 is the six channel
        // permissions the panel needs; see missingPermissions in commands.js.
        console.error(
            "Not in any guild. Invite it: https://discord.com/oauth2/authorize?client_id=" +
                `${client.user.id}&permissions=125952&scope=bot+applications.commands`,
        );
    }

    for (const [guildId] of guilds) {
        await registerCommands(client, guildId).catch((e) =>
            console.error(`[BOT] command registration failed for ${guildId}: ${e.message}`),
        );

        // Adopt the channel the single-guild build used, so an upgrade keeps
        // publishing where it already was instead of going quiet until setup.
        const config = await guildConfig(guildId);
        if (!config.channelId && process.env.DISCORD_CHANNEL_ID) {
            const channel = await client.channels
                .fetch(process.env.DISCORD_CHANNEL_ID)
                .catch(() => null);
            if (channel?.guildId === guildId) {
                // Only the field that changed: `config` is a snapshot, and
                // writing all of it would revert anything saved since.
                await saveGuild(guildId, { channelId: channel.id });
                console.log(`[BOT] guild ${guildId}: adopted #${channel.name} from DISCORD_CHANNEL_ID`);
            }
        }

        if (!(await mount(guildId))) {
            console.log(`[BOT] guild ${guildId}: no channel bound, waiting for /volk setup`);
        }
    }
});

client.on("guildCreate", async (guild) => {
    console.log(`[BOT] added to ${guild.name}`);
    // install/uninstall pairs are what tell growth from churn: a guild that
    // adds the bot and never clicks anything looks identical to a healthy one
    // in the guild count alone.
    track("lifecycle", { action: "install", guildId: guild.id, name: guild.name });
    await registerCommands(client, guild.id).catch((e) => {
        console.error(`[BOT] command registration failed for ${guild.id}: ${e.message}`);
        trackError("register", e, { guildId: guild.id });
    });
});

client.on("guildDelete", (guild) => {
    const panel = panels.get(guild.id);
    if (panel) stopAuto(panel);
    panels.delete(guild.id);
    console.log(`[BOT] removed from ${guild.name}`);
    track("lifecycle", { action: "uninstall", guildId: guild.id, name: guild.name });
});

client.on("interactionCreate", async (i) => {
    if (!i.guildId) return;

    if (i.isChatInputCommand() && i.commandName === "volk") {
        try {
            return await handleCommand(i, repaint);
        } catch (e) {
            trackError("command", e, {
                guildId: i.guildId,
                userId: i.user.id,
                sub: i.options?.getSubcommand?.(false) ?? null,
            });
            reportError(client, i.guildId, "command", e);
            const payload = {
                content: `Failed: ${e.message}`.slice(0, 300),
                flags: MessageFlags.Ephemeral,
            };
            return i.deferred || i.replied ? i.editReply(payload) : i.reply(payload);
        }
    }

    if (!i.isStringSelectMenu() && !i.isButton()) return;

    const panel = panels.get(i.guildId);
    const config = await guildConfig(i.guildId);
    const t = translator(config.language ?? "en");

    if (!panel) return i.reply({ content: t("warn.noPanel"), flags: MessageFlags.Ephemeral });

    // The slash command is gated by Discord; the panel's controls are not, so
    // this is the only place operating can be restricted to a role.
    if (!canOperate(i, config)) {
        // Recorded with the member's id: a guild where the same people keep
        // bouncing off the panel has its operator roles set too tight, and
        // without the id there is nobody to go and ask.
        track("click", {
            action: i.customId,
            guildId: i.guildId,
            userId: i.user.id,
            serverId: panel.serverId,
            layer: panel.layerName,
            denied: "permission",
            ok: false,
        });
        return i.reply({ content: t("warn.notAllowed"), flags: MessageFlags.Ephemeral });
    }

    // A render in flight owns both messages, so a click landing mid-pass would
    // be drawn from state that is about to be replaced. Everyone waits, admins
    // included: the old bypass was the race it was meant to work around.
    if (panel.rendering) {
        const busyFor = Date.now() - panel.renderingSince;
        if (busyFor < STALLED_MS) {
            return i.reply({
                content: t("warn.refreshing", { n: Math.round(busyFor / 1000) }),
                flags: MessageFlags.Ephemeral,
            });
        }
        // Past the threshold the flag is stale rather than busy. Without this a
        // render that died mid-pass would lock the panel until a restart.
        console.warn(`[BOT] clearing a stalled render after ${Math.round(busyFor / 1000)}s`);
        panel.rendering = false;
    }

    await i.deferUpdate();

    // One point for every control, before the branches act: what the click was
    // and who made it is the same shape whichever button it was, and the
    // per-control detail rides along in `value`.
    track("click", {
        action: i.customId,
        guildId: i.guildId,
        userId: i.user.id,
        serverId: panel.serverId,
        layer: panel.layerName,
        value: i.values?.[0] ?? null,
        picked: panel.picked.length,
        ok: true,
    });

    if (i.customId === "perspective") {
        panel.perspective = i.values[0];
        panel.picked = [];
        panel.lastRenderKey = null;
    }
    if (i.customId === "server") {
        panel.serverId = i.values[0];
        panel.layerName = null; // different server, different match
        panel.pendingLayer = null; // nothing staged worth retrying either
        panel.picked = [];
        panel.lastRenderKey = null;
        // Survives a restart: which server to watch is a choice, not state.
        // Only this field, so a config read earlier in the interaction cannot
        // put back whatever an admin changed in the meantime.
        await saveGuild(i.guildId, { serverId: panel.serverId });
    }
    if (i.customId === "flag") {
        // Late interactions are real: someone picks an option that a layer
        // change already invalidated. Ignore instead of corrupting the walk.
        if (await canPick(panel, i.values[0])) panel.picked.push(i.values[0]);
    }
    if (i.customId === "undo") panel.picked.pop();
    if (i.customId === "reset") panel.picked = [];

    await enqueue(panel, () => refresh(panel));
});

client.on("error", (e) => {
    console.error("[BOT] client error:", e.message);
    trackError("client", e);
});
process.on("unhandledRejection", (e) => {
    console.error("[BOT] unhandled rejection:", e?.message ?? e);
    trackError("unhandled", e);
});

/**
 * Drops events past the retention window, on boot and daily after that.
 *
 * Unref'd: a purge waiting to fire must not be the reason the process refuses
 * to exit on shutdown.
 */
function startRetention() {
    purge();
    setInterval(purge, 86400000).unref();
}

/** Guards against a second pass: see `shutdown`. */
let stopping = false;

async function shutdown() {
    // Two triggers can arrive together, and routinely do: the supervisor sends
    // SIGTERM and then exits, which `watchSupervisor` notices. Without this,
    // the second pass runs `track` after the first already called
    // `closeTelemetry`, which reopens the database and recreates the WAL that
    // was just checkpointed away, defeating the reason for closing it.
    if (stopping) return;
    stopping = true;

    console.log("\n[BOT] shutting down");
    for (const panel of panels.values()) stopAuto(panel);
    track("lifecycle", { action: "shutdown" });
    // Closed before exit so WAL is checkpointed into the database file rather
    // than left for the next boot to recover.
    closeTelemetry();
    // Exit even if the gateway refuses to close: the caller is a signal or a
    // dead supervisor, and staying up is the failure being avoided.
    await client.destroy().catch((e) => console.error(`[BOT] destroy failed: ${e.message}`));
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/**
 * Exits if the supervisor that started us is gone.
 *
 * SIGKILL on the control panel leaves this process orphaned but perfectly
 * healthy: it keeps the gateway, keeps refreshing, and writes its log into a
 * pipe nobody reads. The next launch then starts a *second* bot on the same
 * token, and two clients edit the same two messages per guild: the
 * interleaving `enqueue` prevents within one process and cannot prevent across
 * two.
 *
 * Only when we were actually spawned by a supervisor: run straight from
 * `npm start` the parent is a shell whose exit is none of our business, and
 * `VOLK_SUPERVISOR_PID` is what tells the two apart.
 */
function watchSupervisor() {
    const parent = Number(process.env.VOLK_SUPERVISOR_PID);
    if (!parent) return;

    setInterval(() => {
        try {
            // Signal 0 tests for the process without touching it.
            process.kill(parent, 0);
        } catch {
            console.log(`[BOT] supervisor ${parent} is gone, exiting`);
            // Unawaited by nature (an interval), so its failure has to be
            // handled here or it surfaces as an unhandledRejection and the
            // process never reaches the exit this exists to perform.
            shutdown().catch((e) => {
                console.error(`[BOT] shutdown failed: ${e.message}`);
                process.exit(1);
            });
        }
    }, 5000).unref();
}
watchSupervisor();

client.login(TOKEN);
