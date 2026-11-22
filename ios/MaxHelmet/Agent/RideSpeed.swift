import CoreLocation
import Foundation

// Ride speed for crash detection, the SMS gate and typed input. The relay's
// ride.context.speedKmh is set only by the keyless mock demo; live backends
// leave it out, and an absent field used to parse as 0 km/h ("stopped"). So
// the phone's own GPS is the primary source, the relay is a fallback only when
// it actually sent the field, and otherwise the speed is unknown (nil).

/// Speeds above this are treated as a bad reading, matching the relay's
/// accepted range for location.update.speedKmh.
let maximumPlausibleSpeedKmh = 400.0

/// km/h from a GPS fix, or nil when Core Location says the speed is invalid
/// (negative) or too uncertain to gate anything on.
func gpsSpeedKmh(from location: CLLocation) -> Double? {
    guard location.speed >= 0, location.speed.isFinite,
          location.speedAccuracy >= 0, location.speedAccuracy <= RideSpeedTracker.maximumSpeedAccuracyMps else { return nil }
    let kmh = location.speed * 3.6
    return kmh <= maximumPlausibleSpeedKmh ? kmh : nil
}

/// The relay's speedKmh, only when the field is present and sane.
func relaySpeedKmh(_ raw: Any?) -> Double? {
    // JSON booleans also arrive as NSNumber; true must not read as 1 km/h.
    guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let value = number.doubleValue
    guard value.isFinite, value >= 0, value <= maximumPlausibleSpeedKmh else { return nil }
    return value
}

/// Fresh GPS wins; otherwise a speed the relay really sent; otherwise unknown.
func resolvedRideSpeedKmh(
    gpsKmh: Double?, gpsFixAt: Date?, relayKmh: Double?, now: Date,
    freshness: TimeInterval = RideSpeedTracker.gpsFreshness
) -> Double? {
    if let gpsKmh, let gpsFixAt, now.timeIntervalSince(gpsFixAt) <= freshness,
       now.timeIntervalSince(gpsFixAt) >= -freshness {
        return gpsKmh
    }
    return relayKmh
}

/// The location fixes the session already receives (LocationProvider), behind a
/// protocol so the speed logic can be fed fixes in tests.
protocol RideLocationSource: AnyObject {
    var onFix: ((CLLocation) -> Void)? { get set }
}

/// Holds the latest speed readings. Written on the main thread, read by the
/// crash detector's motion callback on CoreMotion's queue at 100 Hz, hence
/// the lock.
final class RideSpeedTracker: @unchecked Sendable {
    /// A GPS speed older than this no longer describes the bike.
    static let gpsFreshness: TimeInterval = 5
    /// Crash detection forgets a GPS speed sooner: after an impact the phone
    /// is tumbling and GPS degrades, and a pre-impact speed left in force
    /// would veto the stillness that confirms the crash.
    static let crashGpsFreshness: TimeInterval = 2
    /// Fixes whose speed is uncertain by more than 3 m/s (11 km/h) cannot
    /// tell a stop from a walk-pace roll and carry no usable speed. Shared with
    /// the Android app.
    static let maximumSpeedAccuracyMps: Double = 3

    private let lock = NSLock()
    private let now: () -> Date
    private var gpsKmh: Double?
    private var gpsFixAt: Date?
    private var relayKmh: Double?
    /// The relay's speedKmh is believed only in a mock session, where it is
    /// the demo scenario's speed. In a live session the relay merely echoes
    /// the phone's own earlier location.update speed, which can be minutes
    /// old (a stop at a light, then a tunnel), so it is ignored there.
    private var relayTrusted = false
    private var lastUsableKmh: Double?
    private var lastUsableAt: Date?

    init(now: @escaping () -> Date = Date.init) {
        self.now = now
    }

    /// Feeds every fix from `source` into the tracker.
    func observe(_ source: RideLocationSource) {
        source.onFix = { [weak self] location in self?.record(location) }
    }

    /// A fix without a usable speed records "unknown" at its time rather than
    /// leaving the previous reading in force: after a crash the phone tumbles
    /// and GPS degrades, and a pre-impact speed must not outlive the impact.
    func record(_ location: CLLocation) {
        let kmh = gpsSpeedKmh(from: location)
        lock.lock()
        gpsKmh = kmh
        gpsFixAt = location.timestamp
        if let kmh {
            lastUsableKmh = kmh
            lastUsableAt = location.timestamp
        }
        lock.unlock()
    }

