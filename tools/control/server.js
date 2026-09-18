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
 * `Volk.command` now starts this **detached** and closes its terminal window,
 * so there is no window to read and no window to close: the page is the only
 * way in, and `/quit` the only way out. Three things follow, and each exists
 * because the terminal used to provide it for free:
 *
 *  - the log goes to `logs/panel.log` as well as to stdout, because stdout now
 *    has nobody watching it;
 *  - a pidfile says which supervisor is the live one, so a second launch can
 *    tell "already running" from "stale port";
 *  - `/health` answers in one cheap request, for the menu bar helper and for a
 *    curl when the page itself is what looks broken.
 *
 * Loopback only, and no dependency beyond what the bot already installs: this
 * listens on a port with the Discord token in the child's environment, so it
 * must not be reachable from the network.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
    createWriteStream,
    mkdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { inspect } from "./inspect.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const PORT = Number(process.env.VOLK_PANEL_PORT ?? 7317);

const LOG_DIR = join(ROOT, "logs");
const LOG_FILE = join(LOG_DIR, "panel.log");
const PID_FILE = join(LOG_DIR, "panel.pid");
const BOOTED_AT = Date.now();

/**
 * The log on disk.
 *
 * Detached, this process has no terminal, so `console.log` goes to whatever
 * `Volk.command` redirected it to and nothing else. Everything the page shows
 * is also appended here, which is the only record that survives both the
 * browser being closed and this process dying.
 *
 * Append mode, and truncated at boot only past a size cap: a supervisor left up
 * for weeks should not fill the disk, but the tail of the previous run is
 * usually the thing you came looking for.
 */
const LOG_CAP = 4 * 1024 * 1024;
let logStream = null;

function openLog() {
    try {
        mkdirSync(LOG_DIR, { recursive: true });
        let flags = "a";
        try {
            if (statSync(LOG_FILE).size > LOG_CAP) flags = "w";
        } catch {
            // No previous log; append to a new one.
        }
        logStream = createWriteStream(LOG_FILE, { flags });
        logStream.on("error", () => {
            // A full or read-only disk must not take the supervisor down: the
            // page and stdout still work without the file.
            logStream = null;
        });
    } catch {
        logStream = null;
    }
}

const stamp = (at) => new Date(at).toISOString().slice(11, 23);

function toLog(entry) {
    if (!logStream) return;
    try {
        logStream.write(`${stamp(entry.at)} ${entry.stream} ${entry.line}\n`);
    } catch {
        logStream = null;
    }
}

/**
 * Who the live supervisor is.
 *
 * With no terminal window to look at, "is it already running?" has to be
 * answerable from outside. `Volk.command` reads this before launching, so a
 * second double-click reopens the page instead of racing for the port, and a
 * pidfile left by a process that died is recognised as stale rather than
 * believed.
 */
function claimPidFile() {
    try {
        mkdirSync(LOG_DIR, { recursive: true });
        writeFileSync(PID_FILE, `${process.pid}\n`);
    } catch {
        // Not fatal: the port check in Volk.command still catches a duplicate.
    }
}

function releasePidFile() {
    try {
        // Only if it is still ours. A newer supervisor may have claimed it,
        // and removing its file would make a live panel look absent.
        if (Number(readFileSync(PID_FILE, "utf8").trim()) === process.pid) {
            rmSync(PID_FILE, { force: true });
        }
    } catch {
        // Nothing to release.
    }
}

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

        // The supervisor's own events go to the terminal as well as to the
        // page. They used to exist only in this buffer and in whatever browser
        // happened to be watching, so a panel that broke while nobody had the
        // tab open left nothing at all behind to explain it. The child's own
        // output is not echoed: it is already on its way to this stdout.
        if (stream === "sys") console.log(line);

        const entry = { seq: seq++, at: now(), stream, line };
        lines.push(entry);
        while (lines.length > MAX_LINES) lines.shift();
        toLog(entry);

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
        env: {
            ...process.env,
            NODE_ENV: process.env.NODE_ENV ?? "development",
            // So the bot can notice if this supervisor is killed outright.
            // SIGKILL here runs none of the cleanup below, and an orphaned bot
            // keeps the gateway while the next launch starts a second one on
            // the same token. The bot watches this pid and exits with it.
            VOLK_SUPERVISOR_PID: String(process.pid),
        },
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
        // Resolve once, whichever path gets there first. The exit listener
        // alone was not enough: a child that had already gone never fires it
        // again, and `await stop()` in shutdown and restart then hung forever,
        // leaving the panel unable to restart the bot or quit.
        let settled = false;
        const done = (ok, why) => {
            if (settled) return;
            settled = true;
            clearTimeout(hard);
            clearTimeout(giveUp);
            resolve(why ? { ok, why } : { ok });
        };

        const hard = setTimeout(() => {
            if (dying.exitCode === null && dying.signalCode === null) {
                push("sys", "[panel] did not stop in time, forcing");
                dying.kill("SIGKILL");
            }
        }, 8000);

        // Even SIGKILL can leave us waiting if the process is unkillable (a
        // stuck syscall). Answering late is better than never answering.
        const giveUp = setTimeout(() => done(false, "did not exit"), 12000);

        dying.once("exit", () => done(true));
        dying.once("error", () => done(false, "error while stopping"));

        // Already gone between the check above and the signal.
        if (dying.exitCode !== null || dying.signalCode !== null) done(true);
    });
}

