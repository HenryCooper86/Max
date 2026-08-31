import Contacts
import Foundation

/// Resolves a spoken name to a phone number entirely on-device. The number
/// never leaves the phone; the relay only ever sends the spoken name.
protocol ContactResolving {
    func isAuthorized() async -> Bool
    func number(matching name: String) async -> String?
}

/// Folds a spoken name to a comparable form: trims CJK and Latin punctuation,
/// lowercases, and converts fullwidth Latin (ASR emits Ｗａｎｇ) to halfwidth.
func normalizeContactName(_ name: String) -> String {
    let folded = name.applyingTransform(.fullwidthToHalfwidth, reverse: false) ?? name
    return folded
        .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters))
        .lowercased()
}

struct SystemContactResolver: ContactResolving {
    private let store = CNContactStore()

    func isAuthorized() async -> Bool {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized, .limited:
            return true
        case .notDetermined:
            return (try? await store.requestAccess(for: .contacts)) ?? false
        default:
            return false
        }
    }

    func number(matching name: String) async -> String? {
        let target = normalizeContactName(name)
        guard !target.isEmpty else { return nil }
        let keys = [CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey, CNContactPhoneNumbersKey]
        let request = CNContactFetchRequest(keysToFetch: keys as [CNKeyDescriptor])

        var exact: String?
        var partial: String?
        try? store.enumerateContacts(with: request) { contact, stop in
            guard let number = contact.phoneNumbers.first?.value.stringValue else { return }
            for candidate in [contact.nickname, contact.familyName + contact.givenName, contact.givenName] {
                let normalized = normalizeContactName(candidate)
                guard !normalized.isEmpty else { continue }
                if normalized == target {
                    exact = number
                    stop.pointee = true
                    return
                }
                if partial == nil, normalized.contains(target) || target.contains(normalized) {
                    partial = number
                }
            }
        }
        return exact ?? partial
    }
}
