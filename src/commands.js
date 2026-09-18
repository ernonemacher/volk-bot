/**
 * Slash commands for administering the panel.
 *
 * Deliberately usable from any channel: an admin should not have to clutter the
 * public panel channel to change a setting. Discord already hides the command
 * from members without "Manage Server" (`setDefaultMemberPermissions`), and the
 * handler checks again, because that default can be loosened per role in the
 * server's integration settings. See permissions.js for the two levels.
 */

import { MessageFlags, PermissionsBitField, SlashCommandBuilder } from "discord.js";

import { isValidLanguage, availableLanguages } from "./i18n.js";
import { LEVELS, grantRole, isAdmin, revokeRole, rolesFor } from "./permissions.js";
import { AUTO_MAX, AUTO_MIN, fetchServerState, listServers } from "./servers.js";
import { guildConfig, readDiscovery, saveDiscovery, saveGuild } from "./store.js";
import { RETENTION_DAYS, forget, track } from "./telemetry.js";
import { footprint, summary } from "./stats.js";

const COMMAND = new SlashCommandBuilder()
    .setName("volk")
    .setDescription("Administer the Volk panel")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((s) =>
        s.setName("setup").setDescription("Choose the channel this server's panel is published in")
            .addChannelOption((o) =>
                o.setName("channel").setDescription("Panel channel (default: the current one)"),
            ),
    )
    .addSubcommand((s) =>
        s.setName("config").setDescription("Show the current settings and the server list"),
    )
    .addSubcommand((s) =>
        s
            .setName("roles")
            .setDescription("Choose which roles configure the bot and which operate the panel")
            .addStringOption((o) =>
                o
                    .setName("action")
                    .setDescription("What to do")
                    .setRequired(true)
                    .addChoices(
                        { name: "list", value: "list" },
                        { name: "allow", value: "allow" },
                        { name: "remove", value: "remove" },
                    ),
            )
            .addStringOption((o) =>
                o
                    .setName("level")
                    .setDescription("admin configures the bot, operator only drives the panel")
                    .addChoices(
                        { name: "admin", value: "admin" },
                        { name: "operator", value: "operator" },
                    ),
            )
            .addRoleOption((o) => o.setName("role").setDescription("Role to allow or remove")),
    )
    .addSubcommand((s) =>
        s
            .setName("auto")
            .setDescription("Automatic panel refresh")
            .addBooleanOption((o) =>
                o.setName("active").setDescription("true starts the cycle").setRequired(true),
            )
            .addIntegerOption((o) =>
                o
                    .setName("interval")
                    .setDescription(`Seconds between refreshes (${AUTO_MIN} to ${AUTO_MAX}, default 60)`)
                    .setMinValue(AUTO_MIN)
                    .setMaxValue(AUTO_MAX),
            ),
    )
    .addSubcommand((s) =>
        s
            .setName("language")
            .setDescription("Panel language")
            .addStringOption((o) =>
                o
                    .setName("code")
                    .setDescription("Language code")
                    .setRequired(true)
                    .addChoices(...availableLanguages().map((l) => ({ name: l, value: l }))),
            ),
    )
    .addSubcommand((s) =>
        s
            .setName("pin")
            .setDescription("Pin a server to the list, shown even while it is offline")
            .addStringOption((o) =>
                o.setName("id").setDescription("BattleMetrics server id").setRequired(true),
            )
            .addStringOption((o) =>
                o.setName("label").setDescription("How it reads in the menu (default: server name)"),
            ),
    )
    .addSubcommand((s) =>
        s
            .setName("unpin")
            .setDescription("Remove a pinned server from the list")
            .addStringOption((o) =>
                o.setName("id").setDescription("BattleMetrics server id").setRequired(true),
            ),
    )
    .addSubcommand((s) =>
        s
            .setName("discovery")
            .setDescription("Turn automatically discovered servers on or off")
            .addBooleanOption((o) =>
                o
                    .setName("active")
                    .setDescription("false leaves only the pinned ones")
                    .setRequired(true),
            )
            .addIntegerOption((o) =>
                o
                    .setName("min-players")
                    .setDescription("Only list servers with at least N players (default 50)")
                    .setMinValue(0)
                    .setMaxValue(100),
            )
            .addIntegerOption((o) =>
                o
                    .setName("count")
                    .setDescription("How many discovered servers enter the list (default 8)")
                    .setMinValue(0)
                    .setMaxValue(23),
            ),
    )
    .addSubcommand((s) =>
        s
            .setName("search")
            .setDescription("Find a server id by name")
            .addStringOption((o) =>
                o.setName("name").setDescription("Part of the server name").setRequired(true),
            ),
    )
    .addSubcommand((s) =>
        s
            .setName("republish")
            .setDescription("Delete and post the panel again, for when it is wedged or deleted"),
    )
    .addSubcommand((s) =>
        s
            .setName("stats")
            .setDescription("Usage and errors recorded by the bot")
            .addStringOption((o) =>
                o
                    .setName("period")
                    .setDescription("Window to report on (default 7d)")
                    .addChoices(
                        { name: "24h", value: "24h" },
                        { name: "7d", value: "7d" },
                        { name: "30d", value: "30d" },
                    ),
            )
            .addBooleanOption((o) =>
                o
                    .setName("global")
                    .setDescription("Every guild instead of only this one (default false)"),
            ),
    )
    .addSubcommand((s) =>
        s
            .setName("logchannel")
            .setDescription("Where failures are reported; leave empty to turn it off")
            .addChannelOption((o) =>
                o.setName("channel").setDescription("A private channel, not the panel one"),
            ),
    )
    .addSubcommand((s) =>
        s
            .setName("forget")
            .setDescription("Erase everything recorded about one member")
            .addUserOption((o) =>
                o.setName("user").setDescription("Member to erase").setRequired(true),
            ),
    );

