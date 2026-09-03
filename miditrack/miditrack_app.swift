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

let applicationBundleURL = Bundle.main.bundleURL
let resourceDirectoryURL = Bundle.main.resourceURL
    ?? applicationBundleURL.appendingPathComponent("Contents/Resources")
let projectResourceURL = resourceDirectoryURL.appendingPathComponent("project")
let backendExecutableURL = resourceDirectoryURL
    .appendingPathComponent("runtime/backend/miditrack-backend")
let nodeExecutableURL = applicationBundleURL
    .appendingPathComponent("Contents/Helpers/node")
let nsfConverterURL = applicationBundleURL
    .appendingPathComponent("Contents/Helpers/nsf2midi")
let spcConverterURL = applicationBundleURL
    .appendingPathComponent("Contents/Helpers/spc2midi")
let vgmStemsHelperURL = applicationBundleURL
    .appendingPathComponent("Contents/Helpers/vgm2midi_stems")
let midiToWavURL = projectResourceURL.appendingPathComponent("miditrack/midi2wav.sh")
let webAssetsURL = projectResourceURL.appendingPathComponent("miditrack/src/miditrack/web_assets")
let applicationIconURL = resourceDirectoryURL.appendingPathComponent("miditrack.icns")
let splashImageURL = webAssetsURL.appendingPathComponent("miditrack_lead.png")

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
let supportedOpenExtensions: Set<String> = [
    "mid", "midi", "nsf", "nsfe", "spc", "spc2", "vgm", "vgz", "zip", "m3u", "m3u8", "miditrack",
]
let maxOpenBatchCount = 64
let localOpenStagingURL = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
    .appendingPathComponent("miditrack-open-\(ProcessInfo.processInfo.processIdentifier)", isDirectory: true)

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

struct LocalOpenBatch: Equatable {
    var accepted: [URL]
    var rejected: [URL]
}

