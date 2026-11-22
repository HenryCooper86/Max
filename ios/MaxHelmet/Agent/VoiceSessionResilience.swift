import AVFoundation
import CallKit
import Network
import UIKit

// Keeps a hands-free session alive through the things a ride throws at it: a
// phone call or Siri taking the audio, a Bluetooth helmet headset connecting or
// dropping, the media server restarting, and the phone moving between Wi-Fi and
// cellular. The decisions live here, free of AVFoundation and sockets, so they
// can be driven by injected events in tests; AgentSession carries them out.

// MARK: - events

enum AudioRouteChange: Equatable {
    case deviceAdded, deviceRemoved, categoryChanged, other
}

enum AudioSessionEvent: Equatable {
    /// `appWasSuspended`: iOS is reporting, on resume, an interruption that
    /// happened while the app was suspended. It is already over by the time
    /// it is delivered, and no "ended" follows.
    case interruptionBegan(appWasSuspended: Bool)
    /// `shouldResume` is false both when the system said "don't" and when it
    /// said nothing, which the option key cannot tell apart.
    case interruptionEnded(shouldResume: Bool)
    case routeChanged(AudioRouteChange)
    case mediaServicesReset
    /// The rider brought the app back. Interruptions can end while the app is
    /// suspended without the ended notification ever being delivered.
    case appBecameActive
}

/// Translates the system notifications the session cares about. Returns nil for
/// anything malformed or irrelevant (including AVAudioEngineConfigurationChange,
/// which MicStreamer handles itself).
func audioSessionEvent(from notification: Notification) -> AudioSessionEvent? {
    let info = notification.userInfo ?? [:]
    switch notification.name {
    case AVAudioSession.interruptionNotification:
        guard let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return nil }
        switch type {
        case .began:
            let reason = (info[AVAudioSessionInterruptionReasonKey] as? UInt).flatMap(AVAudioSession.InterruptionReason.init(rawValue:))
            return .interruptionBegan(appWasSuspended: reason == .appWasSuspended)
        case .ended:
            let options = AVAudioSession.InterruptionOptions(rawValue: info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            return .interruptionEnded(shouldResume: options.contains(.shouldResume))
        @unknown default:
            return nil
        }
    case AVAudioSession.routeChangeNotification:
        guard let raw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return nil }
        switch reason {
        case .newDeviceAvailable: return .routeChanged(.deviceAdded)
        case .oldDeviceUnavailable: return .routeChanged(.deviceRemoved)
        case .categoryChange: return .routeChanged(.categoryChanged)
        case .override, .wakeFromSleep, .noSuitableRouteForCategory, .routeConfigurationChange:
            return .routeChanged(.other)
        case .unknown: return nil
        @unknown default: return .routeChanged(.other)
        }
    case AVAudioSession.mediaServicesWereResetNotification:
        return .mediaServicesReset
    case UIApplication.didBecomeActiveNotification:
        return .appBecameActive
    default:
        return nil
    }
}

enum NetworkInterface: Equatable {
    case wifi, cellular, wired, other
}

struct NetworkPathSnapshot: Equatable {
    var satisfied: Bool
    /// The interface the system would use first, nil when there is none.
    var interface: NetworkInterface?
}

// MARK: - injectable sources

@MainActor
protocol AudioSessionEventSource: AnyObject {
    func start(_ handler: @escaping @MainActor (AudioSessionEvent) -> Void)
    func stop()
}

@MainActor
protocol NetworkPathSource: AnyObject {
    func start(_ handler: @escaping @MainActor (NetworkPathSnapshot) -> Void)
    func stop()
}

/// Whether a phone call (cellular or VoIP) is in progress. Resuming the
/// microphone mid-call would fail or fight the call.
@MainActor
protocol CallStateSource: AnyObject {
    var callInProgress: Bool { get }
}

protocol ResilienceTimer {
    func cancel()
}

@MainActor
protocol ResilienceScheduling {
    func schedule(after delay: TimeInterval, _ work: @escaping @MainActor () -> Void) -> ResilienceTimer
}

/// The system's audio-session notifications, delivered on the main queue.
final class SystemAudioSessionEvents: AudioSessionEventSource {
    private let center: NotificationCenter
    private var observers: [NSObjectProtocol] = []

    init(center: NotificationCenter = .default) {
        self.center = center
    }

