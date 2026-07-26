import SwiftUI

/// One-time login using the same shared inbox password the web app uses.
/// After this the password lives in the Keychain so a push-woken cold launch
/// can re-authenticate without any user interaction.
struct LoginView: View {
    @EnvironmentObject private var session: SessionModel
    @State private var password = ""
    @State private var isWorking = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            VStack(spacing: 8) {
                Image(systemName: "phone.circle.fill")
                    .font(.system(size: 56))
                    .foregroundStyle(.green)
                Text("Vici Inbox")
                    .font(.largeTitle.bold())
                Text("Sign in to receive calls")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            VStack(spacing: 12) {
                SecureField("Inbox password", text: $password)
                    .textContentType(.password)
                    .textFieldStyle(.roundedBorder)
                    .focused($focused)
                    .submitLabel(.go)
                    .onSubmit(submit)

                if let error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }

                Button(action: submit) {
                    if isWorking {
                        ProgressView().tint(.white).frame(maxWidth: .infinity)
                    } else {
                        Text("Sign in").bold().frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(.green)
                .controlSize(.large)
                .disabled(password.isEmpty || isWorking)
            }
            .padding(.horizontal, 32)

            Spacer()
            Spacer()
        }
        .onAppear { focused = true }
    }

    private func submit() {
        guard !password.isEmpty, !isWorking else { return }
        isWorking = true
        error = nil
        Task { @MainActor in
            do {
                try await session.signIn(password: password)
            } catch {
                self.error = error.localizedDescription
            }
            isWorking = false
        }
    }
}
