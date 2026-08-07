import Foundation
import CallKit
import AVFoundation
import PushKit
import TelnyxRTC

protocol VoiceManagerObserver: AnyObject {
    func voiceManager(_ manager: TelnyxVoiceManager, didUpdate call: ActiveCall?)
    func voiceManager(_ manager: TelnyxVoiceManager, didChangeReadiness ready: Bool, status: String)
}

/// Owns the Telnyx SIP client and bridges it to CallKit.
///
/// Lifecycle for an incoming call with the app terminated:
///   1. Telnyx sends a VoIP push (no device is on the socket).
///   2. iOS relaunches the app in the background and hands us the payload.
///   3. `handleVoIPPush` parses `metadata.call_id`, calls `processVoIPNotification`
///      to start reattaching the socket, then reports the call to CallKit.
///   4. The phone rings natively. Answering is safe even before the socket is
///      back — the SDK stashes the answer action and applies it on INVITE.
///
/// Threading: all mutable state is confined to the main queue. Both PKPushRegistry
/// and the CXProvider already deliver on main; the SDK's delegate callbacks arrive
/// on its socket thread, so each one hops to main before touching state.
final class TelnyxVoiceManager: NSObject {

    static let shared = TelnyxVoiceManager()

    weak var observer: VoiceManagerObserver?

    private let telnyxClient = TxClient()

    /// Hex APNs VoIP token. Persisted because it must be supplied on every
    /// login, including logins triggered by a cold launch from a push.
    private(set) var pushDeviceToken: String? {
        get { UserDefaults.standard.string(forKey: "voip_push_token") }
        set { UserDefaults.standard.set(newValue, forKey: "voip_push_token") }
    }

    private(set) var currentCall: ActiveCall? {
        didSet { notifyCallChanged() }
    }

    private(set) var isReady = false {
        didSet { notifyReadinessChanged() }
    }

    private var statusText = "Disconnected" {
        didSet { notifyReadinessChanged() }
    }

    /// True only after `onClientReady` for a login configuration that included
    /// a PushKit token. A socket can be ready without push registration, which
    /// is not sufficient for background incoming calls.
    private(set) var connectedWithPushToken = false
    private var pendingLoginIncludedPushToken = false
    /// Credentials used for the current socket. This lets a foreground refresh
    /// rotate away from a retired/web-exposed SIP user without needlessly
    /// reconnecting when the backend value is unchanged.
    private var connectedCredentials: SIPCredentials?

    /// Ends the CallKit UI if a push-woken call never produces a real INVITE.
    private var pushCallWatchdog: DispatchWorkItem?

    /// Waiters for `onClientReady`, used so outbound calls don't dial before
    /// the client has actually registered with Telnyx.
    private final class ReadyWaiter {
        let continuation: CheckedContinuation<Bool, Never>
        var resumed = false
        init(_ continuation: CheckedContinuation<Bool, Never>) { self.continuation = continuation }
    }
    private var readyWaiters: [ReadyWaiter] = []
    /// Waiters for the `onPushDisabled` acknowledgement during sign-out.
    private var pushDisableWaiters: [ReadyWaiter] = []

    private override init() {
        super.init()
        telnyxClient.delegate = self
        CallKitCoordinator.shared.actionHandler = self
    }

    var readiness: (ready: Bool, status: String) { (isReady, statusText) }
    var pushDiagnostics: (hasToken: Bool, registeredLogin: Bool, environment: String) {
        (pushDeviceToken?.isEmpty == false,
         connectedWithPushToken,
         AppConfig.pushEnvironmentIsProduction ? "Production" : "Sandbox")
    }

    // MARK: - Main-queue helpers

