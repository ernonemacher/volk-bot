/**
 * The usage guide in docs/guia/ as Discord messages, for `/volk guide` and for
 * pasting by hand.
 *
 * Each file opens with a `<!-- prints: ... -->` line naming its attachments in
 * docs/guia/prints/, then the text exactly as Discord shows it. Two
 * placeholders carry what differs between guilds, the panel channel and who
 * may operate it, so one copy of the text serves every guild. The index also
 * holds `{{01}}`..`{{05}}`, which only exist once the posts have been sent.
 *
 * Usage (prints one guild's posts, ready to paste):
 *   node src/guide.js <guildId>
 *   node src/guide.js <guildId> 04 | pbcopy
 */
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { rolesFor } from "./permissions.js";

const DIR = fileURLToPath(new URL("../docs/guia/", import.meta.url));
const HEADER = /^<!--\s*prints:(.*?)-->\s*/;

/** Discord refuses a message longer than this. */
const MAX_LENGTH = 2000;

function whoOperates(roleIds) {
    if (!roleIds.length) return "qualquer pessoa no canal.";
    const roles = roleIds.map((id) => `<@&${id}>`).join(" ou ");
    return `só quem tem o cargo ${roles}. Sem ele, o painel avisa que você não tem um cargo liberado.`;
}

/**
 * Every numbered post in order, index (`00`) included, filled in for one guild.
 * @returns {Promise<{id: string, name: string, text: string, files: string[]}[]>}
 */
export async function loadGuide(config) {
    const values = {
        painel: config.channelId ? `<#${config.channelId}>` : "o canal do painel",
        operadores: whoOperates(rolesFor(config, "operator")),
    };
    const names = (await readdir(DIR)).filter((n) => /^\d\d-.+\.md$/.test(n)).sort();

    return Promise.all(
        names.map(async (name) => {
            const raw = await readFile(`${DIR}${name}`, "utf8");
            const files = (raw.match(HEADER)?.[1] ?? "")
                .split(",")
                .map((s) => s.trim())
                .filter((s) => /\.(png|jpe?g)$/i.test(s))
                .map((s) => `${DIR}prints/${s}`);
            const text = raw
                .replace(HEADER, "")
                .trim()
                .replace(/\{\{(painel|operadores)\}\}/g, (_, key) => values[key]);

            // The index grows by one message link per post once they are sent.
            const room = name.startsWith("00") ? MAX_LENGTH - 5 * 100 : MAX_LENGTH;
            if (text.length > room) {
                throw new Error(`${name} has ${text.length} characters; Discord takes ${MAX_LENGTH}`);
            }
            return { id: name.slice(0, 2), name, text, files };
        }),
    );
}

/** Fills the index's `{{NN}}` with the links of the posts actually sent. */
export const linkIndex = (text, urls) => text.replace(/\{\{(\d\d)\}\}/g, (m, id) => urls[id] ?? m);

// --- direct run ------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    const [, , guildId, only] = process.argv;
    if (!guildId) {
        console.error("usage: node src/guide.js <guildId> [NN]");
        process.exit(1);
    }
    // Stdout carries only the text to paste: the store's own log lines and the
    // per-post header go to stderr.
    console.log = console.error;
    const { guildConfig } = await import("./store.js");
    const posts = await loadGuide(await guildConfig(guildId));

    for (const post of posts.filter((p) => !only || p.id === only)) {
        const prints = post.files.map((f) => f.split("/").pop()).join(", ") || "none";
        console.error(`--- ${post.name}  ${post.text.length} chars  prints: ${prints}`);
        process.stdout.write(`${post.text}\n\n`);
    }
}
