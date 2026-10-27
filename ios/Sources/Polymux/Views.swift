import SwiftUI
import PolymuxShared

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
                if let problem = problem ?? deck.signedOutBecause {
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
        deck.signedOutBecause = nil
        let c = Credentials(baseURL: base, password: password,
                            cfClientId: cfId.trimmingCharacters(in: .whitespaces), cfClientSecret: cfSecret.trimmingCharacters(in: .whitespaces))
        Task {
            problem = await deck.connect(c)
            busy = false
        }
    }
}