    /// Runs `work` on the main queue, synchronously if already there. Used by
    /// the SDK delegate callbacks, which arrive off-main.
    private func onMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
    }

    private func notifyCallChanged() {
        let snapshot = currentCall
        onMain { [weak self] in
            guard let self else { return }
            self.observer?.voiceManager(self, didUpdate: snapshot)
        }
    }

    private func notifyReadinessChanged() {
        let ready = isReady
        let status = statusText
        onMain { [weak self] in
            guard let self else { return }
            self.observer?.voiceManager(self, didChangeReadiness: ready, status: status)
        }
    }

    // MARK: - Push token

    func updatePushToken(_ token: String) {
        onMain { [weak self] in
            guard let self, token != self.pushDeviceToken else { return }
            self.pushDeviceToken = token
            Log.push("VoIP token updated: \(token.prefix(12))…")
            // Re-login so Telnyx associates the new token with this SIP user.
            Task { await self.connectIfPossible(force: true) }
        }
    }

    func invalidatePushToken() {
        onMain { [weak self] in
            self?.pushDeviceToken = nil
            self?.connectedWithPushToken = false
            self?.setStatus("Waiting for VoIP token…", ready: false)
        }
    }

    /// Unregisters this device from push and waits for the server's
    /// acknowledgement.
    ///
    /// Must run while the socket is still up, because the disable message
    /// travels over that socket. Awaiting the ack matters: disconnecting
    /// immediately can tear the socket down before the message is sent, which
    /// leaves Telnyx pushing to a signed-out device.
    func disablePushNotificationsAndWait(timeout: TimeInterval = 2) async {
        guard telnyxClient.isConnected() else {
            onMain { [weak self] in self?.pushDeviceToken = nil }
            return
        }

        telnyxClient.disablePushNotifications()

        _ = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            onMain { [weak self] in
                guard let self else { cont.resume(returning: false); return }
                let waiter = ReadyWaiter(cont)
                self.pushDisableWaiters.append(waiter)
                DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
                    // Resume without depending on `self` — a nil self here
                    // would otherwise leak the continuation and hang sign-out.
                    guard !waiter.resumed else { return }
                    Log.push("disablePushNotifications: no ack within \(timeout)s — continuing")
                    waiter.resumed = true
                    self?.pushDisableWaiters.removeAll { $0 === waiter }
                    waiter.continuation.resume(returning: false)
                }
            }
        }

        onMain { [weak self] in self?.pushDeviceToken = nil }
    }

    // MARK: - Microphone

    /// Resolve microphone permission up front. If it is still undetermined when
    /// a call is answered from the lock screen, iOS cannot show a prompt and the
    /// call connects with no microphone.
    func requestMicrophonePermissionIfNeeded() async {
        let session = AVAudioSession.sharedInstance()
        guard session.recordPermission == .undetermined else { return }
        _ = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            session.requestRecordPermission { granted in
                Log.voice("microphone permission granted: \(granted)")
                cont.resume(returning: granted)
            }
        }
    }

    // MARK: - Connect

    /// Connects the SIP client so the app can receive calls in the foreground
    /// and so Telnyx registers this device's push token.
    ///
    /// The token is only registered during a successful login, so the app must
    /// connect at least once in the foreground before pushes work.
    ///
    /// - Note: returns once the connection has been *initiated*. Use
    ///   `waitUntilReady()` before doing anything that needs registration.
    @discardableResult
    func connectIfPossible(force: Bool = false) async -> Bool {
        guard let creds = await resolveCredentials() else {
            setStatus("Not signed in", ready: false)
            return false
        }

        if telnyxClient.isConnected() {
            let credentialsChanged = connectedCredentials != creds
            guard force || credentialsChanged else { return true }

            // Never tear down media while a CallKit call is in progress. The
            // fresh value is already in Keychain and will be adopted on the
            // next foreground/connect attempt.
            if let currentCall, currentCall.phase != .ended { return true }

            // Reconnecting over a live socket is undefined in the SDK.
            telnyxClient.disconnect()
        }

        // A successful SIP socket without a PushKit token looks healthy but
        // cannot wake the app for background calls. Wait for PushKit; its
        // update callback immediately retries this connection.
        guard pushDeviceToken?.isEmpty == false else {
            connectedWithPushToken = false
            setStatus("Waiting for VoIP token…", ready: false)
            return false
        }

        do {
            let config = makeTxConfig(creds: creds)
            pendingLoginIncludedPushToken = pushDeviceToken?.isEmpty == false
            setStatus("Connecting…", ready: false)
            try telnyxClient.connect(txConfig: config)
            connectedCredentials = creds
            return true
        } catch {
            Log.voice("connect failed: \(error.localizedDescription)")
            setStatus("Connection failed", ready: false)
            return false
        }
    }

    /// Waits for `onClientReady`. Returns false on error or timeout.
    ///
    /// No fast-path read of `isReady` here: callers may be on a background
    /// Task, and that state is main-confined. The recheck inside `onMain`
    /// covers the already-ready case.
    func waitUntilReady(timeout: TimeInterval = 10) async -> Bool {
        await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            onMain { [weak self] in
                guard let self else { cont.resume(returning: false); return }
                if self.isReady { cont.resume(returning: true); return }

                let waiter = ReadyWaiter(cont)
                self.readyWaiters.append(waiter)
                DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
                    self?.resolveReadyWaiter(waiter, value: false)
                }
            }
        }
    }

    /// Resolves a single waiter at most once. Main queue only.
    private func resolveReadyWaiter(_ waiter: ReadyWaiter, value: Bool) {
        guard !waiter.resumed else { return }
        waiter.resumed = true
        readyWaiters.removeAll { $0 === waiter }
        waiter.continuation.resume(returning: value)
    }

    private func resolveAllReadyWaiters(_ value: Bool) {
        let waiters = readyWaiters
        readyWaiters.removeAll()
        for waiter in waiters where !waiter.resumed {
            waiter.resumed = true
            waiter.continuation.resume(returning: value)
        }
    }

    /// Main queue only.
    private func resolveAllPushDisableWaiters(_ value: Bool) {
        let waiters = pushDisableWaiters
        pushDisableWaiters.removeAll()
        for waiter in waiters where !waiter.resumed {
            waiter.resumed = true
            waiter.continuation.resume(returning: value)
        }
    }

    func disconnect() {
        telnyxClient.disconnect()
        connectedWithPushToken = false
        connectedCredentials = nil
        setStatus("Disconnected", ready: false)
    }

    private func setStatus(_ text: String, ready: Bool) {
        onMain { [weak self] in
            guard let self else { return }
            self.isReady = ready
            self.statusText = text
        }
    }

    private func resolveCredentials() async -> SIPCredentials? {
        // Foreground connections must observe a backend credential rotation.
        // Push-woken launches do not use this method; startSDKForPush reads the
        // Keychain synchronously so CallKit can be reported immediately.
        if let fresh = try? await APIClient.shared.fetchSIPCredentials(allowCachedFallback: false) {
            return fresh
        }
        return CredentialStore.cachedSIPCredentials
    }

    private func makeTxConfig(creds: SIPCredentials) -> TxConfig {
        #if DEBUG
        let level: LogLevel = .info
        #else
        let level: LogLevel = .none
        #endif

        return TxConfig(
            sipUser: creds.login,
            password: creds.password,
            pushDeviceToken: pushDeviceToken,
            // Pinned to the build type: a mismatch here is the classic
            // "the push never arrives" bug.
            pushEnvironment: AppConfig.pushEnvironmentIsProduction ? .production : .debug,
            logLevel: level,
            reconnectClient: true,
            // Foreground calls arrive on the live socket and are still reported
            // through CallKit by onIncomingCall. PushKit is reserved for the
            // background/terminated path to avoid a socket-replacement race.
            pushWhenActive: AppConfig.pushWhenActive
        )
    }

    // MARK: - Incoming VoIP push

    /// Handles a VoIP push. Reports to CallKit on every path — including
    /// malformed payloads and missing credentials — because iOS terminates the
    /// app if a VoIP push does not produce a reported call.
    func handleVoIPPush(payload: PKPushPayload) {
        let dictionary = payload.dictionaryPayload
        let metadata = dictionary["metadata"] as? [String: Any]
        let aps = dictionary["aps"] as? [String: Any]
        let alert: String? = {
            if let text = aps?["alert"] as? String { return text }
            if let object = aps?["alert"] as? [String: Any] { return object["body"] as? String }
            return nil
        }()

        // Telnyx sends cleanup pushes to the other registered devices after a
        // call was answered elsewhere or became missed. Treating these as new
        // invites leaves a phantom CallKit screen behind.
        if alert == "Answered Elsewhere" || alert == "Missed call!" {
            handleCleanupPush(metadata: metadata, answeredElsewhere: alert == "Answered Elsewhere")
            return
        }
        handleVoIPPush(metadata: metadata)
    }

    private func handleCleanupPush(metadata: [String: Any]?, answeredElsewhere: Bool) {
        let uuid = (metadata?["call_id"] as? String).flatMap(UUID.init(uuidString:)) ?? UUID()
        let name = metadata?["caller_name"] as? String ?? ""
        let number = metadata?["caller_number"] as? String ?? ""
        let reason: CXCallEndedReason = answeredElsewhere ? .answeredElsewhere : .unanswered
        Log.push(answeredElsewhere ? "call \(uuid) answered elsewhere" : "call \(uuid) missed")

        if CallKitCoordinator.shared.activeCallUUIDs.contains(uuid) {
            CallKitCoordinator.shared.reportCallEnded(uuid: uuid, reason: reason)
            clearCall(uuid)
            return
        }

        // PushKit requires every VoIP push to result in a CallKit report, even
        // when this is a terminal cleanup event. Report and immediately end.
        CallKitCoordinator.shared.reportIncomingCall(uuid: uuid,
                                                     callerName: name,
                                                     callerNumber: number) { _ in
            CallKitCoordinator.shared.reportCallEnded(uuid: uuid, reason: reason)
        }
    }

    func handleVoIPPush(metadata: [String: Any]?) {
        // PushKit delivers on the main queue; keep this synchronous.
        let rawCallId = metadata?["call_id"] as? String
        let parsed = rawCallId.flatMap(UUID.init(uuidString:))
        let uuid = parsed ?? UUID()
        if parsed == nil {
            Log.push("push metadata missing/invalid call_id — using fallback \(uuid)")
        }

        let callerName   = metadata?["caller_name"] as? String ?? ""
        let callerNumber = metadata?["caller_number"] as? String ?? ""
        Log.push("VoIP push for call \(uuid) from \(callerNumber) (\(callerName))")

        // A delayed/duplicate push may arrive after a socket INVITE already
        // reported this same call. Do not replace that live connection.
        if CallKitCoordinator.shared.activeCallUUIDs.contains(uuid) {
            Log.push("call \(uuid) already reported — re-reporting to satisfy PushKit only")
            if let metadata, !telnyxClient.isConnected() {
                startSDKForPush(metadata: metadata)
            }
            // Every VoIP push must report a call before the handler returns, so
            // report again rather than relying on the earlier report to count.
            // The duplicate fails with callUUIDAlreadyExists, which the
            // coordinator now treats as harmless and keeps tracking through.
            // Deliberately does not touch currentCall or the watchdog.
            CallKitCoordinator.shared.reportIncomingCall(uuid: uuid,
                                                         callerName: callerName,
                                                         callerNumber: callerNumber)
            return
        }

        // A different call is already in progress: report then immediately end,
        // satisfying the PushKit rule without hijacking the active call.
        if let existing = currentCall, existing.id != uuid, existing.phase != .ended {
            Log.push("busy with \(existing.id) — reporting and ending \(uuid)")
            CallKitCoordinator.shared.reportIncomingCall(uuid: uuid,
                                                         callerName: callerName,
                                                         callerNumber: callerNumber) { _ in
                CallKitCoordinator.shared.reportCallEnded(uuid: uuid, reason: .failed)
            }
            return
        }

        // 1) Start the SDK reattaching first, matching the official demo order.
        var sdkStarted = false
        if let metadata {
            sdkStarted = startSDKForPush(metadata: metadata)
        } else {
            Log.push("no metadata in push payload — cannot start SDK")
        }

        // 2) Then report to CallKit. This is what makes the phone ring.
        currentCall = ActiveCall(id: uuid,
                                 callerName: callerName,
                                 callerNumber: callerNumber,
                                 isInbound: true,
                                 phase: .ringing,
                                 startedAt: Date())

        CallKitCoordinator.shared.reportIncomingCall(uuid: uuid,
                                                     callerName: callerName,
                                                     callerNumber: callerNumber) { [weak self] error in
            if let error {
                let nsError = error as NSError
                let alreadyExists = nsError.domain == CXErrorDomainIncomingCall
                    && nsError.code == CXErrorCodeIncomingCallError.callUUIDAlreadyExists.rawValue
                // A genuine failure (blocked number, Focus rejection) means no
                // call will ever ring. Clear state or it wedges every later
                // call behind the "busy" guard.
                if !alreadyExists { self?.clearCall(uuid) }
                return
            }
            guard !sdkStarted else { return }
            // The call can never connect (no credentials, or no metadata), so
            // end it now rather than ringing a phone that cannot answer.
            Log.push("SDK not started for \(uuid) — ending the reported call")
            CallKitCoordinator.shared.reportCallEnded(uuid: uuid, reason: .failed)
            self?.clearCall(uuid)
        }

        if sdkStarted { armPushWatchdog(for: uuid) }
    }

    /// - Returns: true if the SDK was successfully asked to attach.
    @discardableResult
    private func startSDKForPush(metadata: [String: Any]) -> Bool {
        guard let creds = CredentialStore.cachedSIPCredentials else {
            Log.push("no cached SIP credentials — call cannot connect")
            return false
        }
        do {
            let config = makeTxConfig(creds: creds)
            // Passing pushMetaData into the server config keeps the socket on
            // the same Telnyx edge/region that originated the push.
            let serverConfig = TxServerConfiguration(pushMetaData: metadata)
            try telnyxClient.processVoIPNotification(txConfig: config,
                                                     serverConfiguration: serverConfig,
                                                     pushMetaData: metadata)
            Log.push("processVoIPNotification started")
            return true
        } catch {
            Log.push("processVoIPNotification failed: \(error.localizedDescription)")
            return false
        }
    }

    /// If no real call materialises, end the CallKit UI rather than leaving a
    /// phantom call ringing or a stuck green status bar.
    ///
    /// Covers the answered-but-never-connected case too: the user can answer a
    /// push-woken call before the INVITE lands, which moves the phase to
    /// `.connecting`, so watching only for `.ringing` would disarm the net.
    private func armPushWatchdog(for uuid: UUID, seconds: TimeInterval = 45) {
        pushCallWatchdog?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, let call = self.currentCall, call.id == uuid else { return }
            let neverConnected = call.connectedAt == nil
            let stillPending = call.phase == .ringing || call.phase == .connecting
            guard neverConnected, stillPending else { return }

            Log.push("watchdog: call \(uuid) never connected after \(Int(seconds))s — ending")
            CallKitCoordinator.shared.reportCallEnded(uuid: uuid,
                                                      reason: call.phase == .ringing ? .unanswered : .failed)
            self.clearCall(uuid)
        }
        pushCallWatchdog = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    /// Completion for `reportIncomingCall` that clears local state when the OS
    /// genuinely refuses the call (blocked number, Focus rejection). Without
    /// it, `currentCall` stays a phantom `.ringing` entry that wedges the busy
    /// guard for every later call.
    private func incomingReportCompletion(for uuid: UUID) -> (Error?) -> Void {
        { [weak self] error in
            guard let error else { return }
            let nsError = error as NSError
            let alreadyExists = nsError.domain == CXErrorDomainIncomingCall
                && nsError.code == CXErrorCodeIncomingCallError.callUUIDAlreadyExists.rawValue
            if !alreadyExists { self?.clearCall(uuid) }
        }
    }

    private func clearCall(_ uuid: UUID) {
        onMain { [weak self] in
            guard let self, let call = self.currentCall, call.id == uuid else { return }
            self.currentCall = nil
        }
    }

    // MARK: - Outbound

    func startOutgoingCall(to destination: String) {
        onMain { [weak self] in
            guard let self else { return }
            guard self.currentCall == nil else {
                Log.voice("ignoring outbound dial — a call is already in progress")
                return
            }
            let uuid = UUID()
            self.currentCall = ActiveCall(id: uuid,
                                          callerName: "",
                                          callerNumber: destination,
                                          isInbound: false,
                                          phase: .connecting,
                                          startedAt: Date())
            // Route through CallKit so outbound calls appear in Recents and
            // interact correctly with the system audio session. If the
            // transaction is rejected the action never reaches the provider,
            // so clean up here or currentCall stays wedged.
            CallKitCoordinator.shared.startOutgoingCall(uuid: uuid, handle: destination) { [weak self] in
                self?.clearCall(uuid)
            }
        }
    }

    // MARK: - In-call controls (routed through CallKit so state stays in sync)

    func toggleMute() {
        guard let call = currentCall else { return }
        CallKitCoordinator.shared.requestSetMuted(uuid: call.id, muted: !call.isMuted)
    }

    func toggleHold() {
        guard let call = currentCall else { return }
        CallKitCoordinator.shared.requestSetHeld(uuid: call.id, held: !call.isOnHold)
    }

    func toggleSpeaker() {
        if telnyxClient.isSpeakerEnabled {
            telnyxClient.setEarpiece()
        } else {
            telnyxClient.setSpeaker()
        }
        let enabled = telnyxClient.isSpeakerEnabled
        onMain { [weak self] in self?.currentCall?.isOnSpeaker = enabled }
    }

    func endCall() {
        guard let call = currentCall else { return }
        CallKitCoordinator.shared.requestEndCall(uuid: call.id)
    }

    func sendDTMF(_ digit: String) {
        guard let call = currentCall, let sdkCall = telnyxClient.calls[call.id] else { return }
        sdkCall.dtmf(dtmf: digit)
    }

    // MARK: - Helpers

    private func sdkCall(for uuid: UUID) -> Call? { telnyxClient.calls[uuid] }

    /// Records the finished call against the backend so it shows up in the web
    /// inbox's call log alongside browser-answered calls.
    private func logCompletedCall(_ call: ActiveCall) {
        // A call that never connected is missed (inbound) or failed (outbound),
        // regardless of which phase it was in when it ended.
        let status: String
        if call.connectedAt != nil {
            status = "completed"
        } else {
            status = call.isInbound ? "missed" : "failed"
        }
        let duration = call.connectedAt.map { Int(Date().timeIntervalSince($0)) }

        // Move the Home Screen badge now. A push-woken process is only briefly
        // alive, and waiting for the next launch to reflect the call would mean
        // the icon showed nothing until the app was opened. Call history
        // replaces this estimate with the server's count when it next loads.
        if status == "missed" {
            Task { @MainActor in await MessageNotificationManager.shared.noteMissedCall() }
        }

        Task {
            await APIClient.shared.logCall(direction: call.isInbound ? "inbound" : "outbound",
                                           phone: call.callerNumber,
                                           status: status,
                                           durationSeconds: duration,
                                           startedAt: call.startedAt,
                                           endedAt: Date())
        }
    }
}

