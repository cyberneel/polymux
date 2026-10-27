import Foundation
import Security

// Keychain string store for the server address and secrets. Pinned to a signing-stable access group
// (ios-ota.entitlements.json) so a re-sign doesn't orphan them, as in friday/ios Keychain.swift.
enum Keychain {
    private static let accessGroup = "FG6VJVSUSP.com.cyberneel.polymux"
    private static func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key, kSecAttrAccessGroup as String: accessGroup]
    }
    static func set(_ value: String, for key: String) {
        SecItemDelete(query(key) as CFDictionary)
        var add = query(key)
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }
    static func get(_ key: String) -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
    static func delete(_ key: String) { SecItemDelete(query(key) as CFDictionary) }
}

// How the app reaches Polymux: the server address and its password, plus an optional Cloudflare
// Access service token so a server behind Access works off-VPN (friday/ios Credentials.swift).
// No default server: a fresh install points nowhere until you type yours.
struct Credentials: Sendable {
    var baseURL: String
    var password: String
    var cfClientId = ""
    var cfClientSecret = ""

    private static let keys = ["baseURL", "password", "cfClientId", "cfClientSecret"]
    static var stored: Credentials? {
        guard let b = Keychain.get("baseURL"), !b.isEmpty, let pw = Keychain.get("password"), !pw.isEmpty else { return nil }
        return Credentials(baseURL: b, password: pw, cfClientId: Keychain.get("cfClientId") ?? "", cfClientSecret: Keychain.get("cfClientSecret") ?? "")
    }
    func save() {
        for (k, v) in zip(Self.keys, [baseURL, password, cfClientId, cfClientSecret]) { Keychain.set(v, for: k) }
    }
    // Keeps the address so signing back in only needs the password.
    static func forget() { for k in keys.dropFirst() { Keychain.delete(k) } }

    func authorize(_ req: inout URLRequest) {
        guard !cfClientId.isEmpty else { return }
        req.setValue(cfClientId, forHTTPHeaderField: "CF-Access-Client-Id")
        req.setValue(cfClientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
    }
    func url(_ path: String) -> URL? { URL(string: baseURL + path) }
}

// A typed server address → the base URL to save: trimmed, no trailing slash, https:// when no scheme
// was typed. nil when it can't be one (friday/ios Connect.swift).
func serverAddress(_ typed: String) -> String? {
    var t = typed.trimmingCharacters(in: .whitespacesAndNewlines)
    if !t.contains("://") { t = "https://" + t }
    while t.hasSuffix("/") { t.removeLast() }
    guard let c = URLComponents(string: t), ["http", "https"].contains(c.scheme?.lowercased() ?? ""),
          let h = c.host, !h.isEmpty, !h.contains(" "), c.query == nil, URL(string: t + "/api") != nil else { return nil }
    return t
}

// One Deep Session as GET /api/sessions lists it; the badge only needs to know who's waiting on you.
struct Session: Decodable, Sendable {
    let waitingFor: String?
    var needsYou: Bool { waitingFor?.isEmpty == false }
}

struct ServerError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

// Polymux's API is cookie-authed: POST /api/login sets the session cookie, which URLSession.shared
// keeps in HTTPCookieStorage.shared; the web view gets a copy (Deck.syncCookies).
struct Server: Sendable {
    let creds: Credentials

    private func send(_ path: String, method: String = "GET", json: [String: String]? = nil) async throws -> (Data, HTTPURLResponse) {
        guard let u = creds.url(path) else { throw ServerError(message: "That isn't a server address.") }
        let host = u.host ?? "that address"
        var req = URLRequest(url: u)
        req.httpMethod = method
        req.timeoutInterval = 15
        if let json {
            req.httpBody = try JSONEncoder().encode(json)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
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

    func login() async throws {
        let (_, http) = try await send("/api/login", method: "POST", json: ["password": creds.password])
        if http.statusCode == 401 { throw ServerError(message: "Wrong password.") }
        guard http.statusCode == 200 else { throw ServerError(message: "Polymux answered with an error (\(http.statusCode)). Try again in a minute.") }
    }

    // Ends the session on the server. Fastify wants a body, even an empty one.
    func logout() async { _ = try? await send("/api/logout", method: "POST", json: [:]) }

    // Signs in again once when the cookie has expired.
    func sessions() async throws -> [Session] {
        var (data, http) = try await send("/api/sessions")
        if http.statusCode == 401 {
            try await login()
            (data, http) = try await send("/api/sessions")
        }
        guard http.statusCode == 200 else { throw ServerError(message: "Polymux answered with an error (\(http.statusCode)).") }
        struct List: Decodable { let sessions: [Session] }
        return try JSONDecoder().decode(List.self, from: data).sessions
    }
}
