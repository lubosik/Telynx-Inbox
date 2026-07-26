import Foundation
import CallKit
import AVFoundation
import UIKit

/// Actions CallKit asks the voice layer to perform.
///
/// The CXAction objects are passed through rather than bare UUIDs because the
/// Telnyx SDK takes ownership of them: `answerFromCallkit(answerAction:)` and
/// `endCallFromCallkit(endAction:)` fulfil the action themselves once the
/// underlying SIP operation succeeds (or fail it on INVITE timeout). Fulfilling
/// them here as well would double-fulfil and desync the native call UI.
protocol CallKitActionHandler: AnyObject {
    func callKitAnswer(action: CXAnswerCallAction)
    func callKitEnd(action: CXEndCallAction)
    func callKitStartOutgoing(action: CXStartCallAction)
    func callKitSetMuted(uuid: UUID, muted: Bool)
    func callKitSetHeld(uuid: UUID, held: Bool)
    func callKitSendDTMF(uuid: UUID, digits: String)
    func callKitActivateAudioSession(_ session: AVAudioSession)
    func callKitDeactivateAudioSession(_ session: AVAudioSession)
    func callKitDidReset()
}

/// Owns the CXProvider and CXCallController — everything the OS needs to show a
/// real incoming-call screen, ring through the lock screen, and put the call in
/// Recents.
final class CallKitCoordinator: NSObject {

    static let shared = CallKitCoordinator()

    weak var actionHandler: CallKitActionHandler?

    private let provider: CXProvider
    private let callController = CXCallController()

    /// Calls reported to CallKit that have not yet ended.
    private(set) var activeCallUUIDs = Set<UUID>()

    private override init() {
        // The no-argument initialiser uses the app's display name automatically;
        // CXProviderConfiguration(localizedName:) is deprecated since iOS 14.
        let config = CXProviderConfiguration()
        config.supportsVideo = false
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        // Phone-number handles make Recents entries tappable to call back.
        config.supportedHandleTypes = [.phoneNumber, .generic]
        config.includesCallsInRecents = true
        if let icon = UIImage(named: "CallKitIcon") {
            config.iconTemplateImageData = icon.pngData()
        }
        self.provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    // MARK: - Inbound

    /// Reports an incoming call to the OS.
    ///
    /// MUST be called synchronously from `pushRegistry(_:didReceiveIncomingPushWith:for:)`.
    /// Since iOS 13 the system terminates the app if a VoIP push does not result
    /// in a reported call, and repeated offences stop VoIP push delivery entirely.
    ///
    /// - Important: `uuid` must be the UUID parsed from the push payload's
    ///   `metadata.call_id`. The SDK creates a placeholder Call keyed on that
    ///   same UUID, and answering only works if the two match.
    func reportIncomingCall(uuid: UUID,
                            callerName: String,
                            callerNumber: String,
                            completion: ((Error?) -> Void)? = nil) {

        let update = CXCallUpdate()
        // An empty CXHandle value can make reportNewIncomingCall fail outright,
        // which would mean no ring at all.
        let hasNumber = !callerNumber.trimmingCharacters(in: .whitespaces).isEmpty
        let hasName = !callerName.trimmingCharacters(in: .whitespaces).isEmpty
        let handleValue = hasNumber ? callerNumber : (hasName ? callerName : "Unknown")
        update.remoteHandle = CXHandle(type: hasNumber ? .phoneNumber : .generic,
                                       value: handleValue)
        update.localizedCallerName = hasName
            ? callerName
            : (hasNumber ? PhoneFormatter.pretty(callerNumber) : "Unknown caller")
        update.hasVideo = false
        update.supportsDTMF = true
        update.supportsHolding = true
        update.supportsGrouping = false
        update.supportsUngrouping = false

        activeCallUUIDs.insert(uuid)

        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            if let error {
                let nsError = error as NSError
                let alreadyExists = nsError.domain == CXErrorDomainIncomingCall
                    && nsError.code == CXErrorCodeIncomingCallError.callUUIDAlreadyExists.rawValue

                if alreadyExists {
                    // A duplicate report for a call we are already tracking.
                    // Keep the UUID: dropping it would block reportCallEnded
                    // later and leave an un-dismissable call on screen.
                    Log.voice("reportNewIncomingCall: \(uuid) already exists — keeping tracking")
                } else {
                    // e.g. the number is blocked, or Focus rejected the call.
                    self?.activeCallUUIDs.remove(uuid)
                    Log.voice("reportNewIncomingCall FAILED: \(error.localizedDescription)")
                }
            } else {
                Log.voice("reported incoming call \(uuid) from \(handleValue)")
            }
            completion?(error)
        }
    }

    /// Drops a UUID from tracking without reporting an end — used when an
    /// outbound call fails before it ever became a real call.
    ///
    /// Hops to main because callers include background Tasks, and
    /// `activeCallUUIDs` is main-confined everywhere else.
    func forgetCall(_ uuid: UUID) {
        if Thread.isMainThread {
            activeCallUUIDs.remove(uuid)
        } else {
            DispatchQueue.main.async { [weak self] in self?.activeCallUUIDs.remove(uuid) }
        }
    }

