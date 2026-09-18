/**
 * Panel state and Discord message building.
 *
 * The panel tracks, per Discord channel:
 *   - which Squad server it watches
 *   - the layer that server is currently running
 *   - the flags someone has picked so far, narrowing the lane
 *
 * Picked flags reset automatically when the server changes layer, mirroring
 * SquadCalc's own `_resetLayer`: a new match means a new lane.
 */

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    StringSelectMenuBuilder,
} from "discord.js";

import {
    fetchLayer,
    hasLane,
    keypadOf,
    laneState,
    needsPerspective,
    unitNameOf,
} from "./layer.js";
import { listServers, squadcalcUrl } from "./servers.js";

const COLOUR = {
    live: 0x4a7534,
    paused: 0xa9731a,
    error: 0xb22222,
};

/** Discord allows at most 25 options in a select menu. */
const MAX_OPTIONS = 25;

/** One panel per guild. */
export function newPanel(serverId, { guildId, channelId } = {}) {
    return {
        guildId,
        channelId,
        serverId,
        layerName: null, // layer the confirmations belong to
        pendingLayer: null, // adopted but not yet published; see syncLayer
        picked: [], // flag keys, in the order confirmed
        perspective: "team1", // which main the depths count from
        textMessageId: null,
        mapMessageId: null,
        lastRenderKey: null,
        rendering: false,
        renderingSince: 0,
        autoTimer: null,
        // Serialises this guild's renders; see `enqueue` in bot.js.
        queue: Promise.resolve(),
    };
}

/**
 * Drops the picks when the server moved on to another layer.
 *
 * The move is only *staged* here. A refresh that adopts a new layer and then
 * fails before publishing would otherwise leave the panel believing it already
 * drew the new layer: the next tick sees `panel.layerName` matching the server,
 * returns early, and the render key still matches the last upload, so the old
 * map stays on screen until the server rotates again. `commitLayer` closes the
 * transition once the publish that used it actually landed.
 *
 * @returns {boolean} whether a reset happened
 */
export function syncLayer(panel, layerName) {
    if (panel.layerName === layerName && !panel.pendingLayer) return false;
    panel.layerName = layerName;
    panel.pendingLayer = layerName;
    panel.picked = [];
    panel.perspective = "team1";
    return true;
}

/** Marks the staged layer as successfully published. */
export function commitLayer(panel) {
    panel.pendingLayer = null;
}

export async function buildComponents(panel, state, t, status = {}, config = {}) {
    const rows = [];

    // --- server -----------------------------------------------------------
    const servers = await listServers(config);
    if (!servers.some((s) => s.id === panel.serverId)) {
        // Keep the current pick visible even if it dropped out of the list,
        // otherwise Discord rejects the `default` flag.
        servers.unshift({ id: panel.serverId, label: panel.serverId, isPinned: false });
    }
    rows.push(
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId("server")
                .setPlaceholder(t("select.server"))
                .addOptions(
                    servers.slice(0, MAX_OPTIONS).map((s) => ({
                        label: s.isPinned ? `★ ${s.label}` : s.label,
                        description: s.description?.slice(0, 100),
                        value: s.id,
                        default: s.id === panel.serverId,
                    })),
                ),
        ),
    );

    // --- perspective ------------------------------------------------------
    // RAAS and RVAAS are symmetric, so the lane depends on which main you walk
    // from and the member has to say. Invasion is asymmetric and the attacker
    // is fixed, so offering the choice there would be meaningless.
    if (state && needsPerspective(state.gamemode) && !panel.picked.length) {
        const layer = await fetchLayer(panel.layerName);
        rows.push(
            new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId("perspective")
                    .setPlaceholder(t("select.team"))
                    .addOptions(
                        ["team1", "team2"].map((side) => {
                            // Nobody picks a side by its number: the faction is
                            // what identifies it, and the unit says how it plays.
                            const faction = side === "team1" ? status.team1 : status.team2;
                            const unit = unitNameOf(
                                layer,
                                side === "team1" ? status.unit1 : status.unit2,
                            );
                            return {
                                label: (faction ? `${t(side)} · ${faction}` : t(side)).slice(0, 100),
                                description: unit?.slice(0, 100),
                                value: side,
                                default: side === panel.perspective,
                            };
                        }),
                    ),
            ),
        );
    }

    // --- flags -----------------------------------------------------------
    // Only the candidates for the next depth. The solver accepts confirmations
    // in any order, but a menu holding every remaining objective was unreadable
    // and let people confirm a deep flag whose depth cannot be pinned yet,
    // which leaves the chain ambiguous.
    if (state?.nextFlags?.length && hasLane(state.gamemode) && !state.linear) {
        const layer = await fetchLayer(panel.layerName);
        rows.push(
            new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId("flag")
                    .setPlaceholder(t("panel.nextFlag", { n: state.currentPosition }))
                    .addOptions(
                        [...state.nextFlags]
                            .sort((a, b) => b.percentage - a.percentage)
                            .slice(0, MAX_OPTIONS)
                            .map((flag) => ({
                                label: flag.name.slice(0, 100),
                                description: [
                                    keypadOf(layer, flag.x, flag.y),
                                    `${Math.round(flag.percentage)}%`,
                                ]
                                    .filter(Boolean)
                                    .join(" · "),
                                value: flag.key.slice(0, 100),
                            })),
                    ),
            ),
        );
    }

    // --- buttons ----------------------------------------------------------
    const buttons = [
        new ButtonBuilder()
            .setCustomId("refresh")
            .setLabel(t("button.refresh"))
            .setStyle(ButtonStyle.Primary),
    ];

    if (panel.picked.length) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId("undo")
                .setLabel(t("button.undo"))
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId("reset")
                .setLabel(t("button.reset"))
                .setStyle(ButtonStyle.Danger),
        );
    }

    // Sends the member to SquadCalc already on this panel's server, so the
    // picks above and the app they open line up without anyone typing an id.
    buttons.push(
        new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel(t("button.open"))
            .setURL(squadcalcUrl(panel.serverId, config.mapType)),
    );

    rows.push(new ActionRowBuilder().addComponents(...buttons));
    return rows;
}