/// Finderから渡されたURL群を、対応拡張子だけに絞り込む。
func classifyLocalOpenBatch(_ urls: [URL]) -> LocalOpenBatch {
    let acceptedURLs = urls.filter { supportedOpenExtensions.contains($0.pathExtension.lowercased()) }
    let rejectedURLs = urls.filter { !supportedOpenExtensions.contains($0.pathExtension.lowercased()) }
    if let projectURL = acceptedURLs.first(where: { $0.pathExtension.lowercased() == "miditrack" }) {
        return LocalOpenBatch(accepted: [projectURL], rejected: rejectedURLs)
    }
    return LocalOpenBatch(accepted: Array(acceptedURLs.prefix(maxOpenBatchCount)), rejected: rejectedURLs)
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
    let unsupportedURL = URL(fileURLWithPath: "/tmp/readme.txt")
    let upperCaseVgmURL = URL(fileURLWithPath: "/tmp/FOO.VGM")
    let projectURL = URL(fileURLWithPath: "/tmp/song.miditrack")
    let batch = classifyLocalOpenBatch([unsupportedURL, upperCaseVgmURL, projectURL])
    check(batch.accepted == [projectURL], "classifyLocalOpenBatch should prioritize a project")
    check(batch.rejected == [unsupportedURL], "classifyLocalOpenBatch should reject unsupported files")
    let manyMids = (0..<100).map { URL(fileURLWithPath: "/tmp/\($0).mid") }
    check(classifyLocalOpenBatch(manyMids).accepted.count == maxOpenBatchCount, "classifyLocalOpenBatch should cap the batch")
    check(classifyLocalOpenBatch([]) == LocalOpenBatch(accepted: [], rejected: []), "classifyLocalOpenBatch should accept an empty batch")

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
    private let backendExecutableURL: URL
    private let process = Process()
    private let outputPipe = Pipe()
    private lazy var lineAccumulator = LineAccumulator { [weak self] line in
        self?.handleOutputLine(line)
    }
    private var onReady: ((URL) -> Void)?
    private var onFailure: ((String) -> Void)?
    private var isUrlDelivered = false

    init(backendExecutableURL: URL) {
        self.backendExecutableURL = backendExecutableURL
    }

    /// バックエンドを起動し、標準出力の監視を開始する。
    func start(onReady: @escaping (URL) -> Void, onFailure: @escaping (String) -> Void) {
        self.onReady = onReady
        self.onFailure = onFailure

        guard FileManager.default.isExecutableFile(atPath: backendExecutableURL.path) else {
            onFailure("miditrackのバックエンドが見つかりません: \(backendExecutableURL.path)。install.shを再実行してください。")
            return
        }

        process.executableURL = backendExecutableURL
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
        environment["MIDITRACK_RESOURCE_ROOT"] = projectResourceURL.path
        environment["MIDITRACK_NODE_BIN"] = nodeExecutableURL.path
        environment["MIDI2WAV_BIN"] = midiToWavURL.path
        environment["NSF2MIDI_BIN"] = nsfConverterURL.path
        environment["SPC2MIDI_BIN"] = spcConverterURL.path
        environment["VGM2MIDI_STEMS_HELPER"] = vgmStemsHelperURL.path
        environment["MIDITRACK_LOCAL_OPEN_DIR"] = localOpenStagingURL.path
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
final class MiditrackWebDelegate: NSObject, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    /// Web側のUI要素が実際に描画され終えた時点で一度だけ呼ばれる。
    /// スプラッシュオーバーレイを消すタイミングに使う。
    ///
    /// didFinish（WKNavigationDelegate、HTML/CSS/JSなどのリソース取得完了）
    /// では早すぎる — app.jsのinit()はその後もloadPreferences/loadSoundfonts/
    /// セッション取得とトラックリスト描画を非同期に続けており、didFinishの
    /// 時点ではまだ画面上に実際のUI要素が出ていない（実機で確認済み。
    /// 「スプラッシュが消えてからメインが表示される」ように見える不具合の
    /// 原因だった）。app.js側がinit()の全終了経路（早期return・正常終了・
    /// エラー）でDOM更新後に二重requestAnimationFrameを待ち、少なくとも一度の
    /// 描画機会を挟んでからpostMessageする"miditrackReady"スクリプトメッセージ
    /// （WKScriptMessageHandler）を本来のトリガーとする。
    ///
    /// didFinishは、万一"miditrackReady"が届かない場合（app.jsの想定外の
    /// エラーなど）に画面が永久にスプラッシュのままになることを防ぐための
    /// フォールバックとしてのみ使う（読み込み完了から数秒待っても届かなければ
    /// 諦めて解除する）。didFail/didFailProvisionalNavigationはナビゲーション
    /// 自体が失敗した場合の即時フォールバック。
    var onInitialLoadFinished: (() -> Void)?
    /// miditrackReadyが届くたび（初回だけでなく再読み込み後も）呼ばれる。
    var onWebUiReady: (() -> Void)?
    /// Web UIのナビゲーション開始時に呼ばれ、Finder取り込みのゲートを閉じる。
    var onNavigationStarted: (() -> Void)?
    private var hasFinishedInitialLoad = false

    private func notifyInitialLoadFinishedOnce() {
        guard !hasFinishedInitialLoad else { return }
        hasFinishedInitialLoad = true
        onInitialLoadFinished?()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "miditrackReady" else { return }
        onWebUiReady?()
        notifyInitialLoadFinishedOnce()
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        onNavigationStarted?()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            self?.notifyInitialLoadFinishedOnce()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        notifyInitialLoadFinishedOnce()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        notifyInitialLoadFinishedOnce()
    }

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
    // Web側にネイティブアプリであることを伝える。CSP（script-src 'self'）の
    // 影響を受けず、ページ内スクリプトより先（atDocumentStart）に実行される。
    let nativeFlagScript = WKUserScript(
        source: """
        window.__miditrackNative = true;
        let applyNativeFullscreen = () => {
            if (document.body) document.body.classList.add("is-fullscreen");
        };
        const nativeFullscreenObserver = new MutationObserver(() => {
            applyNativeFullscreen();
            if (document.body) nativeFullscreenObserver.disconnect();
        });
        nativeFullscreenObserver.observe(document.documentElement, { childList: true });
        applyNativeFullscreen();
        """,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
    )
    configuration.userContentController.addUserScript(nativeFlagScript)
    // app.jsのinit()がUI描画まで完了した際に呼ぶnotifyNativeAppReady()の
    // 受け口。スプラッシュオーバーレイをいつ消すかの本来のトリガーになる
    // （MiditrackWebDelegate.userContentController(_:didReceive:)参照）。
    configuration.userContentController.add(delegate, name: "miditrackReady")
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
    // setFrameAutosaveName()は、直前に保存済みのフレーム（位置とサイズの
    // 両方）があればこの呼び出しの時点で即座に復元する。復元の有無を
    // 事前に判定してからcenter()の要否を決めないと、無条件にcenter()を
    // 呼んだ場合、位置だけが常に画面中央へ上書きされてしまう（サイズは
    // center()が変更しないため復元されたままになり、位置だけ復元されない
    // という非対称な不具合になる — 実機で確認済み）。
    let frameAutosaveKey = "NSWindow Frame miditrackMainWindow"
    let hasSavedFrame = UserDefaults.standard.string(forKey: frameAutosaveKey) != nil
    window.setFrameAutosaveName("miditrackMainWindow")
    window.contentView = contentView
    if !hasSavedFrame {
        window.center()
    }
    return window
}

/// 素のNSImageViewは、imageScalingの設定に関わらずAuto Layout上で画像本来の
/// ピクセルサイズ（miditrack_lead.pngは1672x941）を「望ましいサイズ」として
/// 主張し続ける。このスプラッシュカードは固定サイズの中で画像を
/// スケーリングする必要がある。intrinsicContentSizeをnoIntrinsicMetricにして
/// 「望ましいサイズなし」と申告することで、親ビュー（ひいてはメインウィンドウ
/// 自体）がその画像サイズへ膨らんでしまう事故を防ぐ。
final class NoIntrinsicSizeImageView: NSImageView {
    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric)
    }
}