    /// The relay's ride.context speed; nil when the event left the field out.
    /// Ignored unless the session is known to be a mock session.
    func recordRelay(speedKmh: Double?) {
        lock.lock()
        if relayTrusted { relayKmh = speedKmh }
        lock.unlock()
    }

    /// session.started told us the mode. Any relay speed seen before is dropped.
    func sessionStarted(mock: Bool) {
        lock.lock()
        relayTrusted = mock
        relayKmh = nil
        lock.unlock()
    }

    func reset() {
        lock.lock()
        gpsKmh = nil
        gpsFixAt = nil
        lastUsableKmh = nil
        lastUsableAt = nil
        relayKmh = nil
        relayTrusted = false
        lock.unlock()
    }

    /// For the SMS gate, typing and the HUD.
    var currentSpeedKmh: Double? { speedKmh(freshness: Self.gpsFreshness) }

    /// For the crash motion feed (see crashGpsFreshness). The phone's GPS
    /// only, in every mode: the mock relay's constant scenario speed would
    /// veto the stillness that confirms a crash.
    var crashSpeedKmh: Double? {
        lock.lock()
        defer { lock.unlock() }
        return resolvedRideSpeedKmh(gpsKmh: gpsKmh, gpsFixAt: gpsFixAt, relayKmh: nil, now: now(), freshness: Self.crashGpsFreshness)
    }

    /// How long the last usable GPS speed keeps the crash engine's speed gate
    /// open. Longer than the 2 s sample speed so a tunnel or a run of poor
    /// fixes does not close the gate seconds before an impact.
    static let crashGateFreshness: TimeInterval = 15

    /// The crash engine's gate input: the last usable GPS speed, if no older
    /// than 15 s. A fix without a usable speed does not erase it; any newer
    /// usable reading replaces it, so a rider stopped with GPS working reads ~0.
    var crashGateSpeedKmh: Double? {
        lock.lock()
        defer { lock.unlock() }
        guard let lastUsableKmh, let lastUsableAt else { return nil }
        let age = now().timeIntervalSince(lastUsableAt)
        return abs(age) <= Self.crashGateFreshness ? lastUsableKmh : nil
    }

    /// The relay socket closed or a reconnect began: its speed and the
    /// session mode are learned again from the next session.started.
    func relayConnectionLost() {
        lock.lock()
        relayKmh = nil
        relayTrusted = false
        lock.unlock()
    }

    private func speedKmh(freshness: TimeInterval) -> Double? {
        lock.lock()
        defer { lock.unlock() }
        return resolvedRideSpeedKmh(gpsKmh: gpsKmh, gpsFixAt: gpsFixAt, relayKmh: relayKmh, now: now(), freshness: freshness)
    }

    /// Only the phone's own fresh measurement, for location.update: the relay
    /// must not be handed back its own (or a stale) number.
    var freshGpsSpeedKmh: Double? {
        lock.lock()
        defer { lock.unlock() }
        return resolvedRideSpeedKmh(gpsKmh: gpsKmh, gpsFixAt: gpsFixAt, relayKmh: nil, now: now())
    }
}

/// Builds the client's location.update. `speedKmh` is an optional field the
/// relay uses for its "moving fast" rule; it is sent only when a fresh GPS
/// speed is known, never as a guess.
func buildLocationUpdate(lat: Double, lon: Double, speedKmh: Double?) -> String {
    var payload: [String: Any] = ["type": ClientEventTypes.locationUpdate, "lat": lat, "lon": lon]
    if let speedKmh, speedKmh.isFinite, speedKmh >= 0, speedKmh <= maximumPlausibleSpeedKmh {
        payload["speedKmh"] = (speedKmh * 10).rounded() / 10
    }
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return "{}" }
    return String(data: data, encoding: .utf8) ?? "{}"
}

/// Typing is refused while the bike is known to be moving, at the same 5 km/h
/// as the SMS gate. An unknown speed does not lock it (see sendTextInput).
func typedInputLockedForSpeed(_ speedKmh: Double?) -> Bool {
    guard let speedKmh else { return false }
    return speedKmh >= MessageComposer.maximumSpeedKmh
}
