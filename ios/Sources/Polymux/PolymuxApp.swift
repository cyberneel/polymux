import SwiftUI
import UserNotifications
import WebKit
import WidgetKit
import PolymuxShared

@main
struct PolymuxApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var deck = Deck.shared
    init() { Font.registerBundled() }
    var body: some Scene {
        WindowGroup {
            Group {
                if deck.creds == nil { ConnectView() } else { DeckView() }
            }
            .environment(deck)
            .font(.sans(.body))
            .tint(.plum)
            .onOpenURL { deck.go($0) }   // widgets
        }
    }
}

// A page the web view was asked to show; a new one each time, so tapping the same session twice reloads it.
struct Destination: Equatable {
    let path: String
    let id = UUID()
}

// The app's state: who we're signed in to, why we were signed out, and where to go next.
@MainActor @Observable final class Deck {
    static let shared = Deck()
    var creds = Credentials.stored
    var signedOutBecause: String?
    var destination: Destination?
    private var needsYou = -1

    // Connect screen: nil when signed in, else what's wrong.
    func connect(_ c: Credentials) async -> String? {
        do {
            try await Server(creds: c).login()
            c.save()
            signedOutBecause = nil
            creds = c
            enablePush()
            WidgetCenter.shared.reloadAllTimelines()
            return nil
        } catch { return error.localizedDescription }
    }

    // Notifications when a session needs you, and the badge. iOS asks once; registering is harmless
    // when it was declined (the server then has a token nothing shows).
    func enablePush() {
        Task {
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    // ios-ota stamps how the build was signed: an OTA build's token is a sandbox one.
    func registerPush(_ token: String) async {
        guard let creds else { return }
        let env = Bundle.main.object(forInfoDictionaryKey: "APNSEnvironment") as? String == "production" ? "production" : "sandbox"
        try? await Server(creds: creds).registerPush(token: token, bundleId: Bundle.main.bundleIdentifier ?? "", environment: env)
    }

    // polymux://session/<name>, polymux://new (the New Deep Session dialog), polymux://needs (the
    // newest session that needs you, else the dashboard); anything else is the dashboard.
    func go(_ url: URL) {
        guard url.scheme == "polymux" else { return }
        switch url.host {
        case "session": show(session: url.lastPathComponent)
        case "new": destination = Destination(path: "/?polymux-new")
        case "needs":
            Task {
                let all = if let creds { try? await Server(creds: creds).sessions() } else { [Session]?.none }
                if let first = all?.first(where: \.needsYou) { show(session: first.name) } else { destination = Destination(path: "/") }
            }
        default: destination = Destination(path: "/")
        }
    }

    func show(session name: String) {
        destination = Destination(path: "/terminal.html?session=" + (name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? name))
    }

    // Sets the badge, and hands the web view the cookies this request refreshed (Polymux's, after a
    // sign-in again, and Access's 24h one). The widgets catch up when the count changes.
    func poll() async {
        guard let creds, let sessions = try? await Server(creds: creds).sessions() else { return }
        await syncCookies()
        let n = sessions.filter(\.needsYou).count
        try? await UNUserNotificationCenter.current().setBadgeCount(n)
        if n != needsYou { needsYou = n; WidgetCenter.shared.reloadAllTimelines() }
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
        UIApplication.shared.unregisterForRemoteNotifications()   // APNs then tells the server this phone is gone
        Task { try? await UNUserNotificationCenter.current().setBadgeCount(0) }
        WidgetCenter.shared.reloadAllTimelines()
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    func application(_ app: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        if Deck.shared.creds != nil { Deck.shared.enablePush() }   // a fresh token each launch, as Apple asks
        return true
    }
    func application(_ app: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let cfg = UISceneConfiguration(name: nil, sessionRole: session.role)
        cfg.delegateClass = SceneDelegate.self
        return cfg
    }

    func application(_ app: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        Task { await Deck.shared.registerPush(hex) }
    }
    func application(_ app: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}

    // A push woke the app in the background: the widgets catch up.
    func application(_ app: UIApplication, didReceiveRemoteNotification info: [AnyHashable: Any]) async -> UIBackgroundFetchResult {
        WidgetCenter.shared.reloadAllTimelines()
        return .newData
    }

    // Banners while the app is open, too.
    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound, .badge])
    }
    // Tapping "… needs you" opens that session.
    func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        let name = r.notification.request.content.userInfo["session"] as? String
        Task { @MainActor in
            if let name { Deck.shared.show(session: name) }
            done()
        }
    }
}

// Home Screen quick actions (long-press the icon): New session, Needs you.
final class SceneDelegate: NSObject, UIWindowSceneDelegate {
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        if let item = options.shortcutItem { quick(item) }
    }
    func windowScene(_ ws: UIWindowScene, performActionFor item: UIApplicationShortcutItem, completionHandler done: @escaping (Bool) -> Void) {
        quick(item)
        done(true)
    }
    private func quick(_ item: UIApplicationShortcutItem) {
        if let u = URL(string: "polymux://" + item.type) { Deck.shared.go(u) }
    }
}
