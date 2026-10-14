import Foundation

/// Owns pending actions and reply delivery for one relay session.
@MainActor
final class DeviceCommandSession {
    private var generation = 0
    private var tasks: [String: Task<Void, Never>] = [:]
    private var commandIds: [String] = []

    func invalidate() {
        generation += 1
        tasks.values.forEach { $0.cancel() }
        tasks.removeAll()
        commandIds.removeAll()
    }

    func submit(_ command: DeviceCommand,
                perform: @escaping @MainActor (DeviceCommand) async -> DeviceActionResult,
                send: @escaping (String) -> Void) {
        guard !command.commandId.isEmpty, !commandIds.contains(command.commandId) else { return }
        commandIds.append(command.commandId)
        if commandIds.count > 512 { commandIds.removeFirst() }
        let owner = generation
        tasks[command.commandId] = Task { [weak self] in
            guard let self, owner == self.generation, !Task.isCancelled else { return }
            let result = await perform(command)
            guard owner == self.generation, !Task.isCancelled else { return }
            self.tasks.removeValue(forKey: command.commandId)
            send(buildDeviceResult(commandId: command.commandId, result: result))
        }
    }
}