/// スプラッシュの見た目を、固定サイズのカードとして構築する。独立した
/// ウィンドウにしないのは、
/// バックエンド起動・WKWebViewの読み込みが完了するまでの間もメインウィンドウ
/// 自体は最初から画面に出しておきたいため（詳細はAppDelegate側のコメント参照）。
///
/// カードだけをフェードするため、カード外のWeb UIはスプラッシュ表示中から
/// 見えている。ウィンドウが（前回終了時のサイズ復元により）640x360より
/// 大きくても、画像をウィンドウいっぱいに引き伸ばさない。
func makeSplashCardView() -> NSView {
    let cardSize = NSSize(width: 640, height: 360)

    let imageView = NoIntrinsicSizeImageView()
    imageView.image = NSImage(contentsOf: splashImageURL)
    imageView.imageScaling = .scaleProportionallyUpOrDown
    imageView.imageAlignment = .alignCenter

    let labelStack = NSStackView()
    labelStack.orientation = .vertical
    labelStack.alignment = .leading
    labelStack.spacing = 4
    let title = NSTextField(labelWithString: "miditrack")
    title.font = NSFont.systemFont(ofSize: 32, weight: .bold)
    title.textColor = .white
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    let versionLabel = NSTextField(labelWithString: "Version \(version)")
    versionLabel.font = NSFont.systemFont(ofSize: 14, weight: .medium)
    versionLabel.textColor = NSColor.white.withAlphaComponent(0.8)
    let status = NSTextField(labelWithString: "Starting…")
    status.font = NSFont.systemFont(ofSize: 14)
    status.textColor = NSColor.white.withAlphaComponent(0.7)
    labelStack.addArrangedSubview(title)
    labelStack.addArrangedSubview(versionLabel)
    labelStack.addArrangedSubview(status)

    let card = NSView()
    card.wantsLayer = true
    card.layer?.backgroundColor = NSColor.black.cgColor
    card.addSubview(imageView)
    card.addSubview(labelStack)
    card.translatesAutoresizingMaskIntoConstraints = false
    imageView.translatesAutoresizingMaskIntoConstraints = false
    labelStack.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
        card.widthAnchor.constraint(equalToConstant: cardSize.width),
        card.heightAnchor.constraint(equalToConstant: cardSize.height),
        imageView.leadingAnchor.constraint(equalTo: card.leadingAnchor),
        imageView.trailingAnchor.constraint(equalTo: card.trailingAnchor),
        imageView.topAnchor.constraint(equalTo: card.topAnchor),
        imageView.bottomAnchor.constraint(equalTo: card.bottomAnchor),
        labelStack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 36),
        labelStack.topAnchor.constraint(equalTo: card.topAnchor, constant: 32),
    ])

    return card
}

