//
//  The menu bar answer to "is Volk in the air?".
//
//  The supervisor now runs detached with no terminal window, which removed the
//  only always-visible sign that it was alive, and that sign was lying anyway,
//  since the window stayed open and idle-looking after the panel had stopped
//  answering on localhost. This replaces it with something that reports the
//  fact rather than the presence of a window: it polls GET /health and colours
//  a menu bar item from the reply.
//
//  Four states, deliberately distinguished, because they call for different
//  actions:
//
//    green   the supervisor answers and the bot is running
//    blue    the bot is fine, but every watched server is offline or seeding:
//            nothing is wrong, the Discord panel just has no match to show
//    yellow  the supervisor answers, the bot is not running (or a guild is
//            failing): open the page and press Ligar
//    red     no reply at all: the supervisor is down, run Volk.command
//
//  An agent (LSUIElement) with no Dock icon and no window: quitting it stops
//  the indicator and nothing else, which is the honest relationship between a
//  status light and the thing it watches.
//
//  Built by tools/menubar/build.sh into VolkStatus.app.
//

import AppKit
import Foundation

let port = ProcessInfo.processInfo.environment["VOLK_PANEL_PORT"] ?? "7317"
let panelURL = "http://localhost:\(port)"

/// Where the repo is, so the helper can launch `Volk.command`.
///
/// Passed in at build time: the .app is inside the repo, but reading its own
/// bundle path breaks the moment someone moves the app, and the whole point of
/// the "Ligar" item is to work when nothing else is running.
let repoRoot = ProcessInfo.processInfo.environment["VOLK_REPO"]
    ?? Bundle.main.object(forInfoDictionaryKey: "VolkRepoRoot") as? String
    ?? NSHomeDirectory()

struct Health {
    var botRunning = false
    var botTag: String?
    var guilds = 0
    var failing = 0
    var offline = 0
    var panelPid = 0
    var bootedAt: Double = 0
}

enum State {
    case up(Health)      // supervisor answers, bot running
    case idle(Health)    // bot running, every watched server offline
    case degraded(Health) // supervisor answers, bot down or guilds failing
    case down            // no reply
}

final class Indicator: NSObject, NSApplicationDelegate {
    private var item: NSStatusItem!
    private var timer: Timer?
    private var state: State = .down

