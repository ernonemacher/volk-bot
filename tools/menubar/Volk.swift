//
//  Volk.app: the menu bar answer to "is Volk in the air?", and the window to
//  drive it from.
//
//  The supervisor runs detached with no terminal window, which removed the only
//  always-visible sign that it was alive, and that sign was lying anyway, since
//  the window stayed open and idle-looking after the panel had stopped
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
//    red     no reply at all: the supervisor is down
//
//  Opened from Launchpad it also shows the control page in its own window, and
//  turns Volk on first if it is off: opening the app is asking for Volk. It
//  used to open a browser tab instead, a new one every time, lost among the
//  others. Started by launchd at login it only draws the menu bar item.
//
//  The Dock icon exists only while the window is open. Cmd+Q closes the window
//  and leaves the menu bar item: the item's absence was the signal nobody
//  noticed, so quitting it outright is kept to the explicit menu entry.
//
//  Built by tools/menubar/build.sh into ~/Applications/Volk.app.
//

import AppKit
import Foundation
import WebKit

// `Volk --supervisor <node> <server.js>`: the LaunchAgent starts the supervisor
// through this binary, which replaces itself with node on the same pid, so
// launchd still tracks it. Started as node directly, System Settings > Login
// Items listed it as "Node.js Foundation", the signer of the node binary, and it
// was switched off there as an unknown item. Through here it is listed as Volk.
if CommandLine.arguments.count >= 3, CommandLine.arguments[1] == "--supervisor" {
    let argv = CommandLine.arguments.dropFirst(2).map { strdup($0) } + [nil]
    execv(argv[0]!, argv)
    perror("execv")
    exit(1)
}

let port = ProcessInfo.processInfo.environment["VOLK_PANEL_PORT"] ?? "7317"
// 127.0.0.1, not localhost: the supervisor listens on IPv4 only, and localhost
// tried ::1 first, refused on every poll.
let panelURL = URL(string: "http://127.0.0.1:\(port)")!

/// Where the repo is, so the app can fall back to `Volk.command`.
///
/// Passed in at build time: the app lives in ~/Applications, far from the repo,
/// and the whole point of "Ligar" is to work when nothing else is running.
let repoRoot = ProcessInfo.processInfo.environment["VOLK_REPO"]
    ?? Bundle.main.object(forInfoDictionaryKey: "VolkRepoRoot") as? String
    ?? NSHomeDirectory()

/// Set by the LaunchAgent: a launch at login is for the menu bar, not a window.
let launchedInBackground = ProcessInfo.processInfo.environment["VOLK_BACKGROUND"] == "1"

let showNotification = Notification.Name("app.volk.show")
let supervisorJob = "gui/\(getuid())/app.volk.supervisor"

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

final class Volk: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate {
    private var item: NSStatusItem!
    private var timer: Timer?
    private var state: State = .down

    private var window: NSWindow?
    private var web: WKWebView?
    /// True while the window shows the "off" placeholder instead of the panel.
    private var showingPlaceholder = false

    func applicationDidFinishLaunching(_ note: Notification) {
        // One instance. launchd starts the binary directly at login, and a
        // Launchpad click may not find that copy; two would draw two items.
        let mine = Bundle.main.bundleIdentifier ?? ""
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: mine)
            .filter { $0.processIdentifier != getpid() }
        if !others.isEmpty {
            if !launchedInBackground {
                DistributedNotificationCenter.default().postNotificationName(
                    showNotification, object: nil, userInfo: nil, deliverImmediately: true)
            }
            exit(0)
        }
        DistributedNotificationCenter.default().addObserver(
            forName: showNotification, object: nil, queue: .main) { [weak self] _ in
            self?.openFromUser()
        }

        NSApp.mainMenu = mainMenu()

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

