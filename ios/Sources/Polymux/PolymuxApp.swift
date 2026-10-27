import SwiftUI
import UserNotifications
import WebKit

@main
struct PolymuxApp: App {
    @State private var deck = Deck()
    init() { Font.registerBundled() }
    var body: some Scene {
        WindowGroup {
            Group {
                if deck.creds == nil { ConnectView() } else { DeckView() }
            }
            .environment(deck)
            .font(.sans(.body))
            .tint(.plum)
        }
    }
}

// The app's state: who we're signed in to, and why we were signed out.
@MainActor @Observable final class Deck {
    var creds = Credentials.stored
    var signedOutBecause: String?

    // Connect screen: nil when signed in, else what's wrong.
    func connect(_ c: Credentials) async -> String? {
        do {
            try await Server(creds: c).login()
            c.save()
            signedOutBecause = nil
            creds = c
            // Badges only (v1): the needs-you count on the app icon.
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.badge])
            return nil
        } catch { return error.localizedDescription }
    }

    // Sets the badge, and hands the web view the cookies this request refreshed (Polymux's, after a
    // sign-in again, and Access's 24h one).
    func poll() async {
        guard let creds, let sessions = try? await Server(creds: creds).sessions() else { return }
        await syncCookies()
        try? await UNUserNotificationCenter.current().setBadgeCount(sessions.filter(\.needsYou).count)
    }

    // A page went to /login.html: the cookie expired. nil when signed in again, else why not.
    func relogin() async -> String? {
        guard let creds else { return "Signed out." }
        do { try await Server(creds: creds).login(); return nil } catch { return error.localizedDescription }
    }

    // The app signs in with URLSession; the web view keeps its own cookie jar.
    func syncCookies() async {
        guard let u = creds?.url("/") else { return }
        let jar = WKWebsiteDataStore.default().httpCookieStore
        for c in HTTPCookieStorage.shared.cookies(for: u) ?? [] { await jar.setCookie(c) }
    }

    // Log out (reason nil) also ends the session on the server, as the web's button does.
    func signOut(_ reason: String? = nil) {
        if reason == nil, let creds { Task { await Server(creds: creds).logout() } }
        Credentials.forget()
        creds = nil
        signedOutBecause = reason
        WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {}
        Task { try? await UNUserNotificationCenter.current().setBadgeCount(0) }
    }
}
