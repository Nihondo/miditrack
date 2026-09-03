#!/usr/bin/swift
//
// このファイルはinstall.shが`xcrun swiftc -O`でコンパイルし、
// ~/Applications/miditrack.app/Contents/MacOS/miditrackへ直接配置する
// （Xcodeプロジェクトは使わない。シバン行はターミナルから
// `./miditrack_app.swift --self-test`のように直接実行する開発用の経路
// としてのみ機能する）。AppKitのイベントループが起動しウィンドウを表示した
// 後に、miditrackバックエンド（miditrack.sh --no-browser）を自分で
// Process()起動し、その標準出力（"miditrack Web UI: <URL>"行）を監視して
// WKWebViewでそのURLを開く。ウィンドウを閉じる/Cmd+Qでアプリが終了する際、
// バックエンドプロセスをSIGINTで道連れにする。
//
// なぜコンパイル済みバイナリとして配置するのか: このリポジトリは
// ~/Library/CloudStorage/Dropbox/...（TCC保護対象）配下にある。当初は
// Contents/MacOS/miditrackをこのファイルへのシンボリックリンクにしていたが、
// 実機で「sandboxd rejected approval request from swift for
// kTCCServiceFileProviderDomain (.../miditrack_app.swift): would require
// prompt」というログとともに、swiftインタプリタがこのソースファイル自体を
// 読み込もうとする最初の一歩から拒否されることを確認した。これは
// バックエンド起動のタイミングの問題ではなく、「execve()でDropbox配下の
// ファイルを新しいプロセスイメージとしてロードしようとする」という操作
// そのものがTCCにより無条件で拒否される、より根本的な制約だった
// （プロンプトを出す前提条件を満たせないための無条件拒否——ターミナルなど
// 既にDropboxへのアクセス許可を持つプロセス経由なら成功する）。実行可能
// ファイル自体をコンパイルして$HOME/Applications配下（TCC非対象）に置くと
// この問題は解消し、そこから先の子プロセスexec（Dropbox配下のminditrack.sh
// やその先のvenv Pythonをexecすること）は問題なく成功することも実機で
// 確認済み——TCCの制約は「トップレベルの実行可能ファイルの所在」にのみ
// 適用され、起動後の子プロセス生成には及ばない。詳細はmiditrack/CLAUDE.md
// を参照。バックエンド起動をapplicationDidFinishLaunching（ウィンドウ表示後）
// まで遅らせている設計は、この発見以前の対策として残しているが、実害はない
// ため維持している。
//
import Cocoa
import WebKit

// MARK: - A. 定数と自己位置解決

let launcherFileURL = URL(fileURLWithPath: #filePath).resolvingSymlinksInPath()
let packageDirectoryURL = launcherFileURL.deletingLastPathComponent()
let backendScriptURL = packageDirectoryURL.appendingPathComponent("miditrack.sh")
let applicationIconURL = packageDirectoryURL.deletingLastPathComponent()
    .appendingPathComponent("images/miditrack_icon.png")

let webUiLinePrefix = "miditrack Web UI: "
let serverStartupTimeoutSeconds: TimeInterval = 40
let backendTerminationGraceSeconds: TimeInterval = 3
let initialWindowSize = NSSize(width: 1280, height: 860)

// Finder/Dockが継承するPATHはlaunchdの既定（/usr/bin:/bin:/usr/sbin:/sbin）で
// /opt/homebrew/binを含まない。fluidsynth/ffmpeg/rubberband/nodeはすべて
// PATH解決なので、これが無いとレンダリングだけ全部失敗する。
// MIDITRACK_APP_PATHはテストが偽コマンドを差し込むためのシーム
// （MIDITRACK_PREFERENCES_PATH/MIDI2WAV_BINと同じ慣習）。
let defaultToolPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

// MARK: - B. 純粋関数（--self-test で検証可能）

/// run_server()が標準出力へ出す起動行からWeb UIのURLを取り出す。
/// 期待する形式は `miditrack Web UI: http://127.0.0.1:PORT/?token=...` の1行。
/// 127.0.0.1以外・http以外は拒否し、行の形式が将来変わっても意図しない
/// URLをWebViewへ渡さない。
func extractWebUiUrl(from line: String) -> URL? {
    guard line.hasPrefix(webUiLinePrefix) else { return nil }
    let urlString = String(line.dropFirst(webUiLinePrefix.count))
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: urlString) else { return nil }
    guard url.scheme == "http", url.host == "127.0.0.1" else { return nil }
    return url
}