/// WKWebViewとスプラッシュカードを重ねた、メインウィンドウのcontentView用
/// コンテナを作る。カードは最後に追加してwebViewより手前に描画するが、
/// 640x360の領域だけを占める。
func makeMainContentContainer(webView: NSView, splashCard: NSView) -> NSView {
    let container = NSView()
    container.addSubview(webView)
    container.addSubview(splashCard)
    webView.translatesAutoresizingMaskIntoConstraints = false
    splashCard.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
        webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
        webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        webView.topAnchor.constraint(equalTo: container.topAnchor),
        webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        splashCard.centerXAnchor.constraint(equalTo: container.centerXAnchor),
        splashCard.centerYAnchor.constraint(equalTo: container.centerYAnchor),
    ])
    return container
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

/// target・SF Symbolsアイコン付きのメニュー項目を1つ追加する共通ヘルパー。
/// これらの項目はWeb側の既存ボタンをクリックするだけの薄い実装で、有効/無効
/// の判定をWeb側に委ねて常時有効にする設計のため、targetをAppDelegate自身
/// （NSObject直系・NSResponderではない）へ明示指定し、AppKitの自動
/// バリデーション対象から外している。
@discardableResult
func addTargetedMenuItem(
    to menu: NSMenu,
    title: String,
    action: Selector,
    keyEquivalent: String,
    target: AnyObject,
    symbolName: String
) -> NSMenuItem {
    let item = menu.addItem(withTitle: title, action: action, keyEquivalent: keyEquivalent)
    item.target = target
    item.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)
    return item
}