// MARK: - TxClientDelegate
//
// These arrive on the SDK's socket thread; every body hops to main before
// touching state.

extension TelnyxVoiceManager: TxClientDelegate {

    func onSocketConnected() {
        Log.voice("socket connected")
        setStatus("Connected", ready: false)
    }

    func onSocketDisconnected() {
        Log.voice("socket disconnected")
        connectedWithPushToken = false
        setStatus("Disconnected", ready: false)
        onMain { [weak self] in
            self?.resolveAllReadyWaiters(false)
            // The push-disable ack can never arrive on a dead socket; release
            // sign-out immediately instead of stalling for the full timeout.
            self?.resolveAllPushDisableWaiters(false)
        }
    }

    func onClientError(error: Error) {
        Log.voice("client error: \(error.localizedDescription)")
        connectedWithPushToken = false
        setStatus("Error: \(error.localizedDescription)", ready: false)
        onMain { [weak self] in
            self?.resolveAllReadyWaiters(false)
            self?.resolveAllPushDisableWaiters(false)
        }
    }

    func onClientReady() {
        let pushReady = pendingLoginIncludedPushToken
        connectedWithPushToken = pushReady
        Log.voice("client ready — registered with Telnyx (VoIP push: \(pushReady))")
        setStatus(pushReady ? "Ready for calls" : "Connected without VoIP push", ready: pushReady)
        onMain { [weak self] in self?.resolveAllReadyWaiters(pushReady) }
    }