        if !launchedInBackground { openFromUser() }
    }

    /// Launchpad or Dock click on a copy that is already running.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openFromUser()
        return false
    }

    // MARK: - polling

    private func poll(then: ((State) -> Void)? = nil) {
        var req = URLRequest(url: panelURL.appendingPathComponent("health"))
        // Short: a supervisor that cannot answer in two seconds is not
        // something a status light should sit and wait for.
        req.timeoutInterval = 2
        req.cachePolicy = .reloadIgnoringLocalCacheData

        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            let next = Self.parse(data)
            DispatchQueue.main.async {
                guard let self else { return }
                self.state = next
                self.render()
                if case .down = next {} else if self.showingPlaceholder { self.loadPanel() }
                then?(next)
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

    // MARK: - menu bar

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
        menu.addItem(action("Abrir painel", #selector(openPanel)))

        switch state {
        case .up, .idle, .degraded:
            menu.addItem(action("Reiniciar bot", #selector(restartBot)))
            menu.addItem(.separator())
            menu.addItem(action("Desligar tudo", #selector(quitAll)))
        case .down:
            menu.addItem(action("Ligar", #selector(launch)))
        }

        menu.addItem(.separator())
        menu.addItem(action("Ver log", #selector(openLog)))
        menu.addItem(action("Fechar o Volk", #selector(quitHelper)))
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

    private func action(_ title: String, _ sel: Selector, key: String = "") -> NSMenuItem {
        let mi = NSMenuItem(title: title, action: sel, keyEquivalent: key)
        mi.target = self
        return mi
    }

    // MARK: - window

    /// Opening the app is asking for Volk: show the panel, and turn it on first
    /// if nothing answers.
    private func openFromUser() {
        showWindow()
        poll { [weak self] s in
            if case .down = s { self?.launch() }
        }
    }

    private func showWindow() {
        if window == nil {
            let w = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered, defer: false)
            w.title = "Volk"
            w.minSize = NSSize(width: 720, height: 480)
            w.isReleasedWhenClosed = false
            w.delegate = self
            w.center()
            w.setFrameAutosaveName("VolkPanel")

            let wv = WKWebView(frame: w.contentView!.bounds, configuration: WKWebViewConfiguration())
            wv.autoresizingMask = [.width, .height]
            wv.uiDelegate = self
            wv.navigationDelegate = self
            w.contentView = wv
            window = w
            web = wv
            loadPanel()
        }
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    private func loadPanel() {
        showingPlaceholder = false
        web?.load(URLRequest(url: panelURL, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    /// What the window shows while the supervisor does not answer, instead of
    /// WebKit's own error page. The poll swaps the panel back in once it does.
    private func showPlaceholder() {
        showingPlaceholder = true
        web?.loadHTMLString("""
            <html><body style="margin:0;height:100vh;display:grid;place-items:center;\
            background:#111;color:#ddd;font:15px -apple-system,system-ui">
            <div style="text-align:center"><div style="font-size:22px;margin-bottom:8px">\
            Volk fora do ar</div><div style="color:#888">tentando ligar… se não voltar, \
            veja logs/panel.log</div></div></body></html>
            """, baseURL: nil)
    }

    func windowWillClose(_ note: Notification) {
        // Dropped rather than hidden: the page holds an /events stream open,
        // and a closed window has no reason to keep it.
        web?.stopLoading()
        web = nil
        window = nil
        NSApp.setActivationPolicy(.accessory)
    }

    @objc private func closeWindow() { window?.performClose(nil) }
    @objc private func reloadPanel() { loadPanel() }

    private func mainMenu() -> NSMenu {
        let main = NSMenu()

        let app = NSMenu()
        app.addItem(NSMenuItem(title: "Sobre o Volk",
                               action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                               keyEquivalent: ""))
        app.addItem(.separator())
        app.addItem(NSMenuItem(title: "Ocultar o Volk", action: #selector(NSApplication.hide(_:)),
                               keyEquivalent: "h"))
        app.addItem(.separator())
        // Cmd+Q closes the window only; see the header for why.
        app.addItem(action("Fechar painel", #selector(closeWindow), key: "q"))
        main.addItem(submenu(app, "Volk"))

        // Without an Edit menu, Cmd+C does nothing in a web view.
        let edit = NSMenu(title: "Editar")
        edit.addItem(NSMenuItem(title: "Copiar", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        edit.addItem(NSMenuItem(title: "Colar", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        edit.addItem(NSMenuItem(title: "Selecionar tudo", action: #selector(NSText.selectAll(_:)),
                                keyEquivalent: "a"))
        main.addItem(submenu(edit, "Editar"))

        let view = NSMenu(title: "Janela")
        view.addItem(action("Recarregar", #selector(reloadPanel), key: "r"))
        view.addItem(NSMenuItem(title: "Fechar", action: #selector(NSWindow.performClose(_:)),
                                keyEquivalent: "w"))
        view.addItem(NSMenuItem(title: "Minimizar", action: #selector(NSWindow.performMiniaturize(_:)),
                                keyEquivalent: "m"))
        main.addItem(submenu(view, "Janela"))
        return main
    }

    private func submenu(_ menu: NSMenu, _ title: String) -> NSMenuItem {
        let mi = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        mi.submenu = menu
        return mi
    }

    // MARK: - web view

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        showPlaceholder()
    }

    /// The page's "Desligar tudo" asks through confirm(). WKWebView answers
    /// false to it unless this is implemented, so the button did nothing.
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancelar")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    /// Anything that is not the panel opens in the browser, not in this window.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, url.host != panelURL.host, url.scheme != "about" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // MARK: - menu actions

    @objc private func openPanel() { showWindow() }

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
        alert.informativeText = "O bot sai do ar e o supervisor encerra. Para voltar, abra o Volk de novo."
        alert.addButton(withTitle: "Desligar")
        alert.addButton(withTitle: "Cancelar")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        post("/quit")
    }

    /// Through launchd when the agent is installed, so the supervisor it starts
    /// is the one launchd keeps alive; Volk.command otherwise.
    @objc private func launch() {
        if run("/bin/launchctl", ["print", supervisorJob]) {
            _ = run("/bin/launchctl", ["kickstart", supervisorJob])
        } else {
            NSWorkspace.shared.open(URL(fileURLWithPath: repoRoot).appendingPathComponent("Volk.command"))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.poll() }
    }

    @objc private func quitHelper() { NSApp.terminate(nil) }

    @discardableResult
    private func run(_ path: String, _ args: [String]) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }

    private func post(_ path: String) {
        var req = URLRequest(url: panelURL.appendingPathComponent(String(path.dropFirst())))
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
let delegate = Volk()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
