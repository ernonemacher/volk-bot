#!/bin/bash
#
# Builds VolkStatus.swift into VolkStatus.app.
#
# Not committed as a binary: it is compiled locally, from source, against
# whatever macOS SDK this machine has. Needs the Xcode command line tools
# (`xcode-select --install`), which is also what `git` needs, so in practice it
# is already there.
#
# The app is an LSUIElement: no Dock icon, no window, just the menu bar item.
# Nothing else depends on it: Volk.command opens it if it exists and carries on
# if it does not, so the service never hinges on this having been built.

set -euo pipefail
cd "$(dirname "$0")"

REPO="$(cd ../.. && pwd)"
APP="VolkStatus.app"
BIN="$APP/Contents/MacOS/VolkStatus"

command -v swiftc >/dev/null 2>&1 || {
    echo "swiftc não encontrado. Instale as ferramentas de linha de comando:"
    echo "  xcode-select --install"
    exit 1
}

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

# The repo path is baked in: the helper has to find Volk.command to offer
# "Ligar", and it cannot ask a supervisor that is not running where it lives.
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>            <string>VolkStatus</string>
    <key>CFBundleDisplayName</key>     <string>Volk Status</string>
    <key>CFBundleIdentifier</key>      <string>app.volk.status</string>
    <key>CFBundleVersion</key>         <string>1</string>
    <key>CFBundleShortVersionString</key> <string>1.0</string>
    <key>CFBundleExecutable</key>      <string>VolkStatus</string>
    <key>CFBundlePackageType</key>     <string>APPL</string>
    <key>LSMinimumSystemVersion</key>  <string>12.0</string>
    <key>LSUIElement</key>             <true/>
    <key>VolkRepoRoot</key>            <string>${REPO}</string>
</dict>
</plist>
PLIST

echo "Compilando…"
swiftc -O -framework AppKit -o "$BIN" VolkStatus.swift

# Ad-hoc signature. Unsigned, the binary still runs, but macOS re-prompts for
# network access on every rebuild and the item can be killed on first launch.
codesign --force --sign - "$APP" >/dev/null 2>&1 || echo "(aviso: codesign ad-hoc falhou; o app ainda roda)"

echo "Pronto: tools/menubar/$APP"
echo "Abra com: open tools/menubar/$APP"
