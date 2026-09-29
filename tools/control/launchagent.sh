#!/bin/bash
#
# Puts the supervisor and the menu bar indicator under launchd.
#
#   tools/control/launchagent.sh install     start at login, relaunch on a crash
#   tools/control/launchagent.sh uninstall   back to Volk.command only
#   tools/control/launchagent.sh status
#
# Without this, nothing came back after a reboot, and "off" was shown by the
# indicator not being there, which is the one signal nobody notices: 23 to 25/09
# passed with no bot and no sign of it.
#
# KeepAlive is SuccessfulExit=false for both: launchd relaunches a crash or a
# kill -9, but not an exit 0, so "Desligar tudo" and "Fechar este indicador"
# still mean off until the next login.

set -euo pipefail
cd "$(dirname "$0")/../.."

REPO="$(pwd)"
AGENTS="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
SUPERVISOR="app.volk.supervisor"
STATUS="app.volk.status"
STATUS_BIN="$REPO/tools/menubar/VolkStatus.app/Contents/MacOS/VolkStatus"
PORT="${VOLK_PANEL_PORT:-7317}"

loaded() { launchctl print "$DOMAIN/$1" >/dev/null 2>&1; }

# Same search as Volk.command. The absolute path goes into the plist because
# launchd starts agents with a minimal PATH that rarely includes node.
find_node() {
    command -v node 2>/dev/null && return
    for candidate in /usr/local/bin /opt/homebrew/bin "$HOME/.volta/bin"; do
        [ -x "$candidate/node" ] && echo "$candidate/node" && return
    done
    return 1
}

write_plist() { # label, then ProgramArguments
    local label="$1"; shift
    local args=""
    for a in "$@"; do args+="        <string>$a</string>"$'\n'; done
    cat > "$AGENTS/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>              <string>$label</string>
    <key>ProgramArguments</key>
    <array>
$args    </array>
    <key>WorkingDirectory</key>   <string>$REPO</string>
    <key>RunAtLoad</key>          <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key> <false/>
    </dict>
    <key>StandardOutPath</key>    <string>$REPO/logs/panel.log</string>
    <key>StandardErrorPath</key>  <string>$REPO/logs/panel.log</string>
</dict>
</plist>
PLIST
}

install() {
    local node
    node="$(find_node)" || { echo "Node não encontrado. Instale com: brew install node"; exit 1; }
    [ -d node_modules ] || { echo "Rode npm install antes."; exit 1; }

    # A supervisor started by hand would hold the port, and the agent would
    # then fail on EADDRINUSE and be relaunched in a loop.
    if ! loaded "$SUPERVISOR" && curl -fsS --max-time 1 "http://localhost:$PORT/health" >/dev/null 2>&1; then
        echo "Já há um supervisor no ar, iniciado fora do launchd."
        echo "Use \"Desligar tudo\" no painel e rode install de novo."
        exit 1
    fi

    mkdir -p "$AGENTS" logs
    write_plist "$SUPERVISOR" "$node" "$REPO/tools/control/server.js"
    loaded "$SUPERVISOR" && launchctl bootout "$DOMAIN/$SUPERVISOR" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$AGENTS/$SUPERVISOR.plist"
    echo "Supervisor instalado: sobe no login e volta se cair."

    if [ -x "$STATUS_BIN" ]; then
        # The copy started by Volk.command would sit beside the agent's and
        # draw a second icon.
        pkill -x VolkStatus 2>/dev/null || true
        write_plist "$STATUS" "$STATUS_BIN"
        loaded "$STATUS" && launchctl bootout "$DOMAIN/$STATUS" 2>/dev/null || true
        launchctl bootstrap "$DOMAIN" "$AGENTS/$STATUS.plist"
        echo "Indicador instalado."
    else
        echo "Indicador não compilado (tools/menubar/build.sh); instalado só o supervisor."
    fi
}

uninstall() {
    for label in "$STATUS" "$SUPERVISOR"; do
        loaded "$label" && launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
        rm -f "$AGENTS/$label.plist"
    done
    echo "Removido. O Volk agora só sobe pelo Volk.command."
}

status() {
    for label in "$SUPERVISOR" "$STATUS"; do
        if loaded "$label"; then
            launchctl print "$DOMAIN/$label" | awk -v l="$label" '/^\tstate =|^\tpid =/ {printf "%s %s\n", l, $0}'
        else
            echo "$label não instalado"
        fi
    done
}

case "${1:-}" in
    install) install ;;
    uninstall) uninstall ;;
    status) status ;;
    *) echo "uso: $0 install | uninstall | status"; exit 1 ;;
esac
