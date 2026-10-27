import SwiftUI
import WebKit

// v1 terminal: the server's own xterm.js page (terminal.html) in a web view, signed in with the
// app's cookie. ponytail: a native SwiftTerm view over /ws/attach replaces this if the web page
// ever falls short (keyboard, scrollback, gestures).
struct TerminalView: View {
    let name: String
    @Environment(Deck.self) private var deck
    @State private var pageTitle: String?

    var body: some View {
        if let creds = deck.creds, let url = terminalURL(creds) {
            WebTerminal(url: url, creds: creds, title: $pageTitle,
                        leave: { deck.selection = nil },
                        relogin: { await deck.relogin() })
                .background(Color.black)
                .navigationTitle(pageTitle ?? deck.sessions.first { $0.name == name }?.displayTitle ?? name)
                .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func terminalURL(_ c: Credentials) -> URL? {
        guard var u = URLComponents(string: c.baseURL + "/terminal.html") else { return nil }
        u.queryItems = [URLQueryItem(name: "session", value: name)]
        return u.url
    }
}

struct WebTerminal: UIViewRepresentable {
    let url: URL
    let creds: Credentials
    @Binding var title: String?
    let leave: () -> Void
    let relogin: () async -> Bool

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let wv = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        wv.navigationDelegate = context.coordinator
        wv.uiDelegate = context.coordinator
        wv.isOpaque = false
        wv.backgroundColor = .black
        wv.scrollView.backgroundColor = .black
        // The page sets document.title to the session it shows, and switches sessions in place.
        let co = context.coordinator
        co.titleWatch = wv.observe(\.title) { wv, _ in
            MainActor.assumeIsolated { co.parent.title = wv.title?.isEmpty == false ? wv.title : nil }
        }
        return wv
    }

    func updateUIView(_ wv: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.load(url, in: wv)
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: WebTerminal
        var titleWatch: NSKeyValueObservation?
        private var shown: URL?
        private var retried = false   // one sign-in-again per opened session, so a bad cookie can't loop
        init(_ p: WebTerminal) { parent = p }

        // Copy the app's cookies (Polymux's session, and Access's when a service token got one) into
        // the web view, then load. A no-op when that session is already showing.
        func load(_ url: URL, in wv: WKWebView) {
            guard url != shown else { return }
            shown = url
            retried = false
            start(url, in: wv)
        }

        private func start(_ url: URL, in wv: WKWebView) {
            let creds = parent.creds
            Task {
                for c in HTTPCookieStorage.shared.cookies(for: url) ?? [] {
                    await wv.configuration.websiteDataStore.httpCookieStore.setCookie(c)
                }
                var req = URLRequest(url: url)
                creds.authorize(&req)
                wv.load(req)
            }
        }

        func webView(_ wv: WKWebView, decidePolicyFor a: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard a.targetFrame?.isMainFrame ?? true, let u = a.request.url, ["http", "https"].contains(u.scheme ?? "") else { return .allow }
            // Links out of the terminal open in Safari.
            if u.host != parent.url.host { _ = await UIApplication.shared.open(u); return .cancel }
            switch u.path {
            case "/", "/index.html":   // the page's Dashboard link, or nothing left to attach to
                parent.leave()
                return .cancel
            case "/login.html":        // the cookie expired: sign in again and reload the session
                if !retried, let again = shown, await parent.relogin() {
                    retried = true
                    start(again, in: wv)
                } else {
                    parent.leave()     // the list says why
                }
                return .cancel
            default:
                return .allow
            }
        }

        // window.open (xterm's link handler) → Safari.
        func webView(_ wv: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let u = a.request.url { UIApplication.shared.open(u) }
            return nil
        }
    }
}