    func onPushDisabled(success: Bool, message: String) {
        Log.push("push disabled (success: \(success)): \(message)")
        onMain { [weak self] in self?.resolveAllPushDisableWaiters(success) }
    }

    func onSessionUpdated(sessionId: String) {
        Log.voice("session updated: \(sessionId)")
    }

    /// Incoming call while the socket was already live (app in foreground).
    func onIncomingCall(call: Call) {
        guard let info = call.callInfo else { return }
        Log.voice("onIncomingCall \(info.callId)")

        onMain { [weak self] in
            guard let self else { return }

            // A push may also be in flight for this call; don't double-report.
            if CallKitCoordinator.shared.activeCallUUIDs.contains(info.callId) {
                if var existing = self.currentCall, existing.id == info.callId {
                    existing.phase = .ringing
                    self.currentCall = existing
                }
                return
            }

            // Busy with another call: report then end, so the caller isn't left
            // hanging and our single-call UI stays coherent.
            if let existing = self.currentCall, existing.id != info.callId, existing.phase != .ended {
                CallKitCoordinator.shared.reportIncomingCall(uuid: info.callId,
                                                             callerName: info.callerName ?? "",
                                                             callerNumber: info.callerNumber ?? "") { _ in
                    CallKitCoordinator.shared.reportCallEnded(uuid: info.callId, reason: .failed)
                }
                return
            }

            self.currentCall = ActiveCall(id: info.callId,
                                          callerName: info.callerName ?? "",
                                          callerNumber: info.callerNumber ?? "",
                                          isInbound: true,
                                          phase: .ringing,
                                          startedAt: Date())

            CallKitCoordinator.shared.reportIncomingCall(
                uuid: info.callId,
                callerName: info.callerName ?? "",
                callerNumber: info.callerNumber ?? "",
                completion: self.incomingReportCompletion(for: info.callId))
        }
    }

