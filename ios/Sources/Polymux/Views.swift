import SwiftUI

// Sign in: server address + password, and a Cloudflare Access service token when the server sits
// behind Access. Any Polymux server works (self-hosted or a hosted tenant).
struct ConnectView: View {
    @Environment(Deck.self) private var deck
    @State private var address = Keychain.get("baseURL") ?? ""
    @State private var password = ""
    @State private var cfId = ""
    @State private var cfSecret = ""
    @State private var showAccess = false
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Polymux").font(.sans(.largeTitle).weight(.semibold))
                Text("Sign in to your Polymux server.").foregroundStyle(Color.inkDim)
                field("Server address") {
                    TextField("", text: $address, prompt: Text("polymux.example.com"))
                        .keyboardType(.URL).textContentType(.URL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                field("Password") { SecureField("", text: $password).textContentType(.password).onSubmit(go) }
                if showAccess {
                    field("Access client id") { TextField("", text: $cfId).textInputAutocapitalization(.never).autocorrectionDisabled() }
                    field("Access client secret") { SecureField("", text: $cfSecret) }
                } else {
                    Button("Add a Cloudflare Access service token") { showAccess = true }
                        .font(.sans(.footnote)).foregroundStyle(Color.ink).underline()
                }
                if let problem {
                    Text(problem).font(.sans(.footnote)).foregroundStyle(Color.redPencil).accessibilityAddTraits(.updatesFrequently)
                }
                Button(busy ? "Connecting…" : "Connect", action: go)
                    .buttonStyle(SquareButton(primary: true))
                    .disabled(busy || address.isEmpty || password.isEmpty)
            }
            .padding(24)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .background(Color.paper)
    }

    private func field(_ label: String, @ViewBuilder _ input: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.sans(.footnote)).foregroundStyle(Color.inkDim)
            input().padding(.horizontal, 12).frame(minHeight: 44)
                .overlay(Rectangle().strokeBorder(Color.inkDim, lineWidth: 1))
        }
    }

    private func go() {
        guard !busy else { return }
        guard let base = serverAddress(address) else { problem = "That isn't a server address."; return }
        busy = true
        problem = nil
        let c = Credentials(baseURL: base, password: password,
                            cfClientId: cfId.trimmingCharacters(in: .whitespaces), cfClientSecret: cfSecret.trimmingCharacters(in: .whitespaces))
        Task {
            problem = await deck.connect(c)
            busy = false
        }
    }
}

// The Deep Sessions list beside (iPad) or above (iPhone) the open terminal. Polls every 4s while
// the app is in front; the app icon badge carries the needs-you count.
struct SessionsView: View {
    @Environment(Deck.self) private var deck
    @Environment(\.scenePhase) private var phase

    var body: some View {
        @Bindable var deck = deck
        NavigationSplitView {
            List(selection: $deck.selection) {
                if let p = deck.problem {
                    Text(p).font(.sans(.footnote)).foregroundStyle(Color.redPencil).listRowBackground(Color.paper)
                }
                ForEach(deck.sessions) { s in
                    SessionRow(s: s).tag(s.name).listRowBackground(deck.selection == s.name ? Color.sheet : Color.paper)
                }
                if deck.loaded && deck.sessions.isEmpty && deck.problem == nil {
                    Text("No Deep Sessions running.").foregroundStyle(Color.inkDim).listRowBackground(Color.paper)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color.paper)
            .refreshable { await deck.refresh() }
            .overlay { if !deck.loaded { ProgressView() } }
            .navigationTitle("Deep Sessions")
            .toolbar {
                Menu {
                    Button("Sign out", role: .destructive) { deck.signOut() }
                } label: { Image(systemName: "ellipsis").accessibilityLabel("More") }
            }
        } detail: {
            if let name = deck.selection {
                TerminalView(name: name)
            } else {
                Text("Pick a Deep Session.").foregroundStyle(Color.inkDim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity).background(Color.paper)
            }
        }
        .task(id: phase) {
            guard phase == .active else { return }
            while !Task.isCancelled {
                await deck.refresh()
                try? await Task.sleep(for: .seconds(4))
            }
        }
    }
}

struct SessionRow: View {
    let s: Session
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(s.displayTitle).font(.sans(.body).weight(s.needsYou ? .semibold : .medium)).lineLimit(1)
                Spacer(minLength: 8)
                if let t = s.lastActive {
                    Text(t.formatted(.relative(presentation: .numeric, unitsStyle: .abbreviated)))
                        .font(.mono(.caption2)).foregroundStyle(Color.inkDim).lineLimit(1)
                }
            }
            HStack(spacing: 10) {
                status
                Text(s.shortDir).font(.sans(.footnote)).foregroundStyle(Color.inkDim).lineLimit(1).truncationMode(.head)
            }
        }
        .padding(.vertical, 6)
    }

    @ViewBuilder private var status: some View {
        switch s.status {
        case .needs(let label): StatusDot(label: label, color: .redPencil, text: .redPencil)
        case .working: StatusDot(label: "working", color: .ink, pulse: true)
        case .ready: StatusDot(label: "ready", color: .ink)
        case .running: StatusDot(label: "running", color: .ink, pulse: true)
        case .stopped: StatusDot(label: "stopped", color: .inkDim, text: .inkDim)
        }
    }
}
