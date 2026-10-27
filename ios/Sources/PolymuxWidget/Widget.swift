import SwiftUI
import WidgetKit
import PolymuxShared

// Home Screen and Lock Screen: how many Deep Sessions need you, which, and what's working. A tap
// opens that session (or the newest one that needs you). The app reloads these when the count
// changes and when a push lands; otherwise every 15 minutes.

@main
struct PolymuxWidgets: WidgetBundle {
    var body: some Widget { SessionsWidget() }
}

struct SessionsEntry: TimelineEntry {
    let date: Date
    let sessions: [Session]?   // nil: couldn't fetch
    let problem: String?
    var waiting: [Session] { sessions?.filter(\.needsYou) ?? [] }
    var working: Int { sessions?.filter(\.working).count ?? 0 }
    // Needs you first, then the most recently active.
    var ordered: [Session] {
        (sessions ?? []).sorted { ($0.needsYou ? 1 : 0, $0.lastActivity ?? 0) > ($1.needsYou ? 1 : 0, $1.lastActivity ?? 0) }
    }
}

private let sample = SessionsEntry(date: .now, sessions: [
    Session(name: "a", title: "auth refactor", dir: nil, waitingFor: "Allow edit to src/auth.js?", claudeStatus: "idle", lastActivity: Date.now.timeIntervalSince1970 * 1000),
    Session(name: "b", title: "widget polish", dir: nil, waitingFor: nil, claudeStatus: "busy", lastActivity: Date.now.timeIntervalSince1970 * 1000 - 60_000),
    Session(name: "c", title: "release notes", dir: nil, waitingFor: nil, claudeStatus: "idle", lastActivity: Date.now.timeIntervalSince1970 * 1000 - 3_600_000),
], problem: nil)

private struct SendBox<T>: @unchecked Sendable { let v: T; init(_ v: T) { self.v = v } }

struct Provider: TimelineProvider {
    func placeholder(in c: Context) -> SessionsEntry { sample }
    func getSnapshot(in c: Context, completion: @escaping (SessionsEntry) -> Void) {
        if c.isPreview { return completion(sample) }
        let done = SendBox(completion)
        Task { done.v(await fetch()) }
    }
    func getTimeline(in c: Context, completion: @escaping (Timeline<SessionsEntry>) -> Void) {
        let done = SendBox(completion)
        Task { done.v(Timeline(entries: [await fetch()], policy: .after(.now.addingTimeInterval(15 * 60)))) }
    }
    private func fetch() async -> SessionsEntry {
        guard let c = Credentials.stored else { return SessionsEntry(date: .now, sessions: nil, problem: "Open Polymux to sign in.") }
        do { return SessionsEntry(date: .now, sessions: try await Server(creds: c).sessions(), problem: nil) }
        catch { return SessionsEntry(date: .now, sessions: nil, problem: error.localizedDescription) }
    }
}

struct SessionsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.cyberneel.polymux.sessions", provider: Provider()) { SessionsView(entry: $0) }
            .configurationDisplayName("Deep Sessions")
            .description("Which sessions need you, and what's working.")
            .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct SessionsView: View {
    @Environment(\.widgetFamily) private var family
    let entry: SessionsEntry
    private var n: Int { entry.waiting.count }

    var body: some View {
        content
            .containerBackground(for: .widget) { Color.paper }
            .widgetURL(URL(string: "polymux://needs"))   // rows link to their own session
    }

    @ViewBuilder private var content: some View {
        switch family {
        case .accessoryInline:
            Text(entry.sessions == nil ? "Polymux" : n == 0 ? "Nothing needs you" : "\(n) need\(n == 1 ? "s" : "") you")
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Text(entry.sessions == nil ? "–" : "\(n)").font(.title2.weight(.semibold))
                    Text("need you").font(.system(size: 9))
                }
            }
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                Text("Polymux").font(.headline)
                if let p = entry.problem { Text(p).font(.caption).lineLimit(2) }
                else {
                    Text(n == 0 ? "Nothing needs you" : "\(n) need\(n == 1 ? "s" : "") you").font(.caption)
                    Text(entry.waiting.first?.label ?? "\(entry.working) working").font(.caption).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .systemSmall:
            VStack(alignment: .leading, spacing: 2) {
                Text("Polymux").font(.caption.weight(.semibold)).foregroundStyle(Color.inkDim)
                Spacer()
                if let p = entry.problem { Text(p).font(.caption).foregroundStyle(Color.ink) }
                else {
                    Text("\(n)").font(.system(size: 44, weight: .semibold)).foregroundStyle(n > 0 ? Color.redPencil : .ink)
                    Text(n == 1 ? "needs you" : "need you").font(.callout).foregroundStyle(Color.ink)
                    Text("\(entry.working) working").font(.caption).foregroundStyle(Color.inkDim)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        default:
            list(rows: family == .systemLarge ? 7 : 3)
        }
    }

    private func list(rows: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Polymux").font(.caption.weight(.semibold))
                Spacer()
                if entry.sessions != nil {
                    Text("\(n) need you · \(entry.working) working").font(.caption).foregroundStyle(n > 0 ? Color.redPencil : .inkDim)
                }
            }
            if let p = entry.problem { Text(p).font(.callout) }
            else if entry.ordered.isEmpty { Text("No Deep Sessions running.").font(.callout).foregroundStyle(Color.inkDim) }
            ForEach(entry.ordered.prefix(rows)) { s in
                Link(destination: s.link) { row(s) }
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(Color.ink)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func row(_ s: Session) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle().fill(s.needsYou ? Color.redPencil : s.working ? Color.plum : Color.inkDim.opacity(0.4)).frame(width: 7, height: 7)
            VStack(alignment: .leading, spacing: 0) {
                Text(s.label).font(.callout.weight(s.needsYou ? .semibold : .regular)).lineLimit(1)
                if let w = s.waitingFor, s.needsYou { Text(w).font(.caption).foregroundStyle(Color.inkDim).lineLimit(1) }
            }
            Spacer(minLength: 4)
            if let d = s.lastActive, !s.needsYou {
                Text(d, style: .relative).font(.caption2).foregroundStyle(Color.inkDim).monospacedDigit().lineLimit(1).frame(maxWidth: 70, alignment: .trailing)
            }
        }
    }
}
