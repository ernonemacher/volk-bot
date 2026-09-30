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
# With Volk.app built, the supervisor starts through its binary (`Volk
# --supervisor`, which execs node), so System Settings > Login Items lists it as
# Volk. Started as node directly it was listed as "Node.js Foundation", the
# signer of node, and was switched off there as an unknown item, which makes
# launchd stop it on the spot. AssociatedBundleIdentifiers alone did not help:
# macOS honours it only for a Team ID the ad-hoc signed app does not have.
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
STATUS_BIN="$HOME/Applications/Volk.app/Contents/MacOS/Volk"
PORT="${VOLK_PANEL_PORT:-7317}"
STAGED="$(mktemp)"
trap 'rm -f "$STAGED"' EXIT

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

write_plist() { # file, label, env ("" or KEY=VALUE), then ProgramArguments
    local file="$1" label="$2" env="$3"; shift 3
    local args="" envxml=""
    for a in "$@"; do args+="        <string>$a</string>"$'\n'; done
    [ -n "$env" ] && envxml="    <key>EnvironmentVariables</key>
    <dict><key>${env%%=*}</key> <string>${env#*=}</string></dict>"
    cat > "$file" <<PLIST
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
$envxml
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
    if [ -x "$STATUS_BIN" ]; then
        write_plist "$STAGED" "$SUPERVISOR" "" "$STATUS_BIN" --supervisor "$node" "$REPO/tools/control/server.js"
    else
        write_plist "$STAGED" "$SUPERVISOR" "" "$node" "$REPO/tools/control/server.js"
    fi
    if place "$SUPERVISOR"; then
        echo "Supervisor instalado: sobe no login e volta se cair."
    else
        # Unchanged: rebooting it would take the bot off Discord for nothing.
        echo "Supervisor já instalado."
    fi

    if [ -x "$STATUS_BIN" ]; then
        # The helper this app replaced, if a copy is still running.
        pkill -x VolkStatus 2>/dev/null || true
        # VOLK_BACKGROUND: a launch at login draws the menu bar item, no window.
        write_plist "$STAGED" "$STATUS" "VOLK_BACKGROUND=1" "$STATUS_BIN"
        # Unchanged plist, but maybe a new build: restart onto it.
        place "$STATUS" || launchctl kickstart -k "$DOMAIN/$STATUS" >/dev/null
        echo "Volk.app instalado na barra de menus."
    else
        echo "Volk.app não compilado (tools/menubar/build.sh); instalado só o supervisor."
    fi
}

# Loads the plist staged in $STAGED as $1, unless the loaded one is identical.
# Returns 1 when there was nothing to change; a failed load exits.
place() {
    local target="$AGENTS/$1.plist"
    if loaded "$1" && cmp -s "$STAGED" "$target"; then return 1; fi
    if loaded "$1"; then
        launchctl bootout "$DOMAIN/$1" 2>/dev/null || true
        # bootout returns before the job is gone, and a bootstrap in that
        # window fails with "5: Input/output error". The supervisor can take
        # up to 12 s, since it stops the bot first.
        for _ in $(seq 1 40); do loaded "$1" || break; sleep 0.5; done
    fi
    mv "$STAGED" "$target"
    launchctl bootstrap "$DOMAIN" "$target" || { echo "Falha ao carregar $1 no launchd."; exit 1; }
}

uninstall() {
    for label in "$STATUS" "$SUPERVISOR"; do
        loaded "$label" && launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
        rm -f "$AGENTS/$label.plist"
    done
    echo "Removido. O Volk agora só sobe pelo Launchpad ou pelo Volk.command."
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
