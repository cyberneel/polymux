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
                if deck.creds == nil { ConnectView() } else { SessionsView() }
            }
            .environment(deck)
            .font(.sans(.body))
            .tint(.plum)
        }
    }
}

// The app's state: who we're signed in to, the Deep Sessions it lists, and which one is open.
@MainActor @Observable final class Deck {
    var creds = Credentials.stored
    var sessions: [Session] = []
    var problem: String?      // why the last refresh failed, in words
    var loaded = false
    var selection: String?

    var needsYou: Int { sessions.filter(\.needsYou).count }

    // Connect screen: nil when signed in, else what's wrong.
    func connect(_ c: Credentials) async -> String? {
        do {
            try await Server(creds: c).login()
            c.save()
            creds = c
            await refresh()
            // Badges only (v1): the needs-you count on the app icon.
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.badge])
            return nil
        } catch { return error.localizedDescription }
    }

    // Most recently active first, like the web sidebar.
    func refresh() async {
        guard let creds else { return }
        do {
            sessions = try await Server(creds: creds).sessions().sorted { ($0.lastActivity ?? 0) > ($1.lastActivity ?? 0) }
            problem = nil
        } catch { problem = error.localizedDescription }
        loaded = true
        try? await UNUserNotificationCenter.current().setBadgeCount(needsYou)
    }

    // The terminal page sent us to /login.html: the cookie expired.
    func relogin() async -> Bool {
        guard let creds else { return false }
        do { try await Server(creds: creds).login(); return true } catch { problem = error.localizedDescription; return false }
    }

    func signOut() {
        Credentials.forget()
        creds = nil
        sessions = []
        selection = nil
        loaded = false
        HTTPCookieStorage.shared.removeCookies(since: .distantPast)
        WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {}
        Task { try? await UNUserNotificationCenter.current().setBadgeCount(0) }
    }
}
