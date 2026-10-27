import SwiftUI
import WebKit

// The app is the server's own web app (Active, History, Usage and Files tabs, the terminal, all of
// it) in one web view, so every web change lands here for free. Native: sign-in, the Keychain, the
// Access token, the badge. ponytail: a native screen replaces a web page only where the web falls short.
struct DeckView: View {
    @Environment(Deck.self) private var deck
    @Environment(\.scenePhase) private var phase

    var body: some View {
        if let creds = deck.creds {
            WebDeck(creds: creds, deck: deck)
                .ignoresSafeArea()   // like the home-screen web app: the pages pad with env(safe-area-inset-*)
                .background(Color.paper)
                .task(id: phase) {
                    // The badge and fresh cookies while in front, and once more on the way out.
                    while !Task.isCancelled {
                        await deck.poll()
                        guard phase == .active else { return }
                        try? await Task.sleep(for: .seconds(30))
                    }
                }
        }
    }
}

struct WebDeck: UIViewRepresentable {
    let creds: Credentials
    let deck: Deck

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let co = context.coordinator
        let cfg = WKWebViewConfiguration()
        // Log out signs the app out (the web's own button would bounce off /login.html and straight back
        // in), and iPads get the web's .ipad-app window-controls offset, which keys on standalone mode.
        let glue = """
            document.addEventListener('click', (e) => {
              if (!e.target.closest?.('#logout-btn, [data-target="logout-btn"]')) return;
              e.preventDefault(); e.stopImmediatePropagation();
              webkit.messageHandlers.polymux.postMessage('signout');
            }, true);
            \(UIDevice.current.userInterfaceIdiom == .pad ? "document.documentElement.classList.add('ipad-app');" : "")
            """
        cfg.userContentController.addUserScript(WKUserScript(source: glue, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController.add(co, name: "polymux")
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.navigationDelegate = co
        wv.uiDelegate = co
        wv.allowsBackForwardNavigationGestures = true
        wv.isOpaque = false
        wv.backgroundColor = .clear
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        co.open(nil, in: wv)
        return wv
    }

    func updateUIView(_ wv: WKWebView, context: Context) { context.coordinator.parent = self }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
        var parent: WebDeck
        private var lastSignIn = Date.distantPast
        private var saved: [ObjectIdentifier: URL] = [:]
        init(_ p: WebDeck) { parent = p }

        private var base: URL? { parent.creds.url("/") }

        // Load a page (the dashboard by default) with the Access token headers. Access answers with its
        // own cookie, which carries the page's fetches and web sockets from there on; Deck.poll keeps it fresh.
        func open(_ url: URL?, in wv: WKWebView) {
            guard let u = url ?? base else { return }
            Task {
                await parent.deck.syncCookies()
                var req = URLRequest(url: u)
                parent.creds.authorize(&req)
                wv.load(req)
            }
        }

        func webView(_ wv: WKWebView, decidePolicyFor a: WKNavigationAction) async -> WKNavigationActionPolicy {
            if a.shouldPerformDownload { return .download }   // the Files tab → share sheet
            guard a.targetFrame?.isMainFrame ?? true, let u = a.request.url, ["http", "https"].contains(u.scheme ?? "") else { return .allow }
            // A cookie ran out: Polymux's (the page went to /login.html) or Access's (it bounced to its sign-in).
            if u.path == "/login.html" || u.host?.hasSuffix(".cloudflareaccess.com") == true {
                await signInAgain(wv)
                return .cancel
            }
            if u.host != base?.host { _ = await UIApplication.shared.open(u); return .cancel }   // Account and other links → Safari
            return .allow
        }

        // Sign in again and reload the page that asked. Twice inside 30s means it isn't working (a
        // changed password, a revoked token): back to the connect screen with the reason.
        private func signInAgain(_ wv: WKWebView) async {
            guard Date().timeIntervalSince(lastSignIn) > 30 else {
                parent.deck.signOut("Polymux keeps asking to sign in. Sign in again.")
                return
            }
            lastSignIn = Date()
            if let problem = await parent.deck.relogin() { parent.deck.signOut(problem); return }
            open(wv.backForwardList.currentItem?.url, in: wv)
        }

        // target=_blank to this server opens in place (other hosts went to Safari above).
        func webView(_ wv: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            wv.load(a.request)
            return nil
        }

        func userContentController(_ uc: WKUserContentController, didReceive m: WKScriptMessage) {
            if m.body as? String == "signout" { parent.deck.signOut() }
        }

        // alert, confirm and prompt (Kill, Delete, Rename, New folder) as native alerts.
        func webView(_ wv: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo) async {
            _ = await ask(wv, m, cancel: false)
        }
        func webView(_ wv: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo) async -> Bool {
            await ask(wv, m) != nil
        }
        func webView(_ wv: WKWebView, runJavaScriptTextInputPanelWithPrompt p: String, defaultText: String?, initiatedByFrame f: WKFrameInfo) async -> String? {
            await ask(wv, p, field: defaultText ?? "")
        }

        // nil = Cancel, else what's in the field ("" without one).
        private func ask(_ wv: WKWebView, _ message: String, cancel: Bool = true, field: String? = nil) async -> String? {
            await withCheckedContinuation { k in
                let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
                if let field { a.addTextField { $0.text = field } }
                if cancel { a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in k.resume(returning: nil) }) }
                a.addAction(UIAlertAction(title: "OK", style: .default) { [weak a] _ in k.resume(returning: a?.textFields?.first?.text ?? "") })
                if !present(a, from: wv) { k.resume(returning: nil) }
            }
        }

        private func present(_ vc: UIViewController, from wv: WKWebView) -> Bool {
            var top = wv.window?.rootViewController
            while let p = top?.presentedViewController { top = p }
            guard let top else { return false }
            vc.popoverPresentationController?.sourceView = wv
            vc.popoverPresentationController?.sourceRect = CGRect(x: wv.bounds.midX, y: wv.bounds.midY, width: 0, height: 0)
            top.present(vc, animated: true)
            return true
        }

        // Downloads land in a temp folder, then the share sheet (Save to Files, AirDrop, …).
        func webView(_ wv: WKWebView, navigationAction a: WKNavigationAction, didBecome d: WKDownload) { d.delegate = self }

        func download(_ d: WKDownload, decideDestinationUsing r: URLResponse, suggestedFilename name: String) async -> URL? {
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            guard (try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)) != nil else { return nil }
            let u = dir.appendingPathComponent(name)
            saved[ObjectIdentifier(d)] = u
            return u
        }

        func downloadDidFinish(_ d: WKDownload) {
            guard let u = saved.removeValue(forKey: ObjectIdentifier(d)), let wv = d.webView else { return }
            _ = present(UIActivityViewController(activityItems: [u], applicationActivities: nil), from: wv)
        }

        func download(_ d: WKDownload, didFailWithError e: Error, resumeData: Data?) { saved[ObjectIdentifier(d)] = nil }
    }
}
