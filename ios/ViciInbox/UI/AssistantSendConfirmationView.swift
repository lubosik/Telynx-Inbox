import SwiftUI
import UIKit

/// The last thing between an assistant and eight hundred phones.
///
/// WHAT THE ASSISTANT ACTUALLY DID
///   It called `request_campaign_send`, which reads a campaign and runs the
///   same eligibility evaluation the send itself will run, and returns the
///   numbers. It did not send, could not send, and holds no tool that sends.
///   The two requests that reach customers, approve and schedule, are made from
///   THIS view, by the app, after a face. That is the whole safety argument and
///   it only holds while this view is the only caller.
///
/// WHY THE BAD NUMBER IS AS LARGE AS THE GOOD ONE
///   A send to 41 of 900 people is almost always a broken audience rather than
///   a fact about the customers. A confirmation screen that shows 41 and hides
///   859 is how somebody sends the wrong campaign twice: once because they did
///   not see it, and again after somebody explains why the first one did
///   nothing. So the suppressed count is given the same weight, with the
///   reasons underneath in the order that matters.
///
/// FACE ID IS NOT AUTHENTICATION HERE
///   The person is signed in and the server has already decided what they may
///   do. This is a second, physical act between an intention and something that
///   cannot be taken back. A confirmation button on its own is one mis-tap from
///   a campaign, and a voice interface makes mis-taps likelier, not rarer.
struct AssistantSendConfirmationView: View {
    let confirmation: AssistantSendConfirmation

    @Environment(\.dismiss) private var dismiss
    @State private var isSending = false
    @State private var failure: String?
    @State private var didSend = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    counts
                    if let message = confirmation.message, !message.isEmpty {
                        messageCard(message)
                    }
                    if let reasons = confirmation.topReasons, !reasons.isEmpty {
                        suppression(reasons)
                    }
                    if confirmation.liveSendEnabled == false { brakeNotice }
                    if let failure { failureNotice(failure) }
                }
                .padding(20)
            }
            .navigationTitle(didSend ? "Scheduled" : "Confirm send")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(didSend ? "Done" : "Cancel") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) { sendBar }
        }
    }

    // MARK: - The numbers

    private var counts: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let name = confirmation.name, !name.isEmpty {
                Text(name)
                    .font(.headline)
            }
            HStack(spacing: 12) {
                countTile(value: confirmation.recipients,
                          label: confirmation.recipients == 1 ? "will receive it" : "will receive it",
                          tone: ViciTheme.tint)
                if confirmation.suppressed > 0 {
                    countTile(value: confirmation.suppressed,
                              label: "will not",
                              tone: .secondary)
                }
            }
            if let audience = confirmation.audience, !audience.isEmpty {
                Text(audience)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func countTile(value: Int, label: String, tone: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(value)")
                .font(.system(size: 34, weight: .semibold, design: .rounded))
                .foregroundStyle(tone)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color(.secondarySystemBackground)))
    }

    /// The exact text, not a summary of it. This is the last moment anybody can
    /// read what is about to be sent, and a paraphrase here would mean the
    /// thing confirmed and the thing sent were different objects.
    private func messageCard(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("The message")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(message)
                .font(.callout)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(RoundedRectangle(cornerRadius: 14).fill(Color(.secondarySystemBackground)))
        }
    }

    private func suppression(_ reasons: [AssistantSendConfirmation.SuppressionReason]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Why the rest are excluded")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(reasons) { reason in
                HStack(alignment: .firstTextBaseline) {
                    Text(reason.readable)
                        .font(.subheadline)
                    Spacer()
                    Text("\(reason.count)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var brakeNotice: some View {
        Label(
            "Live sending is switched off, so this will be scheduled and held until it is turned on.",
            systemImage: "pause.circle"
        )
        .font(.footnote)
        .foregroundStyle(.secondary)
    }

    private func failureNotice(_ text: String) -> some View {
        Label(text, systemImage: "exclamationmark.triangle")
            .font(.footnote)
            .foregroundStyle(ViciTheme.destructive)
    }

    // MARK: - Sending

    @ViewBuilder
    private var sendBar: some View {
        if !didSend {
            Button {
                Task { await confirmThenSend() }
            } label: {
                HStack(spacing: 8) {
                    if isSending { ProgressView().tint(.white) }
                    Text(isSending ? "Sending" : "Confirm with Face ID")
                }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .tint(ViciTheme.tint)
            .disabled(isSending)
            .padding(20)
            .background(.bar)
        }
    }

    private func confirmThenSend() async {
        failure = nil
        let people = confirmation.recipients == 1 ? "1 person" : "\(confirmation.recipients) people"
        // The prompt names the ACTION and its size. "Vici Inbox" would tell
        // somebody nothing at the one moment they are deciding.
        let outcome = await BiometricConfirmation.confirm(
            reason: "Send this campaign to \(people)"
        )
        // `.unavailable` proceeds. The device cannot ask, the person already
        // chose to open this screen and press the button, and a phone with no
        // passcode is not a reason somebody cannot run their business. Only an
        // actual decline stops it.
        guard outcome != .declined else { return }

        isSending = true
        defer { isSending = false }
        do {
            // Both requests, in this order, and both from here. Approving
            // freezes the audience and the revision; scheduling is what gives
            // it a time. Neither is reachable from the assistant.
            _ = try await APIClient.shared.approveCampaign(id: confirmation.campaignId)
            _ = try await APIClient.shared.scheduleCampaign(id: confirmation.campaignId,
                                                            scheduledFor: Date())
            didSend = true
        } catch {
            // Named plainly. The commonest real failure here is the audience
            // having changed since the assistant looked, and "something went
            // wrong" would send somebody to the wrong place to fix it.
            failure = (error as? APIError)?.errorDescription
                ?? "That could not be sent. Nothing has gone out."
        }
    }
}