export function buildEmbed({ panel, status, state, label, t, layerChanged, error }) {
    const embed = new EmbedBuilder().setTimestamp();

    if (error) {
        return embed
            .setColor(COLOUR.error)
            .setTitle(t("panel.error", { server: label }))
            .setDescription(`${t("panel.errorBody")}\n\`\`\`${error}\`\`\``);
    }

    if (!status.live) {
        return embed
            .setColor(COLOUR.paused)
            .setTitle(t("panel.paused", { server: label }))
            .setDescription(`**${t(status.reasonKey)}**\n\n${t("panel.pausedBody")}`)
            .addFields({
                name: t("players"),
                value:
                    status.players != null ? `${status.players}/${status.maxPlayers}` : "—",
                inline: true,
            });
    }

    embed
        .setColor(COLOUR.live)
        .setTitle(`${label} — ${status.layer}`)
        .addFields(
            { name: t("teams"), value: `${status.team1} vs ${status.team2}`, inline: true },
            {
                name: t("players"),
                value: `${status.players}/${status.maxPlayers}`,
                inline: true,
            },
            {
                name: t("panel.matchTime"),
                value: t("panel.minutes", { n: status.playTimeMin }),
                inline: true,
            },
        );

    if (status.nextLayer) {
        embed.addFields({ name: t("panel.nextLayer"), value: status.nextLayer, inline: true });
    }

    // --- lane progress ----------------------------------------------------
    if (state) {
        const byKey = new Map(state.alive.map((f) => [f.key, f]));
        const walked = state.walk.map((k) => byKey.get(k)?.name ?? shortName(k)).join(" → ");
        const upcoming = state.nextFlags
            .map((f) => (f.percentage ? `${f.name} (${Math.round(f.percentage)}%)` : f.name))
            .join(", ");

        embed.addFields({
            name: t("panel.lane"),
            value: !hasLane(state.gamemode)
                ? t("panel.noLane", { mode: state.gamemode ?? "?" })
                : state.linear
                ? t("panel.fixedLane", { n: state.alive.length })
                : walked
                  ? `**${walked}**${upcoming ? "" : `  →  ${t("panel.laneEnd")}`}`
                  : t("panel.lanePrompt", { n: state.alive.length }),
            inline: false,
        });

        if (state.lanes?.total > 1) {
            embed.addFields({
                name: t("panel.routes"),
                value: `${state.lanes.alive}/${state.lanes.total}`,
                inline: true,
            });
        }

        // What can be the next objective is the question the panel exists to
        // answer, so it gets its own field instead of trailing the lane line.
        if (hasLane(state.gamemode) && !state.linear && upcoming) {
            embed.addFields({
                name: t("panel.nextFlag", { n: state.currentPosition }),
                value: `**${upcoming}**`,
                inline: false,
            });
        }
    }

    if (layerChanged && panel.picked.length === 0) {
        embed.setFooter({ text: t("panel.layerChanged") });
    }

    return embed;
}

/** Expands a lane walk to the node names the renderer expects. */
export async function currentState(panel) {
    if (!panel.layerName) return null;
    const layer = await fetchLayer(panel.layerName);
    return laneState(layer, panel.picked, panel.perspective, panel.layerName);
}

/** Validates a pick before trusting it: stale interactions can arrive late. */
export async function canPick(panel, key) {
    const state = await currentState(panel);
    return Boolean(state?.nextFlags.some((f) => f.key === key));
}
