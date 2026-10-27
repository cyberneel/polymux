import SwiftUI
import UIKit
import UniformTypeIdentifiers
import PolymuxShared

// Share sheet → a Deep Session: text and links become the message, files are uploaded to the
// session's folder and named in it. Into a running session, or a new one in a recent folder.
@objc(ShareViewController)
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        let host = UIHostingController(rootView: ShareView(providers: providers) { [weak self] sent in
            if sent { self?.extensionContext?.completeRequest(returningItems: nil) }
            else { self?.extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError)) }
        })
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }
}

enum Target: Hashable {
    case session(Session)
    case folder(String)
    var dir: String? { switch self { case .session(let s): s.dir; case .folder(let d): d } }
}

struct ShareView: View {
    let providers: [NSItemProvider]
    let finish: (Bool) -> Void
    @State private var texts: [String] = []
    @State private var files: [URL] = []
    @State private var sessions: [Session] = []
    @State private var folders: [String] = []
    @State private var target: Target?
    @State private var note = ""
    @State private var loading = true
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Sharing") {
                    ForEach(texts, id: \.self) { Text($0).lineLimit(3).foregroundStyle(Color.inkDim) }
                    ForEach(files, id: \.self) { Label($0.lastPathComponent, systemImage: "doc") }
                    TextField("Add a note (optional)", text: $note, axis: .vertical).lineLimit(1...5)
                }
                if let problem { Text(problem).foregroundStyle(Color.redPencil) }
                if loading { ProgressView().frame(maxWidth: .infinity) }
                if !sessions.isEmpty {
                    Section("Send to a running session") {
                        ForEach(sessions) { s in
                            pick(.session(s), s.label, s.needsYou ? "Needs you" : s.dir.map { ($0 as NSString).lastPathComponent })
                        }
                    }
                }
                if !folders.isEmpty {
                    Section("Or start a new one in") {
                        ForEach(folders.prefix(12), id: \.self) { pick(.folder($0), ($0 as NSString).lastPathComponent, $0) }
                    }
                }
            }
            .navigationTitle("Polymux")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { finish(false) } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy { ProgressView() } else { Button("Send") { Task { await send() } }.disabled(target == nil) }
                }
            }
        }
        .tint(.plum)
        .task { await load() }
    }

    private func pick(_ t: Target, _ title: String, _ detail: String?) -> some View {
        Button { target = t } label: {
            HStack {
                VStack(alignment: .leading) {
                    Text(title).foregroundStyle(Color.ink)
                    if let detail { Text(detail).font(.caption).foregroundStyle(Color.inkDim).lineLimit(1) }
                }
                Spacer()
                if target == t { Image(systemName: "checkmark").foregroundStyle(Color.plum) }
            }
        }
    }

    private func load() async {
        defer { loading = false }
        for p in providers {
            let isFile = p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
            if !isFile, p.hasItemConformingToTypeIdentifier(UTType.url.identifier), let u = await link(p) { texts.append(u); continue }
            if !isFile, p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), let s = await text(p) { texts.append(s); continue }
            if let type = p.registeredTypeIdentifiers.first, let f = await copy(p, type) { files.append(f) }
        }
        guard let c = Credentials.stored else { problem = "Open Polymux and sign in first."; return }
        do {
            let s = Server(creds: c)
            sessions = try await s.sessions()
            folders = try await s.folders(sessions)
        } catch { problem = error.localizedDescription }
    }

    private func send() async {
        guard let target, let c = Credentials.stored else { return }
        busy = true
        defer { busy = false }
        problem = nil
        do {
            let s = Server(creds: c)
            var parts = [note.trimmingCharacters(in: .whitespacesAndNewlines)] + texts
            if !files.isEmpty {
                guard let dir = target.dir else { throw ServerError(message: "That session has no folder to put the files in.") }
                let names = try await s.upload(files, to: dir)
                parts.append("Shared file\(names.count == 1 ? "" : "s") (in \(dir)): " + names.joined(separator: ", "))
            }
            let message = parts.filter { !$0.isEmpty }.joined(separator: "\n\n")
            switch target {
            case .session(let x): try await s.send(message, to: x.name)
            case .folder(let d): _ = try await s.create(dir: d, prompt: message)
            }
            finish(true)
        } catch { problem = error.localizedDescription }
    }
}

// NSItemProvider hands things over on its own queue; these bring them back as plain values.
@MainActor private func link(_ p: NSItemProvider) async -> String? {
    await withCheckedContinuation { k in _ = p.loadObject(ofClass: URL.self) { u, _ in k.resume(returning: u?.absoluteString) } }
}
@MainActor private func text(_ p: NSItemProvider) async -> String? {
    await withCheckedContinuation { k in _ = p.loadObject(ofClass: String.self) { s, _ in k.resume(returning: s) } }
}
// The provider deletes its file when the handler returns, so copy it out first.
// ponytail: whole files ride in memory to upload; fine for photos and documents, not for videos near the extension's ~120MB limit.
@MainActor private func copy(_ p: NSItemProvider, _ type: String) async -> URL? {
    let suggested = p.suggestedName
    return await withCheckedContinuation { k in
        _ = p.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
            guard let url else { return k.resume(returning: nil) }
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            var name = suggested ?? url.lastPathComponent
            if (name as NSString).pathExtension.isEmpty, !url.pathExtension.isEmpty { name += "." + url.pathExtension }
            let dest = dir.appendingPathComponent(name)
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                try FileManager.default.copyItem(at: url, to: dest)
                k.resume(returning: dest)
            } catch { k.resume(returning: nil) }
        }
    }
}