/// ダウンロード保存先が既存ファイルと衝突しないよう " 2", " 3" を付ける。
func makeUniqueDestination(for url: URL) -> URL {
    let fileManager = FileManager.default
    guard fileManager.fileExists(atPath: url.path) else { return url }
    let baseName = url.deletingPathExtension().lastPathComponent
    let extensionName = url.pathExtension
    let directory = url.deletingLastPathComponent()
    var suffix = 2
    while true {
        let candidateName = extensionName.isEmpty
            ? "\(baseName) \(suffix)"
            : "\(baseName) \(suffix).\(extensionName)"
        let candidate = directory.appendingPathComponent(candidateName)
        if !fileManager.fileExists(atPath: candidate.path) { return candidate }
        suffix += 1
    }
}

func runSelfTest() {
    var failureCount = 0
    func check(_ condition: Bool, _ message: String) {
        if !condition {
            failureCount += 1
            FileHandle.standardError.write(Data("self-test failed: \(message)\n".utf8))
        }
    }

    check(
        extractWebUiUrl(from: "miditrack Web UI: http://127.0.0.1:54321/?token=abc")?.absoluteString
            == "http://127.0.0.1:54321/?token=abc",
        "extractWebUiUrl should parse a valid line"
    )
    check(extractWebUiUrl(from: "not a url line") == nil, "extractWebUiUrl should reject unrelated lines")
    check(
        extractWebUiUrl(from: "miditrack Web UI: http://evil.example/") == nil,
        "extractWebUiUrl should reject non-127.0.0.1 hosts"
    )
    check(
        extractWebUiUrl(from: "miditrack Web UI: https://127.0.0.1:1/") == nil,
        "extractWebUiUrl should reject non-http schemes"
    )

    if failureCount == 0 {
        print("self-test: OK")
    } else {
        print("self-test: \(failureCount) failure(s)")
        exit(1)
    }
}

// MARK: - C. ログ

let logFileURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/miditrack/miditrack-app.log")

/// ログディレクトリを用意し、このプロセス自身の起動を1行記録する。
/// バックエンドのstderrはbashスタブが直接同じファイルへ追記しているため、
/// ここでは自分の分だけ追記すればよい。
func prepareLogFile() {
    let directory = logFileURL.deletingLastPathComponent()
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    appendToLog("--- miditrack.app launcher started \(Date()) ---")
}

func appendToLog(_ text: String) {
    guard let data = (text + "\n").data(using: .utf8) else { return }
    if let handle = try? FileHandle(forWritingTo: logFileURL) {
        defer { try? handle.close() }
        handle.seekToEndOfFile()
        handle.write(data)
    } else {
        try? data.write(to: logFileURL)
    }
}

/// バックエンドの標準エラー出力をログファイルへ直結するためのFileHandleを返す。
/// 呼び出し元（BackendController）がProcess.standardErrorにそのまま渡す。
func openLogFileHandleForAppending() -> FileHandle? {
    if !FileManager.default.fileExists(atPath: logFileURL.path) {
        FileManager.default.createFile(atPath: logFileURL.path, contents: nil)
    }
    guard let handle = try? FileHandle(forWritingTo: logFileURL) else { return nil }
    handle.seekToEndOfFile()
    return handle
}

// MARK: - D. 行バッファ

/// readabilityHandler/ポーリングが渡すチャンクを行に組み直す。
/// 「miditrack Web UI: 」の行が1回の読み取りで途中までしか届かない
/// 可能性があるため、生チャンクへのprefix照合では取りこぼす。
final class LineAccumulator {
    private var buffer = Data()
    private let handleLine: (String) -> Void

    init(handleLine: @escaping (String) -> Void) {
        self.handleLine = handleLine
    }

    func consume(_ chunk: Data) {
        guard !chunk.isEmpty else { return }
        buffer.append(chunk)
        while let newlineIndex = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer[buffer.startIndex..<newlineIndex]
            if let line = String(data: lineData, encoding: .utf8) {
                handleLine(line)
            }
            buffer.removeSubrange(buffer.startIndex...newlineIndex)
        }
    }
}

// MARK: - E. BackendController（バックエンドの起動と監視）

/// miditrack.sh --no-browser を自分でProcess()起動し、標準出力から
/// "miditrack Web UI: <URL>"行を読み取って通知する。呼び出し側
/// （AppDelegate）は必ずAppKitのイベントループ開始後・ウィンドウ表示後に
/// start()を呼ぶこと — 起動直後のUI未確立なタイミングでDropbox配下の
/// ファイルにアクセスすると、TCCがプロンプトを出せず無言で拒否する
/// （"would require prompt"というサンドボックスログとともに実機で確認済み）。
final class BackendController {
    private let backendScriptURL: URL
    private let process = Process()
    private let outputPipe = Pipe()
    private lazy var lineAccumulator = LineAccumulator { [weak self] line in
        self?.handleOutputLine(line)
    }
    private var onReady: ((URL) -> Void)?
    private var onFailure: ((String) -> Void)?
    private var isUrlDelivered = false

