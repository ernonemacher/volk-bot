#!/bin/bash
#
# Double-click target: puts the bot in the air and gets out of the way.
#
# This used to *be* the supervisor: the terminal window macOS opened for it ran
# the panel in the foreground, and closing the window stopped the bot. That
# coupling cost more than it bought. The window stayed open and busy-looking
# after the panel had stopped answering on localhost, so the one thing it was
# supposed to tell you (whether the service is up) was exactly what it got
# wrong.
#
# So the supervisor is now started detached, with its output redirected to
# logs/panel.log, and this window closes itself. Nothing is left running in the
# terminal, and the two honest signals are the menu bar item and the page.
# With Volk.app installed (tools/menubar/build.sh) both are the app, and this
# script is the fallback for a machine without it.
# Shutting down is the "Desligar tudo" button on the page (or tools/control/volkctl stop).

cd "$(dirname "$0")" || exit 1

PORT="${VOLK_PANEL_PORT:-7317}"
URL="http://localhost:${PORT}"
LOG_DIR="logs"
LOG_FILE="${LOG_DIR}/panel.log"
PID_FILE="${LOG_DIR}/panel.pid"

# Closes this Terminal window on the way out. Guarded on actually running under
# Terminal.app: run from an IDE or another emulator, the AppleScript would fail
# noisily or close the wrong thing.
close_window() {
    if [ "$TERM_PROGRAM" = "Apple_Terminal" ]; then
        osascript -e 'tell application "Terminal" to close (every window whose frontmost is true)' \
            >/dev/null 2>&1 &
    fi
}

# The app's window when it is installed, the browser otherwise.
APP="$HOME/Applications/Volk.app"
open_ui() {
    if [ -d "$APP" ]; then open "$APP"; else open "$URL"; fi
}

fail() {
    echo "$1"
    echo
    read -r -p "Enter para fechar."
    exit 1
}

if [ ! -f .env ]; then
    fail "Falta o arquivo .env com DISCORD_TOKEN. Copie .env.example e preencha."
fi

# node lands in different places depending on how it was installed, and a
# double-clicked script gets a login shell that may not have the PATH the
# terminal does.
if ! command -v node >/dev/null 2>&1; then
    for candidate in /usr/local/bin /opt/homebrew/bin "$HOME/.volta/bin"; do
        [ -x "$candidate/node" ] && PATH="$candidate:$PATH" && break
    done
fi

command -v node >/dev/null 2>&1 || fail "Node não encontrado. Instale com: brew install node"

# Already up? Just show it. Without this, a second double-click would race for
# the port, lose, and exit, looking like a failure to start when in fact the
# service was fine all along. The pidfile is trusted only if that process still
# exists: one left behind by a supervisor that was killed says nothing.
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
    echo "Volk já está no ar (pid $(cat "$PID_FILE")). Abrindo o painel."
    open_ui
    close_window
    exit 0
fi

# An orphaned bot from a supervisor that was killed outright, rather than asked
# to stop. The bot notices this itself within a few seconds and exits, but this
# launcher can beat it to the punch, and starting a second bot on the same token
# means two clients editing the same two messages per guild. So wait for the
# orphan to go, and insist if it does not.
# Only processes running THIS checkout. `pgrep -f 'node src/bot.js'` matches a
# command line, and that line is relative: it would also match a bot started
# from another copy of the repo, or any unrelated project with a src/bot.js,
# and this function kills what it finds. So each candidate is confirmed by its
# working directory before being signalled.
HERE="$(pwd)"
orphan_pids() {
    local pid cwd
    for pid in $(pgrep -f '^[^ ]*node src/bot\.js$' 2>/dev/null); do
        cwd="$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | grep '^n' | sed 's/^n//')"
        [ "$cwd" = "$HERE" ] && echo "$pid"
    done
}

ORPHANS="$(orphan_pids)"
if [ -n "$ORPHANS" ]; then
    echo "Encontrei bot(s) órfão(s) de uma execução anterior: $(echo "$ORPHANS" | tr '\n' ' ')"
    echo "Encerrando antes de subir…"
    # shellcheck disable=SC2086
    kill -TERM $ORPHANS 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        sleep 0.5
        [ -z "$(orphan_pids)" ] && break
    done
    STILL="$(orphan_pids)"
    if [ -n "$STILL" ]; then
        # shellcheck disable=SC2086
        kill -9 $STILL 2>/dev/null || true
        sleep 1
    fi
fi

if [ ! -d node_modules ]; then
    echo "Instalando dependências (primeira execução)…"
    npm install || fail "npm install falhou."
fi

mkdir -p "$LOG_DIR"

# Detached, and with stdio pointed at the log: no controlling terminal means
# closing this window cannot signal it, and a redirect means its output has
# somewhere to go now that no window is reading it.
# Under launchd (tools/control/launchagent.sh), launchd owns the supervisor: a
# copy started here would fight it for the port.
DOMAIN="gui/$(id -u)"
if launchctl print "$DOMAIN/app.volk.supervisor" >/dev/null 2>&1; then
    launchctl kickstart "$DOMAIN/app.volk.supervisor"
    PANEL_PID=""
else
    nohup node tools/control/server.js >>"$LOG_FILE" 2>&1 &
    PANEL_PID=$!
    disown "$PANEL_PID" 2>/dev/null
fi

# Confirm it actually came up before claiming success and closing the window.
# Reporting "no ar" for a process that died on boot is the failure mode this
# whole change is meant to remove, so it is worth the two seconds.
for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.3
    if curl -fsS --max-time 1 "${URL}/health" >/dev/null 2>&1; then
        echo "Volk no ar: ${URL}"
        open_ui
        close_window
        exit 0
    fi
    [ -n "$PANEL_PID" ] && { kill -0 "$PANEL_PID" 2>/dev/null || break; }
done

echo "O supervisor não respondeu em ${URL}/health. Últimas linhas do log:"
echo
tail -n 20 "$LOG_FILE" 2>/dev/null
fail ""