func makeApplicationMenu(applicationName: String, target: AnyObject) -> NSMenuItem {
    let item = NSMenuItem()
    let menu = NSMenu()
    menu.addItem(withTitle: "\(applicationName) について", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    menu.addItem(.separator())
    addTargetedMenuItem(
        to: menu, title: "設定…", action: #selector(MiditrackAppDelegate.openSettingsFromMenu),
        keyEquivalent: ",", target: target, symbolName: "gearshape"
    )
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

/// 「ファイルを開く…」と「MIDI/WAV/プロジェクトを保存…」をフラットに並べた
/// 「ファイル」メニュー。いずれもWeb側の既存ボタンをクリックするだけの薄い
/// 実装（clickWebViewElement参照）。
func makeFileMenu(target: AnyObject) -> NSMenuItem {
    let item = NSMenuItem()
    let menu = NSMenu(title: "ファイル")
    addTargetedMenuItem(
        to: menu, title: "ファイルを開く…", action: #selector(MiditrackAppDelegate.openFileFromMenu),
        keyEquivalent: "o", target: target, symbolName: "folder"
    )
    menu.addItem(.separator())
    addTargetedMenuItem(
        to: menu, title: "MIDIを保存…", action: #selector(MiditrackAppDelegate.saveMidiFromMenu),
        keyEquivalent: "", target: target, symbolName: "pianokeys"
    )
    addTargetedMenuItem(
        to: menu, title: "WAVを保存…", action: #selector(MiditrackAppDelegate.saveWavFromMenu),
        keyEquivalent: "e", target: target, symbolName: "waveform"
    )
    addTargetedMenuItem(
        to: menu, title: "プロジェクトを保存…", action: #selector(MiditrackAppDelegate.saveProjectFromMenu),
        keyEquivalent: "s", target: target, symbolName: "doc.zipper"
    )

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

func installMainMenu(applicationName: String, target: AnyObject) {
    let mainMenu = NSMenu()
    mainMenu.addItem(makeApplicationMenu(applicationName: applicationName, target: target))
    mainMenu.addItem(makeFileMenu(target: target))
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
    private var splashCardView: NSView?
    private var backend: BackendController?
    private var startupTimeoutWorkItem: DispatchWorkItem?
    private var splashStartedAt = Date()
    private var pendingOpenURLs: [URL] = []
    private var isWebUiReady = false
    private var isLocalOpenFlushScheduled = false
    private var isLocalOpenInFlight = false

    // メインウィンドウ自体は起動直後から表示し、その上にスプラッシュカードを
    // 重ねる（別ウィンドウにはしない）。
    //
    // 以前は「別ウィンドウのスプラッシュ」→「読み込み完了後にメインウィンドウを
    // 作成してcrossfade」という設計だったが、実機検証でWKWebViewが
    // 「一度もウィンドウサーバーに乗っていないウィンドウ」の中にいる間は
    // 実際の描画を後回しにすることが分かり、フェード開始の時点でまだ中身が
    // 描画されておらず「スプラッシュが消えてから遅れてメインが現れる」ように
    // しか見えなかった。メインウィンドウ（とその中のWKWebView）を最初から
    // 本当に画面に出しておけば、WKWebViewは読み込み中もずっと通常どおり描画
    // され続けるため、スプラッシュカードを外した瞬間に既に描画済みの中身が
    // そのまま見える。カード外のWeb UIは起動中から見えるため、カードの
    // フェードでUI全体が暗くなることもない。
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        if let icon = NSImage(contentsOf: applicationIconURL) {
            NSApp.applicationIconImage = icon
        }
        installMainMenu(applicationName: "miditrack", target: self)

        splashStartedAt = Date()

        let delegate = MiditrackWebDelegate()
        webDelegate = delegate
        let webView = makeWebView(delegate: delegate)
        self.webView = webView
        let splashCard = makeSplashCardView()
        splashCardView = splashCard
        let contentContainer = makeMainContentContainer(webView: webView, splashCard: splashCard)
        let mainWindow = makeMainWindow(contentView: contentContainer)
        window = mainWindow
        delegate.onInitialLoadFinished = { [weak self] in
            self?.revealMainContent()
        }
        delegate.onWebUiReady = { [weak self] in
            self?.isWebUiReady = true
            self?.scheduleLocalOpenFlush()
        }
        delegate.onNavigationStarted = { [weak self] in
            self?.isWebUiReady = false
        }

        mainWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        prepareLogFile()

        try? FileManager.default.createDirectory(
            at: localOpenStagingURL,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )

        // バックエンド起動はここまで（ウィンドウ表示・NSApp.activate後）意図的に
        // 遅らせている。AppKitのイベントループがまだ回っていない起動直後に
        // Dropbox配下のファイルへアクセスすると、TCCがプロンプトを表示できず
        // 無言で拒否することを実機で確認したため（詳細はファイル冒頭のコメント）。
        let controller = BackendController(backendExecutableURL: backendExecutableURL)
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
        try? FileManager.default.removeItem(at: localOpenStagingURL)
    }

    func application(_ sender: NSApplication, open urls: [URL]) {
        let batch = classifyLocalOpenBatch(urls)
        if !batch.rejected.isEmpty {
            let names = batch.rejected.map(\.lastPathComponent).joined(separator: ", ")
            appendToLog("対応していないファイルを無視しました: \(names)")
        }
        guard !batch.accepted.isEmpty else { return }
        pendingOpenURLs.append(contentsOf: batch.accepted)
        scheduleLocalOpenFlush()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag, let window {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        return true
    }

    /// Web UIの準備完了後、同一ランループで届いたFinderオープンを1回にまとめる。
    private func scheduleLocalOpenFlush() {
        guard isWebUiReady, !isLocalOpenFlushScheduled, !isLocalOpenInFlight,
              !pendingOpenURLs.isEmpty else { return }
        isLocalOpenFlushScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.isLocalOpenFlushScheduled = false
            self.flushPendingOpenURLs()
        }
    }

    /// Finderから渡されたファイルをアプリ専用の一時領域へ複製してWeb UIへ渡す。
    private func flushPendingOpenURLs() {
        guard isWebUiReady, !isLocalOpenInFlight, !pendingOpenURLs.isEmpty else { return }
        let openURLs = pendingOpenURLs
        pendingOpenURLs.removeAll()
        isLocalOpenInFlight = true

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let fileManager = FileManager.default
            var stagedURLs: [URL] = []
            var stagingDirectories: [URL] = []
            for sourceURL in openURLs {
                let stagingDirectory = localOpenStagingURL
                    .appendingPathComponent(UUID().uuidString, isDirectory: true)
                let destinationURL = stagingDirectory.appendingPathComponent(sourceURL.lastPathComponent)
                let didAccessSecurityScope = sourceURL.startAccessingSecurityScopedResource()
                defer {
                    if didAccessSecurityScope {
                        sourceURL.stopAccessingSecurityScopedResource()
                    }
                }
                do {
                    try fileManager.createDirectory(
                        at: stagingDirectory,
                        withIntermediateDirectories: true,
                        attributes: [.posixPermissions: 0o700]
                    )
                    try fileManager.copyItem(at: sourceURL, to: destinationURL)
                    stagingDirectories.append(stagingDirectory)
                    stagedURLs.append(destinationURL)
                } catch {
                    try? fileManager.removeItem(at: stagingDirectory)
                    appendToLog("Finderファイルを一時領域へコピーできませんでした: \(sourceURL.path) (\(error.localizedDescription))")
                }
            }
            DispatchQueue.main.async {
                guard let self else {
                    for directory in stagingDirectories {
                        try? fileManager.removeItem(at: directory)
                    }
                    return
                }
                self.submitStagedOpenURLs(stagedURLs, cleanupDirectories: stagingDirectories)
            }
        }
    }

    /// ステージング済みパスを文字列補間せず、ページワールドの非同期関数へ渡す。
    private func submitStagedOpenURLs(_ stagedURLs: [URL], cleanupDirectories: [URL]) {
        guard !stagedURLs.isEmpty, let webView else {
            cleanupLocalOpenDirectories(cleanupDirectories)
            return
        }
        webView.callAsyncJavaScript(
            "return await window.__miditrackOpenLocalFiles(paths);",
            arguments: ["paths": stagedURLs.map(\.path)],
            in: nil,
            in: .page
        ) { [weak self] result in
            if case let .failure(error) = result {
                appendToLog("FinderファイルをWeb UIへ渡せませんでした: \(error.localizedDescription)")
            }
            self?.cleanupLocalOpenDirectories(cleanupDirectories)
        }
    }

    /// Web UIが取り込みを完了した後に、そのバッチだけを確実に片付ける。
    private func cleanupLocalOpenDirectories(_ directories: [URL]) {
        for directory in directories {
            try? FileManager.default.removeItem(at: directory)
        }
        isLocalOpenInFlight = false
        scheduleLocalOpenFlush()
    }

    // MARK: メニューアクション（Web側の既存ボタンをクリックするだけの薄い実装）

    // fileprivate: #selectorでこのクラスを参照するmakeFileMenu/makeApplicationMenuは
    // 同じファイル内のトップレベル関数であり、privateだと型スコープ外から見えない。
    @objc fileprivate func openFileFromMenu() {
        clickWebViewElement("#open-dialog-button")
    }

    @objc fileprivate func openSettingsFromMenu() {
        clickWebViewElement("#settings-open")
    }

    @objc fileprivate func saveMidiFromMenu() {
        clickWebViewElement("#download-button")
    }

    @objc fileprivate func saveWavFromMenu() {
        clickWebViewElement("#download-wav-button")
    }

    @objc fileprivate func saveProjectFromMenu() {
        clickWebViewElement("#save-project-button")
    }

    /// メニューからWeb側の既存ボタンをクリックしたのと同じ効果を起こす。
    /// disabledなボタンは.click()してもブラウザが無視するため、有効/無効の
    /// 判定をSwift側に持つ必要がない（メニュー項目は常に有効という決定に対応）。
    private func clickWebViewElement(_ selector: String) {
        webView?.evaluateJavaScript("document.querySelector('\(selector)')?.click();")
    }

    private func scheduleStartupTimeout() {
        let workItem = DispatchWorkItem { [weak self] in
            self?.handleBackendFailure(message: "バックエンドが\(Int(serverStartupTimeoutSeconds))秒以内に応答しませんでした。")
        }
        startupTimeoutWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + serverStartupTimeoutSeconds, execute: workItem)
    }

    /// バックエンドのURLが分かり次第、WKWebViewの読み込みを開始する。
    /// メインウィンドウ自体はapplicationDidFinishLaunching()で既に表示済み
    /// （スプラッシュカードを重ねた状態）なので、ここではURLを
    /// 読み込ませるだけでよい。
    private func handleBackendReady(url: URL) {
        startupTimeoutWorkItem?.cancel()
        webView?.load(URLRequest(url: url))
    }

    /// WKWebViewの初回読み込み（成功・失敗いずれか）が完了した後に呼ばれる。
    /// スプラッシュ最低表示時間（起動から1秒）が経過するのを待ってから、
    /// スプラッシュカードだけをフェードアウトさせて取り除く。カード外の
    /// メインコンテンツはフェード開始時点から表示されたままである。
    private func revealMainContent() {
        let elapsed = Date().timeIntervalSince(splashStartedAt)
        let remaining = max(0, 1 - elapsed)
        DispatchQueue.main.asyncAfter(deadline: .now() + remaining) { [weak self] in
            guard let self, let splashCard = self.splashCardView else { return }
            NSAnimationContext.runAnimationGroup({ context in
                context.duration = 0.35
                context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                splashCard.animator().alphaValue = 0
            }, completionHandler: { [weak self] in
                splashCard.removeFromSuperview()
                self?.splashCardView = nil
            })
        }
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