    init(backendScriptURL: URL) {
        self.backendScriptURL = backendScriptURL
    }

    /// バックエンドを起動し、標準出力の監視を開始する。
    func start(onReady: @escaping (URL) -> Void, onFailure: @escaping (String) -> Void) {
        self.onReady = onReady
        self.onFailure = onFailure

        guard FileManager.default.isExecutableFile(atPath: backendScriptURL.path) else {
            onFailure("miditrackのインストール先が見つかりません: \(backendScriptURL.path)。install.shを再実行してください。")
            return
        }

        process.executableURL = backendScriptURL
        process.arguments = ["--no-browser"]
        process.environment = makeChildEnvironment()
        process.standardOutput = outputPipe
        process.standardError = openLogFileHandleForAppending()
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, !self.isUrlDelivered else { return }
                onFailure("バックエンドが起動中に終了しました。")
            }
        }

        outputPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            DispatchQueue.main.async {
                self?.lineAccumulator.consume(chunk)
            }
        }

        do {
            try process.run()
        } catch {
            onFailure("バックエンドを起動できませんでした: \(error.localizedDescription)")
        }
    }

    private func makeChildEnvironment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = environment["MIDITRACK_APP_PATH"] ?? defaultToolPath
        return environment
    }

    private func handleOutputLine(_ line: String) {
        guard !isUrlDelivered, let url = extractWebUiUrl(from: line) else { return }
        isUrlDelivered = true
        onReady?(url)
    }

    /// SIGINTを送り、猶予内に終わらなければSIGTERM→SIGKILLへ段階的に上げる。
    /// SIGTERM/SIGKILLだとrun_server()のfinally節（一時ディレクトリ削除）が
    /// 走らず/tmp/miditrack-*が残るため、SIGINTを第一手にする
    /// （ターミナルのCtrl-Cと同一経路）。Process()が直接子プロセスをexecする
    /// ため、bashの`&`ジョブ制御に起因するSIGINT無視の問題（以前の設計で
    /// 発見・対処が必要だった）はそもそも発生しない。
    func terminate() {
        outputPipe.fileHandleForReading.readabilityHandler = nil
        guard process.isRunning else { return }
        process.interrupt()
        let deadline = Date().addingTimeInterval(backendTerminationGraceSeconds)
        while Date() < deadline {
            if !process.isRunning { return }
            usleep(50_000)
        }
        process.terminate()
        usleep(500_000)
        if process.isRunning {
            kill(process.processIdentifier, SIGKILL)
        }
    }
}

// MARK: - F. WKWebViewデリゲート（WKWebViewの4つの穴を埋める）

/// 素のWKWebViewでは以下が無言で動かなくなる。ブラウザなら自動なので
/// 見落としやすい: ダウンロード、<input type="file">、window.confirm()、
/// target="_blank"を同一ウィンドウで開くこと。
final class MiditrackWebDelegate: NSObject, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate {
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.begin { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "キャンセル")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
        completionHandler()
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        if let url = navigationAction.request.url, url.host != "127.0.0.1", url.scheme?.hasPrefix("http") == true {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        if navigationResponse.canShowMIMEType {
            decisionHandler(.allow)
        } else {
            decisionHandler(.download)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    /// target="_blank"（新しいタブを開く操作）を同一WebView内のナビゲーションとして扱う。
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            webView.load(URLRequest(url: url))
        }
        return nil
    }

    // MARK: WKDownloadDelegate

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.begin { result in
            completionHandler(result == .OK ? panel.url : nil)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        appendToLog("ダウンロードに失敗しました: \(error.localizedDescription)")
    }
}

// MARK: - G. ウィンドウとメニュー

func makeWebView(delegate: MiditrackWebDelegate) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.mediaTypesRequiringUserActionForPlayback = []
    configuration.preferences.isElementFullscreenEnabled = true
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.uiDelegate = delegate
    webView.navigationDelegate = delegate
    return webView
}

func makeMainWindow(contentView: NSView) -> NSWindow {
    let window = NSWindow(
        contentRect: NSRect(origin: .zero, size: initialWindowSize),
        styleMask: [.titled, .closable, .miniaturizable, .resizable],
        backing: .buffered,
        defer: false
    )
    window.title = "miditrack"
    window.minSize = NSSize(width: 640, height: 480)
    window.setFrameAutosaveName("miditrackMainWindow")
    window.contentView = contentView
    window.center()
    return window
}

func loadingPlaceholderHtml() -> String {
    """
    <!doctype html><html><head><meta charset="utf-8">
    <style>
      body { background:#1a1a2e; color:#e6e6f0; font-family:-apple-system,sans-serif;
             display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
    </style></head>
    <body><p>miditrack を起動しています…</p></body></html>
    """
}

