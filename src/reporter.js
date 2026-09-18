/**
 * Carries failures to a Discord channel, so a break is noticed before a member
 * reports it.
 *
 * Opt-in per guild through `/volk logchannel`. With no channel set nothing is
 * sent and the event still lands in the database: this is a notification path,
 * never the record.
 *
 * Deduplication is the whole design. An unstable upstream fails on every auto
 * refresh, which at the default interval is once a minute, and a channel that
 * fills with the same line stops being read long before the incident ends. The
 * first occurrence goes out immediately; repeats inside the window are counted
 * and published as one edited message.
 */

import { EmbedBuilder } from "discord.js";

import { guildConfig } from "./store.js";

/** How long repeats of the same failure fold into one message. */
const WINDOW_MS = 600000;

const COLOUR = 0xb22222;

/**
 * guild+scope+shape -> { count, messageId, channelId, firstAt, guildId }
 *
 * Keyed on the message *shape* rather than the message: a DiscordAPIError reads
 * `Unknown Message 1234567890123456789`, so keying on the raw text gives every
 * occurrence its own entry, and the folding this exists for never happens
 * precisely when the channel is filling up.
 */
const recent = new Map();

/** Ceiling on distinct failures tracked at once, so a pathological run is bounded. */
const MAX_TRACKED = 200;

/**
 * Collapses the parts of a message that change between identical failures:
 * snowflakes, other long numbers, and quoted values.
 */
const shapeOf = (message) =>
    String(message)
        .replace(/\d{5,}/g, "#")
        .slice(0, 200);

let client = null;

/** Wired on boot so `reportError` has a client without threading one through. */
export function startErrorReporter(discordClient) {
    client = discordClient;
    // Unref'd: a sweep pending must not hold the process open on shutdown.
    setInterval(sweep, WINDOW_MS).unref();
}

/** Forgets entries past the window, so a later failure reports fresh. */
function sweep() {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [key, entry] of recent) {
        if (entry.firstAt < cutoff) recent.delete(key);
    }
}

const body = (scope, message, count, guildId) =>
    new EmbedBuilder()
        .setColor(COLOUR)
        .setTitle(`Falha em \`${scope}\``)
        .setDescription(`\`\`\`${String(message).slice(0, 1000)}\`\`\``)
        .addFields(
            { name: "Guild", value: guildId ?? "—", inline: true },
            { name: "Ocorrências", value: String(count), inline: true },
        )
        .setTimestamp();

/**
 * Sends a failure to the guild's log channel, or folds it into the message
 * already there.
 *
 * Never throws and never awaits on the caller's path: an error in the error
 * reporter must not replace the error being reported.
 *
 * @param {import("discord.js").Client} discordClient
 * @param {string} guildId
 * @param {string} scope  what was attempted: refresh, render, command
 * @param {Error}  error
 */
export function reportError(discordClient, guildId, scope, error) {
    const c = discordClient ?? client;
    if (!c || !guildId) return;

    deliver(c, guildId, scope, error).catch(() => {
        // Reporting is best effort by definition. The event is already in the
        // database, which is the durable record.
    });
}

async function deliver(c, guildId, scope, error) {
    const config = await guildConfig(guildId);
    if (!config.logChannelId) return;

    const message = error?.message ?? String(error);
    const key = `${guildId}|${scope}|${shapeOf(message)}`;
    const now = Date.now();
    const seen = recent.get(key);

    if (seen && now - seen.firstAt < WINDOW_MS) {
        seen.count += 1;
        // Edit in place rather than post again: the count is the useful signal,
        // and a channel of identical lines is one nobody reads.
        try {
            const channel = await c.channels.fetch(seen.channelId);
            const posted = await channel.messages.fetch(seen.messageId);
            await posted.edit({ embeds: [body(scope, message, seen.count, guildId)] });
        } catch {
            // The message was deleted, or the channel moved. Drop the entry so
            // the next occurrence starts a fresh one.
            recent.delete(key);
        }
        return;
    }

    // `channels.fetch` resolves to null for an id it cannot turn into a channel
    // rather than throwing, and the configured channel can become a category or
    // be deleted after `/volk logchannel` validated it. Without this guard the
    // send throws, the entry is never recorded, and every later occurrence
    // retries the fetch instead of folding: the dedup fails exactly when an
    // unstable upstream is filling the channel.
    const channel = await c.channels.fetch(config.logChannelId).catch(() => null);
    if (!channel?.isTextBased?.()) return;

    const sent = await channel.send({ embeds: [body(scope, message, 1, guildId)] });

    // Bounded: a run of failures whose shapes still differ must not grow this
    // map without limit between sweeps. Oldest first, since it is insertion
    // ordered and the old entries are the ones about to be swept anyway.
    if (recent.size >= MAX_TRACKED) {
        recent.delete(recent.keys().next().value);
    }
    recent.set(key, {
        count: 1,
        messageId: sent.id,
        channelId: channel.id,
        firstAt: now,
        guildId,
    });
}
