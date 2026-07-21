import Foundation

/// Pure ownership gate for asynchronous hands-free startup.
///
/// Location, permission, and microphone callbacks may arrive after the rider
/// stops. Each start receives a generation and may acquire resources only while
/// that generation remains current; stop invalidates every pending callback.
struct SessionLifecycle {
    private(set) var generation = 0
    private(set) var active = false

    mutating func begin() -> Int? {
        guard !active else { return nil }
        active = true
        generation += 1
        return generation
    }

    func accepts(_ candidate: Int) -> Bool {
        active && candidate == generation
    }

    mutating func stop() -> Bool {
        guard active else { return false }
        active = false
        generation += 1
        return true
    }
}