    /// The real call arriving after a VoIP push. Its UUID matches the one we
    /// already reported to CallKit (from `metadata.call_id`).
    func onPushCall(call: Call) {
        guard let info = call.callInfo else { return }
        Log.push("onPushCall \(info.callId)")

        onMain { [weak self] in
            guard let self else { return }
            self.pushCallWatchdog?.cancel()

            let name   = info.callerName ?? self.currentCall?.callerName ?? ""
            let number = info.callerNumber ?? self.currentCall?.callerNumber ?? ""

            if var existing = self.currentCall, existing.id == info.callId {
                existing.callerName = name
                existing.callerNumber = number
                self.currentCall = existing
            } else if !CallKitCoordinator.shared.activeCallUUIDs.contains(info.callId) {
                self.currentCall = ActiveCall(id: info.callId,
                                              callerName: name,
                                              callerNumber: number,
                                              isInbound: true,
                                              phase: .ringing,
                                              startedAt: Date())
                CallKitCoordinator.shared.reportIncomingCall(
                    uuid: info.callId,
                    callerName: name,
                    callerNumber: number,
                    completion: self.incomingReportCompletion(for: info.callId))
            }

            // Fill in the caller name if the push arrived before it resolved.
            CallKitCoordinator.shared.updateCall(
                uuid: info.callId,
                callerName: name.isEmpty ? PhoneFormatter.pretty(number) : name,
                callerNumber: number)
        }
    }

