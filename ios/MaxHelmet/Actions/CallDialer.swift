import Foundation
import UIKit

protocol URLOpening {
    func open(_ url: URL) async -> Bool
}

struct SystemURLOpener: URLOpening {
    @MainActor
    func open(_ url: URL) async -> Bool {
        await UIApplication.shared.open(url)
    }
}

/// Dials via `tel:`. Since iOS 10.3 the system always shows its own
/// confirmation alert before connecting, so a successful open means the rider
/// has been *asked*, not that a call is connected. Max must say it is placing
/// the call, never that it has connected one.
struct CallDialer: DeviceActionHandler {
    private let opener: URLOpening
    private let resolver: ContactResolving

    init(opener: URLOpening = SystemURLOpener(), resolver: ContactResolving = SystemContactResolver()) {
        self.opener = opener
        self.resolver = resolver
    }

    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        guard case let .callDial(name, number) = action else { return .unsupported("action.mismatch") }

        var target = number
        if target == nil, let name {
            guard await resolver.isAuthorized() else { return .denied("permission.contacts") }
            guard let resolved = await resolver.number(matching: name) else { return .failed("contact.notFound") }
            target = resolved
        }
        guard let target, let url = URL(string: "tel://\(target.filter { $0.isNumber || $0 == "+" })") else {
            return .failed("dial.failed")
        }
        return await opener.open(url) ? .ok : .failed("dial.failed")
    }
}
