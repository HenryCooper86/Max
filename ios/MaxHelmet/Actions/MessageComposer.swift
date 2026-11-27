import Foundation
import MessageUI
import UIKit

/// Presents the system message sheet. Returns true once the sheet has been
/// shown — iOS requires the rider to tap Send, so "presented" is the most we
/// can ever truthfully report.
protocol MessagePresenting {
    func present(number: String, body: String) async -> Bool
}

/// Non-isolated entry point so `AgentSession` (which is not main-actor) can hold
/// it. Every call hops to the main actor and drives a fresh isolated presenter.
struct MainActorMessagePresenter: MessagePresenting {
    func present(number: String, body: String) async -> Bool {
        await SystemMessagePresenter.present(number: number, body: body)
    }
}

/// Real presenter, backed by MFMessageComposeViewController. It pre-fills the
/// recipient and body; only the rider can send it. Instances retain themselves
/// until the sheet is dismissed, because MFMessageComposeViewController has no
/// built-in dismiss — its delegate must do it, so the delegate must outlive the
/// `present` call that returned once the sheet was shown. MessageUI calls that
/// delegate on the main thread, so the conformance is isolated to the main actor
/// like the rest of the presenter.
@MainActor
final class SystemMessagePresenter: NSObject, @MainActor MFMessageComposeViewControllerDelegate {
    private static var live = Set<SystemMessagePresenter>()

    static func present(number: String, body: String) async -> Bool {
        let presenter = SystemMessagePresenter()
        return await presenter.show(number: number, body: body)
    }

    private func show(number: String, body: String) async -> Bool {
        guard !Task.isCancelled else { return false }
        guard MFMessageComposeViewController.canSendText() else { return false }
        guard let root = UIApplication.shared.connectedScenes
            .compactMap({ ($0 as? UIWindowScene)?.keyWindow })
            .first?.rootViewController else { return false }

        Self.live.insert(self)   // stay alive until didFinish dismisses the sheet
        let composer = MFMessageComposeViewController()
        composer.recipients = [number]
        composer.body = body
        composer.messageComposeDelegate = self

        return await withCheckedContinuation { continuation in
            root.present(composer, animated: true) {
                continuation.resume(returning: true)
            }
        }
    }

    func messageComposeViewController(
        _ controller: MFMessageComposeViewController,
        didFinishWith result: MessageComposeResult
    ) {
        controller.dismiss(animated: true)
        Self.live.remove(self)
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
        guard !Task.isCancelled else { return .failed("device.cancelled") }
        guard let number = await resolver.number(matching: name) else { return .failed("contact.notFound") }
        guard !Task.isCancelled else { return .failed("device.cancelled") }
        let presented = await presenter.present(number: number, body: body)
        return presented ? .ok : .failed("compose.dismissed")
    }
}