    func onCallStateUpdated(callState: CallState, callId: UUID) {
        Log.voice("call \(callId) state -> \(callState)")

        onMain { [weak self] in
            guard let self, var call = self.currentCall, call.id == callId else { return }

            switch callState {
            case .NEW:
                call.phase = .connecting

            case .CONNECTING:
                call.phase = .connecting
                if !call.isInbound {
                    CallKitCoordinator.shared.reportOutgoingCallStartedRinging(uuid: callId)
                }

            case .RINGING:
                call.phase = .ringing

            case .ACTIVE:
                let wasConnected = call.connectedAt != nil
                call.phase = .active
                call.isOnHold = false
                if !wasConnected {
                    call.connectedAt = Date()
                    if !call.isInbound {
                        CallKitCoordinator.shared.reportOutgoingCallConnected(uuid: callId)
                    }
                }

            case .HELD:
                call.phase = .held
                call.isOnHold = true

            case .DONE:
                call.phase = .ended
                self.pushCallWatchdog?.cancel()
                CallKitCoordinator.shared.reportCallEnded(uuid: callId, reason: .remoteEnded)
                self.logCompletedCall(call)
                self.currentCall = nil
                return

            case .RECONNECTING:
                call.phase = .connecting

            case .DROPPED:
                call.phase = .ended
                self.pushCallWatchdog?.cancel()
                CallKitCoordinator.shared.reportCallEnded(uuid: callId, reason: .failed)
                self.logCompletedCall(call)
                self.currentCall = nil
                return

            @unknown default:
                break
            }

            self.currentCall = call
        }
    }