func makeApplicationMenu(applicationName: String) -> NSMenuItem {
    let item = NSMenuItem()
    let menu = NSMenu()
    menu.addItem(withTitle: "\(applicationName) について", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    menu.addItem(.separator())
    menu.addItem(withTitle: "\(applicationName) を隠す", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    menu.addItem(withTitle: "ほかを隠す", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        .keyEquivalentModifierMask = [.command, .option]
    menu.addItem(withTitle: "すべてを表示", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
    menu.addItem(.separator())
    menu.addItem(withTitle: "\(applicationName) を終了", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    item.submenu = menu
    return item
}

func makeEditMenu() -> NSMenuItem {
    let item = NSMenuItem()
    let menu = NSMenu(title: "編集")
    menu.addItem(withTitle: "取り消す", action: Selector(("undo:")), keyEquivalent: "z")
    menu.addItem(withTitle: "やり直す", action: Selector(("redo:")), keyEquivalent: "Z")
    menu.addItem(.separator())
    menu.addItem(withTitle: "カット", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    menu.addItem(withTitle: "コピー", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    menu.addItem(withTitle: "ペースト", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    menu.addItem(withTitle: "すべてを選択", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    item.submenu = menu
    return item
}

func makeViewMenu() -> NSMenuItem {
    let item = NSMenuItem()
    let menu = NSMenu(title: "表示")
    menu.addItem(withTitle: "再読み込み", action: #selector(WKWebView.reload(_:)), keyEquivalent: "r")
    menu.addItem(withTitle: "フルスクリーンにする", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        .keyEquivalentModifierMask = [.command, .control]
    item.submenu = menu
    return item
}

func makeWindowMenu() -> NSMenuItem {
    let item = NSMenuItem()
    let menu = NSMenu(title: "ウインドウ")
    menu.addItem(withTitle: "しまう", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    menu.addItem(withTitle: "閉じる", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    item.submenu = menu
    return item
}

func installMainMenu(applicationName: String) {
    let mainMenu = NSMenu()
    mainMenu.addItem(makeApplicationMenu(applicationName: applicationName))
    mainMenu.addItem(makeEditMenu())
    mainMenu.addItem(makeViewMenu())
    mainMenu.addItem(makeWindowMenu())
    NSApp.mainMenu = mainMenu
}

// MARK: - H. AppDelegate

final class MiditrackAppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var webDelegate: MiditrackWebDelegate?
    private var backend: BackendController?
    private var startupTimeoutWorkItem: DispatchWorkItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        if let icon = NSImage(contentsOf: applicationIconURL) {
            NSApp.applicationIconImage = icon
        }
        installMainMenu(applicationName: "miditrack")

        let delegate = MiditrackWebDelegate()
        webDelegate = delegate
        let webView = makeWebView(delegate: delegate)
        webView.loadHTMLString(loadingPlaceholderHtml(), baseURL: nil)
        self.webView = webView

        let window = makeMainWindow(contentView: webView)
        self.window = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        prepareLogFile()

        // バックエンド起動はここまで（ウィンドウ表示・NSApp.activate後）意図的に
        // 遅らせている。AppKitのイベントループがまだ回っていない起動直後に
        // Dropbox配下のファイルへアクセスすると、TCCがプロンプトを表示できず
        // 無言で拒否することを実機で確認したため（詳細はファイル冒頭のコメント）。
        let controller = BackendController(backendScriptURL: backendScriptURL)
        backend = controller
        controller.start(
            onReady: { [weak self] url in self?.handleBackendReady(url: url) },
            onFailure: { [weak self] message in self?.handleBackendFailure(message: message) }
        )
        scheduleStartupTimeout()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        backend?.terminate()
    }

    private func scheduleStartupTimeout() {
        let workItem = DispatchWorkItem { [weak self] in
            self?.handleBackendFailure(message: "バックエンドが\(Int(serverStartupTimeoutSeconds))秒以内に応答しませんでした。")
        }
        startupTimeoutWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + serverStartupTimeoutSeconds, execute: workItem)
    }

    private func handleBackendReady(url: URL) {
        startupTimeoutWorkItem?.cancel()
        webView?.load(URLRequest(url: url))
    }

    private func handleBackendFailure(message: String) {
        startupTimeoutWorkItem?.cancel()
        presentFatalAlert(message: message)
    }

    private func presentFatalAlert(message: String) {
        appendToLog("✗ \(message)")
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "miditrack"
        alert.informativeText = "\(message)\n\n詳細: \(logFileURL.path)"
        alert.addButton(withTitle: "OK")
        alert.runModal()
        NSApp.terminate(nil)
    }
}

// MARK: - I. エントリポイント

if CommandLine.arguments.contains("--self-test") {
    runSelfTest()
    exit(0)
}

let application = NSApplication.shared
let applicationDelegate = MiditrackAppDelegate()
application.delegate = applicationDelegate
application.run()
