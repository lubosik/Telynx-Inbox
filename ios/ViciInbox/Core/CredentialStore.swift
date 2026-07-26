import Foundation
import Security

/// Keychain-backed storage for the inbox password and the SIP credentials
/// fetched from the backend. Values persist across app launches and app
/// termination, which matters because a VoIP push can relaunch the app
/// cold and it must be able to reconnect without a user login.
enum CredentialStore {

    private static let service = "com.vicipeptides.inbox"

    enum Key: String {
        case inboxPassword   = "inbox_password"
        case sipUser         = "sip_user"
        case sipPassword     = "sip_password"
        case callerNumber    = "caller_number"
    }

    static func set(_ value: String?, for key: Key) {
        guard let value, !value.isEmpty else { remove(key); return }
        let data = Data(value.utf8)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key.rawValue
        ]
        // Accessible after first unlock so a VoIP push arriving on a locked
        // phone can still read the credentials and connect the call.
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]

        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        }
    }

    static func get(_ key: Key) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key.rawValue,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func remove(_ key: Key) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key.rawValue
        ]
        SecItemDelete(query as CFDictionary)
    }

    /// SIP credentials cached from `GET /api/voice/token`.
    static var cachedSIPCredentials: SIPCredentials? {
        guard let user = get(.sipUser), let password = get(.sipPassword) else { return nil }
        return SIPCredentials(login: user,
                              password: password,
                              callerNumber: get(.callerNumber) ?? "")
    }

    static func store(_ creds: SIPCredentials) {
        set(creds.login, for: .sipUser)
        set(creds.password, for: .sipPassword)
        set(creds.callerNumber, for: .callerNumber)
    }

    static func clearAll() {
        [Key.inboxPassword, .sipUser, .sipPassword, .callerNumber].forEach(remove)
    }
}

struct SIPCredentials: Equatable {
    let login: String
    let password: String
    let callerNumber: String
}