    func start(_ handler: @escaping @MainActor (AudioSessionEvent) -> Void) {
        stop()
        let names: [Notification.Name] = [
            AVAudioSession.interruptionNotification,
            AVAudioSession.routeChangeNotification,
            AVAudioSession.mediaServicesWereResetNotification,
            UIApplication.didBecomeActiveNotification,
        ]
        // The audio notifications arrive on arbitrary threads; the session's
        // state is main-thread only.
        observers = names.map { name in
            center.addObserver(forName: name, object: nil, queue: .main) { notification in
                guard let event = audioSessionEvent(from: notification) else { return }
                MainActor.assumeIsolated { handler(event) }
            }
        }
    }

    func stop() {
        observers.forEach(center.removeObserver)
        observers.removeAll()
    }
}

/// NWPathMonitor reduced to what reconnecting needs, delivered on main.
final class SystemNetworkPathMonitor: NetworkPathSource {
    private var monitor: NWPathMonitor?
    private let queue = DispatchQueue(label: "voice-network-path")

    func start(_ handler: @escaping @MainActor (NetworkPathSnapshot) -> Void) {
        stop()
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { path in
            let snapshot = NetworkPathSnapshot(satisfied: path.status == .satisfied, interface: Self.primaryInterface(of: path))
            DispatchQueue.main.async { MainActor.assumeIsolated { handler(snapshot) } }
        }
        monitor.start(queue: queue)
        self.monitor = monitor
    }

    func stop() {
        monitor?.cancel()
        monitor = nil
    }

    private static func primaryInterface(of path: NWPath) -> NetworkInterface? {
        guard path.status == .satisfied, let first = path.availableInterfaces.first else { return nil }
        switch first.type {
        case .wifi: return .wifi
        case .cellular: return .cellular
        case .wiredEthernet: return .wired
        default: return .other
        }
    }
}

/// CallKit's view of calls on the phone, including other apps' VoIP calls.
/// Reading it needs no entitlement, Info.plist key or permission.
@MainActor
final class SystemCallState: CallStateSource {
    private let observer = CXCallObserver()

    var callInProgress: Bool {
        observer.calls.contains { !$0.hasEnded }
    }
}

struct MainQueueResilienceScheduler: ResilienceScheduling {
    private final class Timer: ResilienceTimer {
        let item: DispatchWorkItem
        init(_ item: DispatchWorkItem) { self.item = item }
        func cancel() { item.cancel() }
    }

    func schedule(after delay: TimeInterval, _ work: @escaping @MainActor () -> Void) -> ResilienceTimer {
        let item = DispatchWorkItem { MainActor.assumeIsolated { work() } }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
        return Timer(item)
    }
}

// MARK: - media-services reset outside a session

enum MediaResetAction: Equatable {
    /// A session's audio is running: rebuild it now (the coordinator does).
    case rebuildNow
    /// Nothing is running: the engine object is dead all the same, so build a
    /// fresh one when audio next starts.
    case rebuildOnNextStart
}

func mediaServicesResetAction(sessionAudioActive: Bool) -> MediaResetAction {
    sessionAudioActive ? .rebuildNow : .rebuildOnNextStart
}

/// Watches for media-services resets for the app's whole lifetime, not just
/// during a session, so an engine killed while idle is not reused later.
@MainActor
final class MediaServicesResetObserver {
    var onReset: (() -> Void)?
    private let center: NotificationCenter
    private var observer: NSObjectProtocol?

    init(center: NotificationCenter = .default) {
        self.center = center
        observer = center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.onReset?() }
        }
    }

    deinit {
        if let observer { center.removeObserver(observer) }
    }
}

// MARK: - the coordinator

enum VoiceAudioStatus: Equatable {
    case live, interrupted, recovering, failed
}

/// What the session does when the coordinator decides. Each audio action
/// returns whether the microphone and speaker path is running again.
@MainActor
protocol VoiceResilienceActions: AnyObject {
    func suspendAudio()
    func resumeAudio() -> Bool
    func rerouteAudio() -> Bool
    func rebuildAudio() -> Bool
    func networkBecameUnavailable()
    func networkBecameAvailable(interfaceChanged: Bool)
    func voiceAudioStatusChanged(_ status: VoiceAudioStatus)
}