async function restart() {
    if (child) await stop();
    return start();
}

// --- http ------------------------------------------------------------------

/**
 * Writes one SSE frame, dropping the subscriber if the socket has gone.
 *
 * A browser tab that closes leaves a response whose socket is already dead, and
 * the write that follows raises ECONNRESET. Unguarded that escapes as an
 * unhandled error, which in Node 20 takes the whole supervisor down — the panel
 * going quiet with its terminal still open.
 */
function send(res, event, data) {
    try {
        if (res.writableEnded || res.destroyed) {
            clients.delete(res);
            return;
        }
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
        clients.delete(res);
    }
}

const json = (res, body, status = 200) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
};

/**
 * Every request runs inside this, because the handler is async: a rejected
 * promise in it (an unreadable panel.html, a database read racing a
 * checkpoint) becomes an unhandledRejection, and Node 20 exits the process on
 * those by default. The supervisor must outlive anything a single request can
 * do to it — its whole job is to still be there when something went wrong.
 */
const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
        push("sys", `[panel] request failed: ${e.message}`);
        try {
            if (!res.headersSent) res.writeHead(500);
            res.end("internal error");
        } catch {
            // The socket is already gone; nothing left to answer on.
        }
    });
});

async function handle(req, res) {
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
        // Both ends: `close` fires when the socket goes, `error` when it goes
        // badly, and a subscriber left in the set is written to forever.
        req.on("close", () => clients.delete(res));
        req.on("error", () => clients.delete(res));
        res.on("error", () => clients.delete(res));
        return;
    }

    /**
     * One cheap request that answers "is it up?" without opening the page.
     *
     * The menu bar helper polls this every few seconds, so it touches nothing
     * expensive: no database, no filesystem, just what is already in memory.
     * It is also what to curl when the page is the thing that looks broken:
     * a reply here with `listening: true` means the socket is fine and the
     * problem is in the browser.
     */
    if (url.pathname === "/health") {
        const snap = snapshot();
        return json(res, {
            ok: true,
            panel: { pid: process.pid, bootedAt: BOOTED_AT, listening: server.listening },
            bot: {
                running: snap.running,
                pid: snap.pid,
                startedAt: snap.startedAt,
                tag: snap.tag,
                errors: snap.errors,
                guilds: snap.guilds.length,
                failing: snap.guilds.filter((g) => g.state !== "ok").length,
                lastExit: snap.lastExit,
            },
        });
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
        // The only way out now that there is no terminal window to close.
        if (url.pathname === "/quit") {
            json(res, { ok: true });
            push("sys", "[panel] quit requested from the page");
            await stop();
            releasePidFile();

            /**
             * `server.close()` is not enough on its own, and relying on it left
             * the supervisor in a limbo worse than the bug this replaces: the
             * bot stopped, the page said "Desligado", and the process stayed up
             * holding the port, so the next `Volk.command` found it busy.
             *
             * Two reasons. It only stops *new* connections and then waits for
             * open ones, and every watching page holds an `/events` stream that
             * is designed never to end. And a keep-alive socket that is already
             * established still gets answered, so even `/health` replied on it.
             *
             * So: end the streams ourselves, then close, then exit on a timer
             * regardless. Quitting must not be able to fail.
             */
            for (const stream of clients) {
                try {
                    stream.end();
                } catch {
                    // Already gone; nothing to close.
                }
            }
            clients.clear();

            server.closeIdleConnections?.();
            server.close(() => process.exit(0));
            // Last resort, if a socket still refuses to go.
            setTimeout(() => process.exit(0), 1500).unref();
            return;
        }
    }

    res.writeHead(404).end("not found");
}

