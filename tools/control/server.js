/**
 * Local control panel for the bot: runs it as a child process and serves a
 * page to start, stop and watch it.
 *
 * This is the development counterpart to `deploy/volk.service`. A Mac has no
 * systemd, and the bot was being launched by hand from a terminal that then got
 * closed, which left an orphan holding the Discord gateway with its logs going
 * nowhere. Here the supervisor owns the process, so closing the browser leaves
 * the bot running and reopening the page shows the same state, while quitting
 * the supervisor takes the bot down with it.
 *
 * Loopback only, and no dependency beyond what the bot already installs: this
 * listens on a port with the Discord token in the child's environment, so it
 * must not be reachable from the network.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { inspect } from "./inspect.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const PORT = Number(process.env.VOLK_PANEL_PORT ?? 7317);

/** Ring buffer of log lines. Enough to explain a crash, bounded so a bot left
 *  running for days cannot grow it without limit. */
const MAX_LINES = 500;
const lines = [];
let seq = 0;

/** Live subscribers (SSE). Each is a response we push lines to. */
const clients = new Set();

let child = null;
let startedAt = null;
let lastExit = null;

/** What the log has told us about the bot's own state. */
const bot = { tag: null, guilds: new Map(), errors: 0 };

const now = () => Date.now();

function push(stream, text) {
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (!line) continue;

        const entry = { seq: seq++, at: now(), stream, line };
        lines.push(entry);
        while (lines.length > MAX_LINES) lines.shift();

        interpret(line, stream);
        for (const res of clients) send(res, "line", entry);
    }
    // State derived from the line may have changed, so repaint the header.
    for (const res of clients) send(res, "state", snapshot());
}

/**
 * Reads the bot's own log vocabulary to recover state it does not otherwise
 * expose. The bot has no status endpoint, and adding one would mean changing
 * the thing being supervised, so the panel parses what it already prints.
 */
function interpret(line, stream) {
    if (stream === "err" && /error|unhandled/i.test(line)) bot.errors++;

    let m = line.match(/\[BOT\] connected as (.+)$/);
    if (m) {
        bot.tag = m[1];
        bot.guilds.clear();
        return;
    }

    m = line.match(/\[BOT\] guild (\d+): panel on #(.+)$/);
    if (m) {
        bot.guilds.set(m[1], { id: m[1], channel: m[2], state: "ok" });
        return;
    }

    m = line.match(/\[BOT\] guild (\d+): no channel bound/);
    if (m) {
        bot.guilds.set(m[1], { id: m[1], channel: null, state: "unbound" });
        return;
    }

    m = line.match(/\[BOT\] guild (\d+): channel unreachable/);
    if (m) {
        bot.guilds.set(m[1], { id: m[1], channel: null, state: "unreachable" });
        return;
    }

    m = line.match(/\[BOT\] refresh failed for guild (\d+)/);
    if (m) {
        const g = bot.guilds.get(m[1]);
        if (g) g.state = "failing";
    }
}

const snapshot = () => ({
    running: Boolean(child),
    pid: child?.pid ?? null,
    startedAt,
    lastExit,
    tag: bot.tag,
    errors: bot.errors,
    guilds: [...bot.guilds.values()],
});

// --- process control -------------------------------------------------------

function start() {
    if (child) return { ok: false, why: "already running" };

    bot.tag = null;
    bot.guilds.clear();
    bot.errors = 0;
    lastExit = null;

    child = spawn(process.execPath, ["src/bot.js"], {
        cwd: ROOT,
        env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "development" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    startedAt = now();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => push("out", d));
    child.stderr.on("data", (d) => push("err", d));

    child.on("exit", (code, signal) => {
        lastExit = { code, signal, at: now() };
        child = null;
        startedAt = null;
        push("sys", `[panel] bot exited (${signal ?? `code ${code}`})`);
    });

    child.on("error", (e) => push("sys", `[panel] could not start: ${e.message}`));

    push("sys", `[panel] started, pid ${child.pid}`);
    return { ok: true };
}

/**
 * SIGTERM first: the bot handles it and closes the gateway cleanly, so Discord
 * sees it go offline instead of timing the session out. SIGKILL only if it is
 * still there after the grace period.
 */
function stop() {
    if (!child) return Promise.resolve({ ok: false, why: "not running" });

    const dying = child;
    push("sys", "[panel] stopping");
    dying.kill("SIGTERM");

    return new Promise((resolve) => {
        const hard = setTimeout(() => {
            if (!dying.killed) {
                push("sys", "[panel] did not stop in time, forcing");
                dying.kill("SIGKILL");
            }
        }, 8000);

        dying.once("exit", () => {
            clearTimeout(hard);
            resolve({ ok: true });
        });
    });
}

async function restart() {
    if (child) await stop();
    return start();
}

// --- http ------------------------------------------------------------------

function send(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const json = (res, body, status = 200) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === "/") {
        const html = await readFile(join(HERE, "panel.html"), "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(html);
    }

    // The brand assets, served from the repo rather than inlined: the banner
    // alone is 493KB, which would dwarf the page and be re-sent on every load.
    // Allow-listed by name because this serves files off disk.
    const ASSETS = {
        "/brand/icon.png": "icon-app-1024.png",
        "/brand/banner.png": "banner-1360x480.png",
    };
    if (ASSETS[url.pathname]) {
        try {
            const file = await readFile(join(ROOT, "assets", ASSETS[url.pathname]));
            res.writeHead(200, {
                "content-type": "image/png",
                "cache-control": "max-age=86400",
            });
            return res.end(file);
        } catch {
            return res.writeHead(404).end("not found");
        }
    }

    if (url.pathname === "/events") {
        res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
        });
        clients.add(res);
        send(res, "state", snapshot());
        // The backlog, so a page opened late still explains how we got here.
        for (const entry of lines) send(res, "line", entry);
        req.on("close", () => clients.delete(res));
        return;
    }

    // What the bot recorded, as opposed to what it printed. Polled by the page
    // rather than pushed on every line: these are aggregates over a day, and
    // recomputing them per log line would be wasteful and no fresher.
    if (url.pathname === "/inspect") {
        return json(res, inspect());
    }

    if (req.method === "POST") {
        if (url.pathname === "/start") return json(res, start());
        if (url.pathname === "/stop") return json(res, await stop());
        if (url.pathname === "/restart") return json(res, await restart());
        if (url.pathname === "/quit") {
            json(res, { ok: true });
            await stop();
            return server.close(() => process.exit(0));
        }
    }

    res.writeHead(404).end("not found");
});

// Loopback only. The child's environment holds the Discord token, and the panel
// can start and stop it, so this must never answer the network.
server.listen(PORT, "127.0.0.1", () => {
    console.log(`Volk control panel: http://localhost:${PORT}`);
    if (process.env.VOLK_AUTOSTART !== "0") start();
});

server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
        console.error(
            `Port ${PORT} is busy: the panel may already be open at http://localhost:${PORT}`,
        );
        process.exit(1);
    }
    throw e;
});

/** Quitting the supervisor takes the bot with it: a bot left holding the
 *  gateway with nothing watching it is the exact situation this replaces. */
async function shutdown() {
    await stop();
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
