import Foundation
import os

/// Lightweight logging. Voice/push events are logged through OSLog so they can
/// be read in Console.app when a real device receives a push while the app was
/// terminated — that is the only practical way to debug the cold-launch path.
enum Log {
    private static let voiceLogger = Logger(subsystem: "com.vicipeptides.inbox", category: "voice")
    private static let pushLogger  = Logger(subsystem: "com.vicipeptides.inbox", category: "push")
    private static let appLogger   = Logger(subsystem: "com.vicipeptides.inbox", category: "app")

    static func voice(_ message: String) {
        voiceLogger.log("\(message, privacy: .public)")
        #if DEBUG
        print("[voice] \(message)")
        #endif
    }

    static func push(_ message: String) {
        pushLogger.log("\(message, privacy: .public)")
        #if DEBUG
        print("[push] \(message)")
        #endif
    }

    static func app(_ message: String) {
        appLogger.log("\(message, privacy: .public)")
        #if DEBUG
        print("[app] \(message)")
        #endif
    }
}