/**
 * A comment frame down every open stream, every 20 seconds.
 *
 * An idle SSE connection carries no traffic at all, and a browser that has
 * suspended a background tab, or anything between it and here, can drop it
 * without either side noticing. The page then looks alive and simply stops
 * updating — the failure being fixed. A heartbeat both keeps the connection
 * warm and lets the browser's EventSource notice a dead one and reconnect.
 */
setInterval(() => {
    for (const res of clients) {
        try {
            if (res.writableEnded || res.destroyed) clients.delete(res);
            else res.write(": ping\n\n");
        } catch {
            clients.delete(res);
        }
    }
}, 20000).unref();

openLog();

// Loopback only. The child's environment holds the Discord token, and the panel
// can start and stop it, so this must never answer the network.
server.listen(PORT, "127.0.0.1", () => {
    claimPidFile();
    push("sys", `[panel] supervisor up, pid ${process.pid}, port ${PORT}`);
    console.log(`Volk control panel: http://localhost:${PORT}`);
    if (process.env.VOLK_AUTOSTART !== "0") start();
});

/**
 * Watchdog on the listening socket.
 *
 * This is the failure that prompted the whole change: the page stopped
 * answering while the process was still alive, so there was nothing to
 * restart and nothing to read. Only `EADDRINUSE` exits below; every other
 * socket error is logged and carried on from, which can leave this process
 * running with no listener at all: alive, and unreachable.
 *
 * Rather than guess which errors those are, this checks the observable fact
 * every 15 seconds and listens again if the socket has gone. Re-listening on
 * a healthy server is a no-op we never reach, since `server.listening` is the
 * guard.
 */
setInterval(() => {
    if (server.listening) return;
    push("sys", "[panel] listener is gone, reopening");
    try {
        server.listen(PORT, "127.0.0.1");
    } catch (e) {
        push("sys", `[panel] could not reopen: ${e.message}`);
    }
}, 15000).unref();

server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
        console.error(
            `Port ${PORT} is busy: the panel may already be open at http://localhost:${PORT}`,
        );
        process.exit(1);
    }
    // Reported, not rethrown: a throw here is an uncaught exception, and the
    // supervisor dying is worse than any error a listening socket can report.
    console.error(`[panel] server error: ${e.message}`);
});

// Individual sockets raise their own errors — a browser tab closing mid-write
// is the ordinary case — and an unhandled one of those ends the process.
server.on("clientError", (e, socket) => {
    socket.destroy();
});

/**
 * Last line of defence. The panel exists to still be running when something
 * else broke, so it says what happened and carries on rather than exiting on a
 * fault in one request or one dead socket.
 *
 * Deliberately not a blanket "ignore everything": each of these is logged where
 * the terminal and the page can both see it, which is what was missing when the
 * panel went quiet and left nothing behind to explain it.
 */
process.on("uncaughtException", (e) => {
    console.error(`[panel] uncaught: ${e.stack ?? e.message}`);
    push("sys", `[panel] uncaught: ${e.message}`);
});
process.on("unhandledRejection", (e) => {
    console.error(`[panel] unhandled rejection: ${e?.stack ?? e}`);
    push("sys", `[panel] unhandled rejection: ${e?.message ?? e}`);
});

// If the supervisor ever does go down, say so on the way out. Its absence was
// the only symptom before: the page simply stopped updating.
process.on("exit", (code) => {
    // A pidfile outliving its process would make `Volk.command` think a dead
    // supervisor is live and refuse to start one.
    releasePidFile();
    if (code !== 0) console.error(`[panel] supervisor exiting with code ${code}`);
});

/** Quitting the supervisor takes the bot with it: a bot left holding the
 *  gateway with nothing watching it is the exact situation this replaces. */
async function shutdown() {
    push("sys", "[panel] shutting down");
    await stop();
    releasePidFile();
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
