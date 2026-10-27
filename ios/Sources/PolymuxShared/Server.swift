import Foundation
import Security

// Shared by the app, the widget and the share extension: each runs in its own process and reads the
// same sign-in from the Keychain group (ios-ota gives every extension the app's group).

// Keychain string store for the server address and secrets. Pinned to a signing-stable access group
// (ios-ota.entitlements.json) so a re-sign doesn't orphan them, as in friday/ios Keychain.swift.
public enum Keychain {
    private static let accessGroup = "FG6VJVSUSP.com.cyberneel.polymux"
    private static func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key, kSecAttrAccessGroup as String: accessGroup]
    }
    public static func set(_ value: String, for key: String) {
        SecItemDelete(query(key) as CFDictionary)
        var add = query(key)
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }
    public static func get(_ key: String) -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
    public static func delete(_ key: String) { SecItemDelete(query(key) as CFDictionary) }
}

// How the app reaches Polymux: the server address and its password, plus an optional Cloudflare
// Access service token so a server behind Access works off-VPN (friday/ios Credentials.swift).
// No default server: a fresh install points nowhere until you type yours.
public struct Credentials: Sendable {
    public var baseURL: String
    public var password: String
    public var cfClientId = ""
    public var cfClientSecret = ""

    public init(baseURL: String, password: String, cfClientId: String = "", cfClientSecret: String = "") {
        self.baseURL = baseURL
        self.password = password
        self.cfClientId = cfClientId
        self.cfClientSecret = cfClientSecret
    }

    private static let keys = ["baseURL", "password", "cfClientId", "cfClientSecret"]
    public static var stored: Credentials? {
        guard let b = Keychain.get("baseURL"), !b.isEmpty, let pw = Keychain.get("password"), !pw.isEmpty else { return nil }
        return Credentials(baseURL: b, password: pw, cfClientId: Keychain.get("cfClientId") ?? "", cfClientSecret: Keychain.get("cfClientSecret") ?? "")
    }
    public func save() {
        for (k, v) in zip(Self.keys, [baseURL, password, cfClientId, cfClientSecret]) { Keychain.set(v, for: k) }
    }
    // Keeps the address so signing back in only needs the password.
    public static func forget() { for k in keys.dropFirst() { Keychain.delete(k) } }

    public func authorize(_ req: inout URLRequest) {
        guard !cfClientId.isEmpty else { return }
        req.setValue(cfClientId, forHTTPHeaderField: "CF-Access-Client-Id")
        req.setValue(cfClientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
    }
    public func url(_ path: String) -> URL? { URL(string: baseURL + path) }
}

// A typed server address → the base URL to save: trimmed, no trailing slash, https:// when no scheme
// was typed. nil when it can't be one (friday/ios Connect.swift).
public func serverAddress(_ typed: String) -> String? {
    var t = typed.trimmingCharacters(in: .whitespacesAndNewlines)
    if !t.contains("://") { t = "https://" + t }
    while t.hasSuffix("/") { t.removeLast() }
    guard let c = URLComponents(string: t), ["http", "https"].contains(c.scheme?.lowercased() ?? ""),
          let h = c.host, !h.isEmpty, !h.contains(" "), c.query == nil, URL(string: t + "/api") != nil else { return nil }
    return t
}

// One Deep Session as GET /api/sessions lists it.
public struct Session: Codable, Sendable, Identifiable, Hashable {
    public let name: String
    public let title: String?
    public let dir: String?
    public let waitingFor: String?
    public let claudeStatus: String?
    public let lastActivity: Double?   // ms since 1970

    public init(name: String, title: String?, dir: String?, waitingFor: String?, claudeStatus: String?, lastActivity: Double?) {
        (self.name, self.title, self.dir, self.waitingFor, self.claudeStatus, self.lastActivity) = (name, title, dir, waitingFor, claudeStatus, lastActivity)
    }
    public var id: String { name }
    public var needsYou: Bool { waitingFor?.isEmpty == false }
    public var working: Bool { !needsYou && claudeStatus == "busy" }
    public var label: String { title.flatMap { $0.isEmpty ? nil : $0 } ?? name }
    public var lastActive: Date? { lastActivity.map { Date(timeIntervalSince1970: $0 / 1000) } }
    // Where tapping it goes (the app routes polymux:// links).
    public var link: URL { URL(string: "polymux://session/" + (name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name))! }
}

// Readable in the app, the share sheet and Siri alike.
public struct ServerError: LocalizedError, CustomLocalizedStringResourceConvertible {
    public let message: String
    public init(message: String) { self.message = message }
    public var errorDescription: String? { message }
    public var localizedStringResource: LocalizedStringResource { "\(message)" }
}

// Polymux's API is cookie-authed: POST /api/login sets the session cookie, which URLSession.shared
// keeps in HTTPCookieStorage.shared (per process: the app's web view gets a copy, Deck.syncCookies).
public struct Server: Sendable {
    public let creds: Credentials
    public init(creds: Credentials) { self.creds = creds }