@MainActor
final class VoiceSessionResilience {
    /// A headset connecting posts several route changes within a few hundred
    /// milliseconds (new device, category, configuration). Reroute once, after
    /// they settle.
    static let routeDebounce: TimeInterval = 0.4
    /// An interruption that ends without `.shouldResume` is usually a phone
    /// call. The rider started hands-free on purpose and cannot reach the phone
    /// at speed, so a dead microphone is worse than resuming uninvited; waiting
    /// a moment lets the call's own audio session finish letting go first.
    static let resumeGraceWithoutShouldResume: TimeInterval = 1.0
    /// Spacing of further attempts after a resume, reroute or rebuild fails
    /// (another app can still hold the audio for a while).
    static let retryDelays: [TimeInterval] = [1, 2, 4, 8]
    /// iOS does not guarantee an "ended" (an app that never deactivates with
    /// notifyOthers, a suspended app). While the audio is still interrupted or
    /// recovery has failed, try again this often for as long as the session
    /// lasts; a rider cannot be expected to open the app mid-ride.
    static let slowRetryInterval: TimeInterval = 15

    weak var actions: VoiceResilienceActions?

    private(set) var audioStatus: VoiceAudioStatus = .live
    private(set) var networkAvailable = true
    var isActive: Bool { active }

    private let audioEvents: AudioSessionEventSource
    private let network: NetworkPathSource
    private let scheduler: ResilienceScheduling
    private let calls: CallStateSource
    private var slowRetry: ResilienceTimer?
    private var active = false
    private var interrupted = false
    private var lastInterface: NetworkInterface?
    private var sawFirstPath = false
    private var pendingAudioWork: ResilienceTimer?

    init(audioEvents: AudioSessionEventSource, network: NetworkPathSource, scheduler: ResilienceScheduling, calls: CallStateSource) {
        self.audioEvents = audioEvents
        self.network = network
        self.scheduler = scheduler
        self.calls = calls
    }

    func activate() {
        guard !active else { return }
        active = true
        interrupted = false
        audioStatus = .live
        networkAvailable = true
        sawFirstPath = false
        lastInterface = nil
        audioEvents.start { [weak self] event in self?.handle(event) }
        network.start { [weak self] snapshot in self?.handle(snapshot) }
    }

    func deactivate() {
        guard active else { return }
        active = false
        cancelPendingAudioWork()
        stopSlowRetry()
        audioEvents.stop()
        network.stop()
        interrupted = false
        audioStatus = .live
        networkAvailable = true
    }

    // MARK: audio

    private func handle(_ event: AudioSessionEvent) {
        guard active else { return }
        switch event {
        case let .interruptionBegan(appWasSuspended):
            if !interrupted {
                interrupted = true
                cancelPendingAudioWork()
                actions?.suspendAudio()
                setStatus(.interrupted)
            }
            if appWasSuspended {
                cancelPendingAudioWork()
                attempt(.resume, retry: 0)
            }

        case let .interruptionEnded(shouldResume):
            guard interrupted || audioStatus == .failed else { return }
            cancelPendingAudioWork()
            if shouldResume {
                attempt(.resume, retry: 0)
            } else {
                pendingAudioWork = scheduler.schedule(after: Self.resumeGraceWithoutShouldResume) { [weak self] in
                    self?.attempt(.resume, retry: 0)
                }
            }

        case .appBecameActive:
            guard interrupted || audioStatus == .failed else { return }
            cancelPendingAudioWork()
            attempt(.resume, retry: 0)

        case .routeChanged:
            // Once recovery has failed, a new route (a headset connecting) is
            // a fresh chance: run the full resume. During a live interruption
            // a resume reroutes anyway, and acting mid-call would fight it.
            let recovery: Recovery
            if audioStatus == .failed {
                recovery = .resume
            } else if interrupted {
                return
            } else {
                recovery = .reroute
            }
            cancelPendingAudioWork()
            pendingAudioWork = scheduler.schedule(after: Self.routeDebounce) { [weak self] in
                self?.attempt(recovery, retry: 0)
            }

        case .mediaServicesReset:
            // Every audio object is gone, so nothing pending is still valid.
            cancelPendingAudioWork()
            interrupted = false
            attempt(.rebuild, retry: 0)
        }
    }

    private enum Recovery { case resume, reroute, rebuild }