/** Guild-scoped so it shows up immediately, instead of the global hour of lag. */
export async function registerCommands(client, guildId) {
    const guild = await client.guilds.fetch(guildId);
    await guild.commands.set([COMMAND.toJSON()]);
    console.log(`[BOT] commands registered in ${guild.name}`);
}

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

/**
 * What the bot still needs in a channel to run a panel there.
 *
 * Read history and manage messages are not optional extras: the panel is two
 * messages edited in place, which means fetching them every pass and deleting
 * leftovers on boot.
 */
const NEEDED = {
    ViewChannel: "View Channel",
    SendMessages: "Send Messages",
    EmbedLinks: "Embed Links",
    AttachFiles: "Attach Files",
    ReadMessageHistory: "Read Message History",
    ManageMessages: "Manage Messages",
};

function missingPermissions(i, channel) {
    const me = i.guild?.members?.me;
    if (!me) return [];
    const allowed = channel.permissionsFor(me);
    if (!allowed) return [];
    return Object.entries(NEEDED)
        .filter(([flag]) => !allowed.has(PermissionsBitField.Flags[flag]))
        .map(([, label]) => label);
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} i
 * @param {(guildId: string, opts?: {republish?: boolean}) => Promise<unknown>} repaint
 */
export async function handleCommand(i, repaint) {
    const cfg = await guildConfig(i.guildId);
    const save = () => saveGuild(i.guildId, cfg);
    const redraw = (opts) => repaint(i.guildId, opts);

    if (!isAdmin(i, cfg)) {
        return i.reply(
            ephemeral(
                "You need **Manage Server**, or a role allowed in `/volk roles`.",
            ),
        );
    }

    const sub = i.options.getSubcommand();

    // Which settings are actually used, and by whom. Recorded after the admin
    // check so a refused attempt does not read as configuration activity.
    track("command", { action: sub, guildId: i.guildId, userId: i.user.id });

    if (sub === "setup") {
        const channel = i.options.getChannel("channel") ?? i.channel;
        if (!channel?.isTextBased?.()) {
            return i.reply(ephemeral("Pick a text channel."));
        }

        // Checked before the channel is saved: a channel the bot cannot write
        // to fails silently at publish time, because the error panel has
        // nowhere to go either, and setup would still report success.
        const missing = missingPermissions(i, channel);
        if (missing.length) {
            return i.reply(
                ephemeral(
                    `I am missing **${missing.join("**, **")}** in <#${channel.id}>. ` +
                        "Grant those and run the command again.",
                ),
            );
        }

        cfg.channelId = channel.id;
        await save();
        await i.reply(ephemeral(`This server's panel goes to <#${channel.id}>. Publishing...`));
        await redraw();
        return i.editReply(`Panel published in <#${channel.id}>.`);
    }

    if (sub === "roles") {
        const action = i.options.getString("action");
        const level = i.options.getString("level");
        const role = i.options.getRole("role");

        if (action === "list") {
            const lines = LEVELS.map((lvl) => {
                const names = rolesFor(cfg, lvl)
                    .map((id) => `<@&${id}>`)
                    .join(", ");
                const label = lvl === "admin" ? "Configure the bot" : "Operate the panel";
                const fallback =
                    lvl === "admin" ? "only Manage Server" : "any member of the channel";
                return `**${label}:** ${names || `_${fallback}_`}`;
            });
            lines.push("", "_Manage Server always counts as admin._");
            return i.reply(ephemeral(lines.join("\n")));
        }

        if (!level || !role) {
            return i.reply(ephemeral("Pass `level` and `role` to allow or remove."));
        }

        const changed =
            action === "allow" ? grantRole(cfg, level, role.id) : revokeRole(cfg, level, role.id);
        if (!changed) {
            return i.reply(
                ephemeral(
                    action === "allow"
                        ? `<@&${role.id}> was already allowed as **${level}**.`
                        : `<@&${role.id}> was not in **${level}**.`,
                ),
            );
        }

        const what = level === "admin" ? "configure the bot" : "operate the panel";
        await save();
        return i.reply(
            ephemeral(
                action === "allow"
                    ? `<@&${role.id}> can now ${what}.`
                    : `<@&${role.id}> can no longer ${what}.`,
            ),
        );
    }

    if (sub === "republish") {
        await i.reply(ephemeral("Publishing the panel again..."));
        await redraw({ republish: true });
        return i.editReply("Panel republished.");
    }

    if (sub === "config") {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const options = await listServers(cfg);
        const discovery = await readDiscovery();
        const auto = cfg.auto ?? {};
        const lines = [
            `**Channel:** ${cfg.channelId ? `<#${cfg.channelId}>` : "_not set, run `/volk setup`_"}`,
            `**Auto refresh:** ${auto.active ? `on, every ${auto.intervalSeconds ?? 60}s` : "off (button only)"}`,
            `**Language:** ${cfg.language ?? "en"}`,
            `**Discovery:** ${discovery.active ? "on" : "off"}  ·  min ${discovery.minPlayers ?? 50} players  ·  up to ${discovery.count ?? 8} servers`,
            "",
            `**Pinned (${cfg.pinned.length}):**`,
            ...cfg.pinned.map((p) => `  \`${p.id}\`  ${p.label}`),
            "",
            `**In the menu right now (${options.length}):**`,
            ...options.map((o) => `  ${o.isPinned ? "★" : "·"} ${o.label} — ${o.description}`),
        ];
        return i.editReply(lines.join("\n").slice(0, 1900));
    }

    if (sub === "discovery") {
        // Global on purpose: "which servers are in a match right now" has the
        // same answer for every guild.
        const discovery = { ...(await readDiscovery()) };
        discovery.active = i.options.getBoolean("active");

        const min = i.options.getInteger("min-players");
        const count = i.options.getInteger("count");
        if (min !== null) discovery.minPlayers = min;
        if (count !== null) discovery.count = count;

        await saveDiscovery(discovery);
        await i.reply(
            ephemeral(
                `Discovery **${discovery.active ? "on" : "off"}** ` +
                    `(min ${discovery.minPlayers ?? 50} players, up to ${discovery.count ?? 8}). ` +
                    "Refreshing the panel...",
            ),
        );
        return redraw();
    }

    if (sub === "auto") {
        cfg.auto ??= {};
        cfg.auto.active = i.options.getBoolean("active");

        const interval = i.options.getInteger("interval");
        if (interval !== null) cfg.auto.intervalSeconds = interval;

        await save();
        await i.reply(
            ephemeral(
                cfg.auto.active
                    ? `Auto refresh **on**, every ${cfg.auto.intervalSeconds ?? 60}s.`
                    : "Auto refresh **off**. Button only.",
            ),
        );
        return redraw();
    }

    if (sub === "language") {
        const code = i.options.getString("code");
        if (!isValidLanguage(code)) {
            return i.reply(
                ephemeral(`Unknown language. Available: ${availableLanguages().join(", ")}`),
            );
        }
        cfg.language = code;
        await save();
        await i.reply(ephemeral(`Panel language: **${code}**. Refreshing...`));
        return redraw();
    }

    if (sub === "pin") {
        const id = i.options.getString("id").trim();

        if (cfg.pinned.some((p) => p.id === id)) {
            return i.reply(ephemeral(`\`${id}\` is already pinned.`));
        }

        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const state = await fetchServerState(id);
        if (!state.found) {
            return i.editReply(
                `No server \`${id}\` in the SquadCalc API. ` +
                    "Check the id, or look it up with `/volk search`.",
            );
        }

        const label =
            i.options.getString("label")?.trim() ||
            state.name.replace(/\s+/g, " ").trim().slice(0, 45);

        cfg.pinned.push({ id, label });
        await save();
        await i.editReply(`Pinned **${label}** (\`${id}\`). Refreshing the panel...`);
        return redraw();
    }

    if (sub === "unpin") {
        const id = i.options.getString("id").trim();
        const before = cfg.pinned.length;
        cfg.pinned = cfg.pinned.filter((p) => p.id !== id);

        if (cfg.pinned.length === before) {
            return i.reply(ephemeral(`\`${id}\` was not pinned.`));
        }

        await save();
        await i.reply(ephemeral(`Removed \`${id}\`. Refreshing the panel...`));
        return redraw();
    }

    if (sub === "stats") {
        await i.deferReply({ flags: MessageFlags.Ephemeral });

        const period = i.options.getString("period") ?? "7d";
        // Scoped to this guild unless asked otherwise: an admin of one guild
        // has no business reading another's activity by default.
        const guildId = i.options.getBoolean("global") ? null : i.guildId;
        const s = summary(period, guildId);
        const disk = footprint();

        if (!disk.events) {
            return i.editReply(
                "Nenhum evento registrado ainda. A telemetria grava a partir do próximo clique.",
            );
        }

        const list = (rows, format, empty = "_nada_") =>
            rows.length ? rows.map(format).join("\n") : empty;

        const lines = [
            `**Uso — ${period}${guildId ? "" : " · todas as guilds"}**`,
            "",
            `**Cliques:** ${s.clicks.reduce((sum, r) => sum + r.n, 0)}` +
                (s.denied ? `  ·  ${s.denied} recusado(s) por permissão` : ""),
            list(s.clicks, (r) => `  \`${r.action}\` ${r.n}`),
            "",
            `**Operadores distintos:** ${s.operators}`,
            list(s.topOperators, (r) => `  <@${r.user_id}> — ${r.n}`),
            "",
            "**Servidores mais usados:**",
            list(s.topServers, (r) => `  \`${r.server_id}\` — ${r.n}`),
            "",
            "**Layers mais vistos:**",
            list(s.topLayers, (r) => `  ${r.layer} — ${r.n}x`),
            "",
            `**Renders:** ${s.renders}` +
                (s.renderFailures ? `  ·  ${s.renderFailures} falharam` : "") +
                (s.latency
                    ? `\n  p50 ${s.latency.p50}ms  ·  p95 ${s.latency.p95}ms  ·  max ${s.latency.max}ms`
                    : ""),
            "",
            ...(s.unplayable.length
                ? [
                      "**Sem partida (offline/seeding):**",
                      list(s.unplayable, (r) => `  \`${r.server_id}\` ${r.state} — ${r.n}x`),
                      "",
                  ]
                : []),
            `**Erros:** ${s.errorTotal}`,
            list(s.errors, (r) => `  \`${r.scope}\` ${r.n}`, "  _nenhum_"),
            "",
            ...(guildId ? [] : [`**Guilds ativas:** ${s.activeGuildsGlobal}`, ""]),
            `_${disk.events} eventos armazenados · retenção de ${RETENTION_DAYS} dias_`,
        ];

        return i.editReply(lines.join("\n").slice(0, 1900));
    }

    if (sub === "logchannel") {
        const channel = i.options.getChannel("channel");

        if (!channel) {
            cfg.logChannelId = null;
            await save();
            return i.reply(ephemeral("Relato de falhas **desligado**."));
        }
        if (!channel.isTextBased?.()) {
            return i.reply(ephemeral("Escolha um canal de texto."));
        }

        // Same check as setup: a channel the bot cannot write to would swallow
        // every error report and still look configured.
        const missing = missingPermissions(i, channel);
        if (missing.length) {
            return i.reply(
                ephemeral(
                    `Faltam **${missing.join("**, **")}** em <#${channel.id}>. ` +
                        "Conceda e rode o comando de novo.",
                ),
            );
        }

        cfg.logChannelId = channel.id;
        await save();
        return i.reply(
            ephemeral(
                `Falhas vão para <#${channel.id}>. ` +
                    "Repetições da mesma falha são agrupadas numa janela de 10 minutos.",
            ),
        );
    }

    if (sub === "forget") {
        const user = i.options.getUser("user");
        const removed = forget(user.id);
        // Recorded without the erased id: the audit trail must not reintroduce
        // what the request was about removing.
        track("command", { action: "forget", guildId: i.guildId, userId: i.user.id, removed });
        return i.reply(
            ephemeral(
                removed
                    ? `Apagados ${removed} evento(s) de <@${user.id}>.`
                    : `Nada registrado sobre <@${user.id}>.`,
            ),
        );
    }

    if (sub === "search") {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const term = i.options.getString("name").toLowerCase();

        const { servers } = await fetch("https://squadcalc.app/api/get/servers", {
            signal: AbortSignal.timeout(15000),
        }).then((r) => r.json());

        const found = servers
            .filter((s) => s.attributes.name.toLowerCase().includes(term))
            .sort((a, b) => b.attributes.players - a.attributes.players)
            .slice(0, 10);

        if (!found.length) return i.editReply(`Nothing matching "${term}".`);

        const lines = found.map((s) => {
            const a = s.attributes;
            const state = s.mapName ? a.details.map : "seed or unrecognised layer";
            return `\`${s.id}\`  ${a.players}/${a.maxPlayers}  ${state}\n   ${a.name.slice(0, 60)}`;
        });
        return i.editReply(
            [`**${found.length} result(s):**`, ...lines, "", "Pin one with `/volk pin id:<id>`"]
                .join("\n")
                .slice(0, 1900),
        );
    }
}
