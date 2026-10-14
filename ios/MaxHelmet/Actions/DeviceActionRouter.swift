import Foundation

/// Dispatches a relay-issued command to exactly one handler and always produces
/// exactly one result. A locked or pocketed phone is refused before any handler
/// runs: iOS blocks URL opening, camera, and torch from the background, so
/// attempting the action would fail opaquely instead of telling the rider why.
struct DeviceActionRouter {
    private let handlers: [DeviceActionRoute: DeviceActionHandler]
    private let isDeviceUnlocked: () -> Bool

    init(handlers: [DeviceActionRoute: DeviceActionHandler], isDeviceUnlocked: @escaping () -> Bool) {
        self.handlers = handlers
        self.isDeviceUnlocked = isDeviceUnlocked
    }

    @MainActor func handle(_ command: DeviceCommand) async -> DeviceActionResult {
        guard !Task.isCancelled else { return .failed("device.cancelled") }
        guard isDeviceUnlocked() else {
            return .failed("device.locked")
        }
        guard let handler = handlers[DeviceActionRoute(command.action)] else {
            return .unsupported("handler.missing")
        }
        if let identified = handler as? IdentifiedDeviceActionHandler {
            return await identified.perform(command.action, commandId: command.commandId)
        }
        return await handler.perform(command.action)
    }
}
