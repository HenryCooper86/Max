import Foundation
import MessageUI
import UIKit

/// Presents the system message sheet. Returns true once the sheet has been
/// shown — iOS requires the rider to tap Send, so "presented" is the most we
/// can ever truthfully report.
protocol MessagePresenting {
    func present(number: String, body: String) async -> Bool
}

/// Real presenter, backed by MFMessageComposeViewController. It pre-fills the
/// recipient and body; only the rider can send it.
@MainActor
final class SystemMessagePresenter: NSObject, MessagePresenting, MFMessageComposeViewControllerDelegate {
    private var continuation: CheckedContinuation<Bool, Never>?

    func present(number: String, body: String) async -> Bool {
        guard MFMessageComposeViewController.canSendText() else { return false }
        guard let root = UIApplication.shared.connectedScenes
            .compactMap({ ($0 as? UIWindowScene)?.keyWindow })
            .first?.rootViewController else { return false }

        let composer = MFMessageComposeViewController()
        composer.recipients = [number]
        composer.body = body
        composer.messageComposeDelegate = self

        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            root.present(composer, animated: true) {
                continuation.resume(returning: true)
                self.continuation = nil
            }
        }
    }

    func messageComposeViewController(
        _ controller: MFMessageComposeViewController,
        didFinishWith result: MessageComposeResult
    ) {
        controller.dismiss(animated: true)
    }
}

struct MessageComposer: DeviceActionHandler {
    /// A message the rider must read and tap has no safe use in motion.
    static let maximumSpeedKmh: Double = 5

    private let presenter: MessagePresenting
    private let speedProvider: () -> Double?
    private let resolver: ContactResolving

    init(presenter: MessagePresenting, speedProvider: @escaping () -> Double?, resolver: ContactResolving) {
        self.presenter = presenter
        self.speedProvider = speedProvider
        self.resolver = resolver
    }

    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        guard case let .smsCompose(name, body) = action else { return .unsupported("action.mismatch") }
        // Unknown speed is refused, not allowed: a missing reading is not
        // evidence the bike is stopped.
        guard let speed = speedProvider(), speed < Self.maximumSpeedKmh else {
            return .denied("unsafe.speed")
        }
        guard await resolver.isAuthorized() else { return .denied("permission.contacts") }
        guard let number = await resolver.number(matching: name) else { return .failed("contact.notFound") }
        let presented = await presenter.present(number: number, body: body)
        return presented ? .ok : .failed("compose.dismissed")
    }
}