    func onRemoteCallEnded(callId: UUID, reason: CallTerminationReason?) {
        Log.voice("remote ended \(callId): \(String(describing: reason))")

        onMain { [weak self] in
            guard let self else { return }
            self.pushCallWatchdog?.cancel()

            // Covers "answered on another device": Telnyx terminates this leg
            // and the native call UI must be dismissed or the phone keeps ringing.
            CallKitCoordinator.shared.reportCallEnded(uuid: callId, reason: .remoteEnded)

            if let call = self.currentCall, call.id == callId {
                self.logCompletedCall(call)
                self.currentCall = nil
            }
        }
    }
}

// MARK: - CallKitActionHandler

extension TelnyxVoiceManager: CallKitActionHandler {

    func callKitAnswer(action: CXAnswerCallAction) {
        // The SDK fulfils the action itself, and safely handles the case where
        // the socket has not finished reattaching yet.
        telnyxClient.answerFromCallkit(answerAction: action)
        onMain { [weak self] in
            guard let self, var call = self.currentCall, call.id == action.callUUID else { return }
            call.phase = .connecting
            self.currentCall = call
        }
    }

    func callKitEnd(action: CXEndCallAction) {
        telnyxClient.endCallFromCallkit(endAction: action)
        onMain { [weak self] in
            guard let self else { return }
            self.pushCallWatchdog?.cancel()
            if let call = self.currentCall, call.id == action.callUUID {
                self.logCompletedCall(call)
                self.currentCall = nil
            }
        }
    }

