import AppIntents
import PolymuxShared

// Siri and Shortcuts: start a Deep Session, and ask what needs you. They run in the background
// with the app's sign-in; the long-press quick actions are in ios-ota.infoplist.json.

private func server() throws -> Server {
    guard let c = Credentials.stored else { throw ServerError(message: "Open Polymux and sign in first.") }
    return Server(creds: c)
}

// A folder to start a session in: the running sessions' folders, then History's.
struct FolderEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Folder"
    static let defaultQuery = FolderQuery()
    let id: String
    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\((id as NSString).lastPathComponent)", subtitle: "\(id)")
    }
}

struct FolderQuery: EntityQuery {
    func entities(for ids: [String]) async throws -> [FolderEntity] { ids.map(FolderEntity.init) }
    func suggestedEntities() async throws -> [FolderEntity] {
        let s = try server()
        return try await s.folders(s.sessions()).prefix(20).map(FolderEntity.init)
    }
}

struct NewSessionIntent: AppIntent {
    static let title: LocalizedStringResource = "New Deep Session"
    static let description = IntentDescription("Start a Claude session in a folder, with what to work on.")
    @Parameter(title: "Folder", requestValueDialog: "Which folder?")
    var folder: FolderEntity
    @Parameter(title: "Prompt", requestValueDialog: "What should it work on?")
    var prompt: String
    func perform() async throws -> some IntentResult & ProvidesDialog {
        _ = try await server().create(dir: folder.id, prompt: prompt)
        return .result(dialog: "Started a Deep Session in \((folder.id as NSString).lastPathComponent).")
    }
}

struct NeedsYouIntent: AppIntent {
    static let title: LocalizedStringResource = "What needs me"
    static let description = IntentDescription("The Deep Sessions waiting on you, and how many are working.")
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let all = try await server().sessions()
        let waiting = all.filter(\.needsYou), working = all.filter(\.working).count
        let busy = working == 0 ? "" : " \(working) working."
        guard !waiting.isEmpty else { return .result(dialog: "Nothing needs you.\(busy)") }
        let names = waiting.prefix(3).map(\.label).joined(separator: ", ")
        let more = waiting.count > 3 ? " and \(waiting.count - 3) more" : ""
        return .result(dialog: "\(waiting.count) need\(waiting.count == 1 ? "s" : "") you: \(names)\(more).\(busy)")
    }
}

struct PolymuxShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: NewSessionIntent(),
                    phrases: ["New \(.applicationName) session", "Start a \(.applicationName) session"],
                    shortTitle: "New session", systemImageName: "plus.square")
        AppShortcut(intent: NeedsYouIntent(),
                    phrases: ["What needs me in \(.applicationName)", "\(.applicationName) needs you"],
                    shortTitle: "What needs me", systemImageName: "exclamationmark.bubble")
    }
}
