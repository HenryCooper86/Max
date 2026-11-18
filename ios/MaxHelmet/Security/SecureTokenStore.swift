import Foundation
import Security

/// Small Keychain wrapper for relay bearer tokens. Values are device-only and
/// remain available after the rider has unlocked once, including background use.
enum SecureTokenStore {
    private static let service = Bundle.main.bundleIdentifier ?? "io.github.henrycooper86.max"

    static func read(account: String) -> String? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func write(_ value: String, account: String) -> Bool {
        if value.isEmpty {
            remove(account: account)
            return true
        }
        guard let data = value.data(using: .utf8) else { return false }
        let query = baseQuery(account: account)
        let attributes = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return true }
        guard updateStatus == errSecItemNotFound else { return false }

        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(insert as CFDictionary, nil) == errSecSuccess
    }

    static func remove(account: String) {
        SecItemDelete(baseQuery(account: account) as CFDictionary)
    }

    /// Moves a value written by older builds out of UserDefaults on first use.
    static func migrate(account: String, defaults: UserDefaults) -> String {
        if let secure = read(account: account) { return secure }
        guard let legacy = defaults.string(forKey: account), !legacy.isEmpty else {
            defaults.removeObject(forKey: account)
            return ""
        }
        if write(legacy, account: account) { defaults.removeObject(forKey: account) }
        return legacy
    }

    private static func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
}