    func applicationDidFinishLaunching(_ note: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        // Keeps a position chosen with Cmd+drag across launches. A new item
        // lands leftmost, which on a notched screen is behind the notch.
        item.autosaveName = "app.volk.status"
        item.menu = NSMenu()
        render()

        // Every 5 seconds: frequent enough that the light is not stale when you
        // glance at it, cheap enough to ignore: /health touches no database
        // and no disk.
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.poll()
        }
        poll()
    }

    // MARK: - polling

    private func poll() {
        guard let url = URL(string: "\(panelURL)/health") else { return }
        var req = URLRequest(url: url)
        // Short: a supervisor that cannot answer in two seconds is not
        // something a status light should sit and wait for.
        req.timeoutInterval = 2
        req.cachePolicy = .reloadIgnoringLocalCacheData

        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            let next = Self.parse(data)
            DispatchQueue.main.async {
                self?.state = next
                self?.render()
            }
        }.resume()
    }

    private static func parse(_ data: Data?) -> State {
        guard let data,
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let bot = root["bot"] as? [String: Any]
        else { return .down }

        var h = Health()
        h.botRunning = bot["running"] as? Bool ?? false
        h.botTag = bot["tag"] as? String
        h.guilds = bot["guilds"] as? Int ?? 0
        h.failing = bot["failing"] as? Int ?? 0
        h.offline = bot["offline"] as? Int ?? 0
        if let panel = root["panel"] as? [String: Any] {
            h.panelPid = panel["pid"] as? Int ?? 0
            h.bootedAt = panel["bootedAt"] as? Double ?? 0
        }

        // A running bot with every guild failing is not "up": it holds the
        // gateway and refreshes nothing, which looks fine from Discord's side
        // and is the state worth a different colour.
        if h.botRunning && h.failing == 0 {
            return h.guilds > 0 && h.offline == h.guilds ? .idle(h) : .up(h)
        }
        if h.botRunning || h.panelPid > 0 { return .degraded(h) }
        return .down
    }

    // MARK: - drawing

    private func render() {
        guard let button = item.button else { return }

        let color: NSColor
        switch state {
        case .up:       color = .systemGreen
        case .idle:     color = .systemBlue
        case .degraded: color = .systemYellow
        case .down:     color = .systemRed
        }
        button.image = Self.icon(color)
        button.title = ""

        let menu = NSMenu()
        menu.addItem(headline())
        menu.addItem(.separator())

        switch state {
        case .up, .idle, .degraded:
            menu.addItem(action("Abrir painel", #selector(openPanel)))
            menu.addItem(action("Reiniciar bot", #selector(restartBot)))
            menu.addItem(.separator())
            menu.addItem(action("Desligar tudo", #selector(quitAll)))
        case .down:
            menu.addItem(action("Ligar (Volk.command)", #selector(launch)))
        }

        menu.addItem(.separator())
        menu.addItem(action("Ver log", #selector(openLog)))
        menu.addItem(action("Fechar este indicador", #selector(quitHelper)))
        item.menu = menu
    }

    /// The Volk logo with a status dot on its lower right corner.
    ///
    /// Replaces the "🟢 Volk" title: at ~60 pt it was the first item a full
    /// menu bar pushed behind the notch, and it vanished without a trace.
    private static let logo: NSImage? = Bundle.main
        .url(forResource: "icon-app-1024", withExtension: "png")
        .flatMap { NSImage(contentsOf: $0) }

    private static func icon(_ color: NSColor) -> NSImage {
        let image = NSImage(size: NSSize(width: 21, height: 18), flipped: false) { _ in
            // The PNG is a circle on a black square; clip so the corners do not show.
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(ovalIn: NSRect(x: 0.5, y: 0.5, width: 17, height: 17)).addClip()
            logo?.draw(in: NSRect(x: 0, y: 0, width: 18, height: 18))
            NSGraphicsContext.restoreGraphicsState()
            let dot = NSBezierPath(ovalIn: NSRect(x: 13, y: 0.5, width: 7.5, height: 7.5))
            color.setFill()
            dot.fill()
            // A dark rim so yellow and green still read on a light menu bar.
            NSColor.black.withAlphaComponent(0.55).setStroke()
            dot.lineWidth = 1
            dot.stroke()
            return true
        }
        image.isTemplate = false
        return image
    }

    private func headline() -> NSMenuItem {
        let text: String
        switch state {
        case .up(let h):
            let who = h.botTag ?? "conectando…"
            text = "No ar: \(who) · \(h.guilds) guild(s)"
        case .idle(let h):
            text = "Bot no ar, servidor offline em \(h.offline) guild(s)"
        case .degraded(let h):
            if !h.botRunning {
                text = "Supervisor no ar, bot desligado"
            } else {
                text = "Bot no ar, \(h.failing) guild(s) com falha"
            }
        case .down:
            text = "Fora do ar"
        }
        let mi = NSMenuItem(title: text, action: nil, keyEquivalent: "")
        mi.isEnabled = false
        return mi
    }

    private func action(_ title: String, _ sel: Selector) -> NSMenuItem {
        let mi = NSMenuItem(title: title, action: sel, keyEquivalent: "")
        mi.target = self
        return mi
    }

    // MARK: - menu actions

    @objc private func openPanel() {
        if let url = URL(string: panelURL) { NSWorkspace.shared.open(url) }
    }

    @objc private func openLog() {
        let log = URL(fileURLWithPath: repoRoot).appendingPathComponent("logs/panel.log")
        // Console.app is the wrong tool for a plain text file; reveal it so the
        // user opens it with whatever they actually read logs in.
        NSWorkspace.shared.selectFile(log.path, inFileViewerRootedAtPath: repoRoot)
    }

    @objc private func restartBot() { post("/restart") }

    @objc private func quitAll() {
        let alert = NSAlert()
        alert.messageText = "Desligar o Volk?"
        alert.informativeText = "O bot sai do ar e o supervisor encerra. Para voltar, use Volk.command."
        alert.addButton(withTitle: "Desligar")
        alert.addButton(withTitle: "Cancelar")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        post("/quit")
    }

    @objc private func launch() {
        let script = URL(fileURLWithPath: repoRoot).appendingPathComponent("Volk.command")
        NSWorkspace.shared.open(script)
    }

    @objc private func quitHelper() { NSApp.terminate(nil) }

    private func post(_ path: String) {
        guard let url = URL(string: panelURL + path) else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 15
        URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in
            // Repaint promptly rather than waiting out the poll interval, so
            // the light reflects what the click just did.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self?.poll() }
        }.resume()
    }
}

let app = NSApplication.shared
let delegate = Indicator()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