    private func attempt(_ recovery: Recovery, retry: Int) {
        guard active, let actions else { return }
        pendingAudioWork = nil
        setStatus(.recovering)
        let ok: Bool
        switch recovery {
        case .resume: ok = !calls.callInProgress && actions.resumeAudio()
        case .reroute: ok = actions.rerouteAudio()
        case .rebuild: ok = actions.rebuildAudio()
        }
        if ok {
            interrupted = false
            setStatus(.live)
        } else if retry < Self.retryDelays.count {
            pendingAudioWork = scheduler.schedule(after: Self.retryDelays[retry]) { [weak self] in
                self?.attempt(recovery, retry: retry + 1)
            }
        } else {
            setStatus(.failed)
        }
    }

    /// One quiet attempt on the slow schedule. Failure changes nothing the
    /// rider sees; the next tick tries again.
    private func slowRetryTick() {
        slowRetry = nil
        guard active, audioStatus != .live else { return }
        // A fast retry or debounce is already queued: let it run first.
        if pendingAudioWork == nil, !calls.callInProgress, let actions, actions.resumeAudio() {
            interrupted = false
            setStatus(.live)
            return
        }
        scheduleSlowRetry()
    }

    private func scheduleSlowRetry() {
        guard active, slowRetry == nil else { return }
        slowRetry = scheduler.schedule(after: Self.slowRetryInterval) { [weak self] in self?.slowRetryTick() }
    }

    private func stopSlowRetry() {
        slowRetry?.cancel()
        slowRetry = nil
    }

    private func cancelPendingAudioWork() {
        pendingAudioWork?.cancel()
        pendingAudioWork = nil
    }

    private func setStatus(_ status: VoiceAudioStatus) {
        guard status != audioStatus else { return }
        audioStatus = status
        switch status {
        case .interrupted, .failed: scheduleSlowRetry()
        case .live: stopSlowRetry()
        case .recovering: break
        }
        actions?.voiceAudioStatusChanged(status)
    }

    // MARK: network

    private func handle(_ snapshot: NetworkPathSnapshot) {
        guard active else { return }
        let first = !sawFirstPath
        sawFirstPath = true
        if !snapshot.satisfied {
            lastInterface = nil
            guard networkAvailable else { return }
            networkAvailable = false
            actions?.networkBecameUnavailable()
            return
        }
        let previous = lastInterface
        lastInterface = snapshot.interface
        if !networkAvailable {
            networkAvailable = true
            actions?.networkBecameAvailable(interfaceChanged: false)
        } else if !first, let previous, let current = snapshot.interface, previous != current {
            // A handover leaves the old socket bound to an interface that may
            // be gone; the session checks it rather than waiting to notice.
            actions?.networkBecameAvailable(interfaceChanged: true)
        }
    }
}

// MARK: - reconnect budget

/// The relay reconnect schedule. Mirrors MAX_RECONNECT_ATTEMPTS and the backoff
/// in src/main.tsx while online; drops that happen with no network at all are
/// not the relay's fault and do not spend the budget.
struct ReconnectPolicy {
    static let maxAttempts = 6

    enum Decision: Equatable {
        /// No usable network: wait for the path monitor to report one.
        case waitForNetwork
        case retry(afterMs: Int)
        /// Past the budget with a crash incident open: keep trying slowly.
        case crashOutageRetry
        case giveUp
    }

    private(set) var attempts = 0
    private(set) var networkAvailable = true

    mutating func socketDropped(hasActiveIncident: Bool) -> Decision {
        guard networkAvailable else { return .waitForNetwork }
        attempts += 1
        if attempts > Self.maxAttempts {
            // Left over the limit so each later failure re-checks the incident.
            if hasActiveIncident { return .crashOutageRetry }
            attempts = 0
            return .giveUp
        }
        return .retry(afterMs: min(8_000, 1_000 * (1 << (attempts - 1))))
    }

    /// Returns true when the network has just come back, which is the moment
    /// to reconnect immediately with a fresh budget.
    mutating func networkChanged(available: Bool) -> Bool {
        defer { networkAvailable = available }
        guard available, !networkAvailable else { return false }
        attempts = 0
        return true
    }

    mutating func connected() { attempts = 0 }
    mutating func reset() { attempts = 0; networkAvailable = true }
}
