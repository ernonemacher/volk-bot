#!/bin/bash
#
# Builds Volk.swift into ~/Applications/Volk.app, where Launchpad finds it.
#
# Not committed as a binary: it is compiled locally, from source, against
# whatever macOS SDK this machine has. Needs the Xcode command line tools
# (`xcode-select --install`), which is also what `git` needs, so in practice it
# is already there.
#
# The app is an LSUIElement that turns into a regular app while its window is
# open: menu bar item always, Dock icon only with the window. Nothing else
# depends on it: the supervisor and the bot run the same without it.

set -euo pipefail
cd "$(dirname "$0")"

REPO="$(cd ../.. && pwd)"
DEST="$HOME/Applications/Volk.app"
STAGE="$(mktemp -d)/Volk.app"
BIN="$STAGE/Contents/MacOS/Volk"
trap 'rm -rf "$(dirname "$STAGE")"' EXIT

command -v swiftc >/dev/null 2>&1 || {
    echo "swiftc não encontrado. Instale as ferramentas de linha de comando:"
    echo "  xcode-select --install"
    exit 1
}

mkdir -p "$STAGE/Contents/MacOS" "$STAGE/Contents/Resources"
cp ../../assets/icon-app-1024.png "$STAGE/Contents/Resources/"

echo "Gerando ícone…"
ICONSET="$(dirname "$STAGE")/Volk.iconset"
mkdir -p "$ICONSET"
swiftc -O -framework AppKit -o "$(dirname "$STAGE")/make-icon" make-icon.swift
"$(dirname "$STAGE")/make-icon" ../../assets/icon-app-1024.png "$ICONSET/icon_512x512@2x.png"
for size in 16 32 128 256 512; do
    sips -z $size $size "$ICONSET/icon_512x512@2x.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    [ $double -le 512 ] && sips -z $double $double "$ICONSET/icon_512x512@2x.png" \
        --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$STAGE/Contents/Resources/Volk.icns"

# The bundle id stays app.volk.status, from when this was only the menu bar
# helper: macOS keys the "allowed in the menu bar" setting and the saved item
# position on it, and a new id would reset both.
#
# The repo path is baked in: the app has to find Volk.command and the log, and
# it cannot ask a supervisor that is not running where it lives.
cat > "$STAGE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>            <string>Volk</string>
    <key>CFBundleDisplayName</key>     <string>Volk</string>
    <key>CFBundleIdentifier</key>      <string>app.volk.status</string>
    <key>CFBundleVersion</key>         <string>2</string>
    <key>CFBundleShortVersionString</key> <string>2.0</string>
    <key>CFBundleExecutable</key>      <string>Volk</string>
    <key>CFBundleIconFile</key>        <string>Volk</string>
    <key>CFBundlePackageType</key>     <string>APPL</string>
    <key>LSMinimumSystemVersion</key>  <string>12.0</string>
    <key>LSUIElement</key>             <true/>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key> <true/>
    </dict>
    <key>VolkRepoRoot</key>            <string>${REPO}</string>
</dict>
</plist>
PLIST

echo "Compilando…"
swiftc -O -framework AppKit -framework WebKit -o "$BIN" Volk.swift

# Ad-hoc signature. Unsigned, the binary still runs, but macOS re-prompts for
# network access on every rebuild and the item can be killed on first launch.
codesign --force --sign - "$STAGE" >/dev/null 2>&1 || echo "(aviso: codesign ad-hoc falhou; o app ainda roda)"

mkdir -p "$HOME/Applications"
rm -rf "$DEST"
mv "$STAGE" "$DEST"
# The helper this replaced, built inside the repo before the app existed.
rm -rf VolkStatus.app

# So Launchpad and Spotlight list it now rather than whenever they next scan.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "$DEST" >/dev/null 2>&1 || true

echo "Pronto: $DEST"

# Under launchd, point the login agent at the new build and restart it.
if launchctl print "gui/$(id -u)/app.volk.supervisor" >/dev/null 2>&1; then
    "$REPO/tools/control/launchagent.sh" install
else
    echo "Abra pelo Launchpad, ou rode tools/control/launchagent.sh install para subir no login."
fi