    private func send(_ path: String, method: String = "GET", body: Data? = nil, type: String = "application/json") async throws -> (Data, HTTPURLResponse) {
        guard let u = creds.url(path) else { throw ServerError(message: "That isn't a server address.") }
        let host = u.host ?? "that address"
        var req = URLRequest(url: u)
        req.httpMethod = method
        req.timeoutInterval = body?.count ?? 0 > 1 << 20 ? 120 : 15
        if let body {
            req.httpBody = body
            req.setValue(type, forHTTPHeaderField: "Content-Type")
        }
        creds.authorize(&req)
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw ServerError(message: "\(host) didn't answer.") }
            // Access bounced us to its sign-in page (a redirect, or a 403 for a bad token).
            if http.statusCode == 403 || http.url?.host?.contains("cloudflareaccess") == true {
                throw ServerError(message: "Cloudflare Access is in front of \(host). Add its service token (client id and secret).")
            }
            if http.statusCode == 429 { throw ServerError(message: "Too many wrong passwords from this network. Wait a minute, then try again.") }
            if http.statusCode == 404 || data.first == 0x3C { throw ServerError(message: "\(host) answered, but it isn't Polymux. Check the address.") }
            return (data, http)
        } catch let e as URLError {
            switch e.code {
            case .appTransportSecurityRequiresSecureConnection: throw ServerError(message: "iOS only allows https:// to a named server. Use https://\(host).")
            case .cannotFindHost, .dnsLookupFailed: throw ServerError(message: "Can't find \(host). Check the address.")
            case .notConnectedToInternet: throw ServerError(message: "You're offline.")
            case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
                 .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid:
                throw ServerError(message: "Couldn't make a secure connection to \(host). If it only serves plain http, type http:// in front.")
            default: throw ServerError(message: "Polymux didn't answer at \(host). Check the address and that the server is up.")
            }
        }
    }

    // An API call: signs in again once when the cookie has expired, and turns the server's
    // { error } into the message.
    private func call(_ path: String, method: String = "GET", json: [String: String]? = nil, body: Data? = nil, type: String = "application/json") async throws -> Data {
        let body = try json.map { try JSONEncoder().encode($0) } ?? body
        var (data, http) = try await send(path, method: method, body: body, type: type)
        if http.statusCode == 401 {
            try await login()
            (data, http) = try await send(path, method: method, body: body, type: type)
        }
        guard (200..<300).contains(http.statusCode) else {
            struct Problem: Decodable { let error: String }
            throw ServerError(message: (try? JSONDecoder().decode(Problem.self, from: data))?.error ?? "Polymux answered with an error (\(http.statusCode)).")
        }
        return data
    }

    public func login() async throws {
        let (_, http) = try await send("/api/login", method: "POST", body: try JSONEncoder().encode(["password": creds.password]))
        if http.statusCode == 401 { throw ServerError(message: "Wrong password.") }
        guard http.statusCode == 200 else { throw ServerError(message: "Polymux answered with an error (\(http.statusCode)). Try again in a minute.") }
    }

    // Ends the session on the server. Fastify wants a body, even an empty one.
    public func logout() async { _ = try? await send("/api/logout", method: "POST", body: Data("{}".utf8)) }

    // Newest activity first.
    public func sessions() async throws -> [Session] {
        struct List: Decodable { let sessions: [Session] }
        return try JSONDecoder().decode(List.self, from: try await call("/api/sessions")).sessions
    }

    // Folders to start a session in: the running sessions' first, then History's, newest first.
    public func folders(_ live: [Session]) async throws -> [String] {
        struct Past: Decodable { let cwd: String? }
        struct History: Decodable { let sessions: [Past] }
        let past = (try? JSONDecoder().decode(History.self, from: try await call("/api/history")).sessions) ?? []
        var seen = Set<String>()
        return (live.compactMap(\.dir) + past.compactMap(\.cwd)).filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    // A new Deep Session in dir, with prompt typed in once it boots → its name.
    public func create(dir: String, prompt: String) async throws -> String {
        struct Made: Decodable { let name: String }
        return try JSONDecoder().decode(Made.self, from: try await call("/api/sessions", method: "POST", json: ["dir": dir, "prompt": prompt])).name
    }

    // Types text into a running session and submits it.
    public func send(_ text: String, to session: String) async throws {
        let path = "/api/sessions/" + (session.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? session) + "/send"
        _ = try await call(path, method: "POST", json: ["text": text])
    }

    // Puts files in dir's .polymux/uploads (git ignores it; a taken name is kept, renamed) → their full paths.
    public func upload(_ files: [URL], to dir: String) async throws -> [String] {
        let boundary = "polymux-" + UUID().uuidString
        var body = Data()
        for f in files {
            let name = f.lastPathComponent.replacingOccurrences(of: "\"", with: "'")
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"f:\(name)\"; filename=\"\(name)\"\r\nContent-Type: application/octet-stream\r\n\r\n".utf8))
            body.append(try Data(contentsOf: f))
            body.append(Data("\r\n".utf8))
        }
        body.append(Data("--\(boundary)--\r\n".utf8))
        let d = dir.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? dir   // a folder name may hold + & =
        struct Saved: Decodable { let dir: String; let names: [String] }
        let data = try await call("/api/upload?attach=1&dir=" + d, method: "POST", body: body, type: "multipart/form-data; boundary=\(boundary)")
        let saved = try JSONDecoder().decode(Saved.self, from: data)
        return saved.names.map { saved.dir + "/" + $0 }
    }

    // This phone's APNs token, so the server can push when a session needs you.
    public func registerPush(token: String, bundleId: String, environment: String) async throws {
        _ = try await call("/api/push/apns", method: "POST", json: ["token": token, "bundleId": bundleId, "environment": environment])
    }
}