    /// Updates the name on an already-ringing call, for when the contact name
    /// resolves slightly after the push arrives.
    func updateCall(uuid: UUID, callerName: String, callerNumber: String) {
        let update = CXCallUpdate()
        update.localizedCallerName = callerName
        if !callerNumber.isEmpty {
            update.remoteHandle = CXHandle(type: .phoneNumber, value: callerNumber)
        }
        provider.reportCall(with: uuid, updated: update)
    }

    // MARK: - Outbound

    /// - Parameter onFailure: called when the transaction is rejected outright,
    ///   in which case `CXStartCallAction` never reaches the provider and the
    ///   caller must clean up its own state or it leaves a phantom call.
    func startOutgoingCall(uuid: UUID, handle: String, onFailure: (() -> Void)? = nil) {
        let action = CXStartCallAction(call: uuid, handle: CXHandle(type: .phoneNumber, value: handle))
        action.isVideo = false
        callController.request(CXTransaction(action: action)) { error in
            guard let error else { return }
            Log.voice("startOutgoingCall rejected: \(error.localizedDescription)")
            DispatchQueue.main.async {
                CallKitCoordinator.shared.forgetCall(uuid)
                onFailure?()
            }
        }
    }

    func reportOutgoingCallStartedRinging(uuid: UUID) {
        provider.reportOutgoingCall(with: uuid, startedConnectingAt: Date())
    }

    func reportOutgoingCallConnected(uuid: UUID) {
        provider.reportOutgoingCall(with: uuid, connectedAt: Date())
    }

    // MARK: - Ending

    /// Ends a call from our side: remote hangup, or answered on another device.
    /// This is what dismisses the native call UI.
    func reportCallEnded(uuid: UUID, reason: CXCallEndedReason = .remoteEnded) {
        guard activeCallUUIDs.contains(uuid) else { return }
        activeCallUUIDs.remove(uuid)
        provider.reportCall(with: uuid, endedAt: Date(), reason: reason)
        Log.voice("reported call \(uuid) ended (reason \(reason.rawValue))")
    }

    /// Ends a call because the user tapped hang up inside our own UI.
    func requestEndCall(uuid: UUID) {
        callController.request(CXTransaction(action: CXEndCallAction(call: uuid))) { error in
            if let error { Log.voice("requestEndCall failed: \(error.localizedDescription)") }
        }
    }

    func requestSetMuted(uuid: UUID, muted: Bool) {
        callController.request(CXTransaction(action: CXSetMutedCallAction(call: uuid, muted: muted))) { _ in }
    }

    func requestSetHeld(uuid: UUID, held: Bool) {
        callController.request(CXTransaction(action: CXSetHeldCallAction(call: uuid, onHold: held))) { _ in }
    }

    /// Safety net: if the SDK never produces a real call for a push we already
    /// reported, end it so the phone does not ring forever.
    func endAllCalls(reason: CXCallEndedReason = .failed) {
        activeCallUUIDs.forEach { provider.reportCall(with: $0, endedAt: Date(), reason: reason) }
        activeCallUUIDs.removeAll()
    }
}

// MARK: - CXProviderDelegate

extension CallKitCoordinator: CXProviderDelegate {

    func providerDidReset(_ provider: CXProvider) {
        Log.voice("CXProvider reset — tearing down all calls")
        activeCallUUIDs.removeAll()
        actionHandler?.callKitDidReset()
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        Log.voice("CallKit: answer \(action.callUUID)")
        // Do NOT fulfil — the SDK fulfils this action when the answer succeeds.
        // It is safe to answer before the socket has reattached: the SDK stashes
        // the action and auto-answers once the INVITE arrives.
        actionHandler?.callKitAnswer(action: action)
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        Log.voice("CallKit: end \(action.callUUID)")
        activeCallUUIDs.remove(action.callUUID)
        // Do NOT fulfil — the SDK fulfils this one too.
        actionHandler?.callKitEnd(action: action)
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        Log.voice("CallKit: start outgoing \(action.callUUID)")
        // Track here rather than in the request completion: this runs on the
        // provider queue before the handler, so there is no ordering race with
        // a fast-failing forgetCall.
        activeCallUUIDs.insert(action.callUUID)
        actionHandler?.callKitStartOutgoing(action: action)
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        actionHandler?.callKitSetMuted(uuid: action.callUUID, muted: action.isMuted)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
        actionHandler?.callKitSetHeld(uuid: action.callUUID, held: action.isOnHold)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXPlayDTMFCallAction) {
        actionHandler?.callKitSendDTMF(uuid: action.callUUID, digits: action.digits)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
        Log.voice("CallKit action timed out: \(type(of: action))")
        action.fulfill()
    }

    /// The SDK does not activate the audio session itself under CallKit — audio
    /// must be handed over here or the call connects silent.
    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        Log.voice("CallKit: audio session activated")
        actionHandler?.callKitActivateAudioSession(audioSession)
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        Log.voice("CallKit: audio session deactivated")
        actionHandler?.callKitDeactivateAudioSession(audioSession)
    }
}