    func callKitStartOutgoing(action: CXStartCallAction) {
        Task { [weak self] in
            guard let self else { action.fail(); return }

            let initiated = await self.connectIfPossible()
            // `connect` only *starts* the socket — dialling before the client
            // has registered makes newCall throw.
            let ready = initiated ? await self.waitUntilReady() : false

            guard ready else {
                Log.voice("outbound aborted — client not ready")
                action.fail()
                CallKitCoordinator.shared.forgetCall(action.callUUID)
                self.clearCall(action.callUUID)
                return
            }

            do {
                let callerNumber = CredentialStore.get(.callerNumber) ?? ""
                _ = try self.telnyxClient.newCall(callerName: AppConfig.callKitDisplayName,
                                                  callerNumber: callerNumber,
                                                  destinationNumber: action.handle.value,
                                                  callId: action.callUUID)
                action.fulfill()
            } catch {
                Log.voice("newCall failed: \(error.localizedDescription)")
                action.fail()
                CallKitCoordinator.shared.forgetCall(action.callUUID)
                self.clearCall(action.callUUID)
            }
        }
    }

    func callKitSetMuted(uuid: UUID, muted: Bool) {
        guard let call = sdkCall(for: uuid) else { return }
        muted ? call.muteAudio() : call.unmuteAudio()
        onMain { [weak self] in self?.currentCall?.isMuted = muted }
    }

    func callKitSetHeld(uuid: UUID, held: Bool) {
        guard let call = sdkCall(for: uuid) else { return }
        held ? call.hold() : call.unhold()
        onMain { [weak self] in self?.currentCall?.isOnHold = held }
    }

    func callKitSendDTMF(uuid: UUID, digits: String) {
        sdkCall(for: uuid)?.dtmf(dtmf: digits)
    }

    func callKitActivateAudioSession(_ session: AVAudioSession) {
        telnyxClient.enableAudioSession(audioSession: session)
    }

    func callKitDeactivateAudioSession(_ session: AVAudioSession) {
        telnyxClient.disableAudioSession(audioSession: session)
    }

    func callKitDidReset() {
        onMain { [weak self] in self?.currentCall = nil }
    }
}
