import CoreLocation
import Foundation

struct CompanionFixThrottle {
    private static let minimumInterval: TimeInterval = 1

    private var lastEmissionTime: TimeInterval?
    private var pendingLocation: CLLocation?
    private var nextSequence = 1
    private var sequenceExhausted = false

    init() {}

    mutating func accept(_ location: CLLocation, now: TimeInterval) -> CompanionFix? {
        guard Self.isValid(location), now.isFinite else { return nil }

        guard let lastEmissionTime else {
            return emit(location, now: now)
        }
        guard now >= lastEmissionTime else { return nil }

        if now - lastEmissionTime < Self.minimumInterval {
            pendingLocation = location
            return nil
        }

        pendingLocation = nil
        return emit(location, now: now)
    }

    mutating func flushNewest(now: TimeInterval) -> CompanionFix? {
        guard now.isFinite,
              let lastEmissionTime,
              now >= lastEmissionTime,
              now - lastEmissionTime >= Self.minimumInterval,
              let pendingLocation else {
            return nil
        }

        return emit(pendingLocation, now: now)
    }

    mutating func reset() {
        lastEmissionTime = nil
        pendingLocation = nil
        nextSequence = 1
        sequenceExhausted = false
    }

    private mutating func emit(_ location: CLLocation, now: TimeInterval) -> CompanionFix? {
        guard !sequenceExhausted else { return nil }

        let sequence = nextSequence
        if sequence == Int.max {
            sequenceExhausted = true
        } else {
            nextSequence += 1
        }
        lastEmissionTime = now
        pendingLocation = nil

        let course = location.course >= 0 && location.course < 360 && location.course.isFinite
            ? location.course
            : nil
        let speed = location.speed >= 0 && location.speed.isFinite
            ? location.speed
            : nil

        return CompanionFix(
            sequence: sequence,
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            horizontalAccuracyMeters: location.horizontalAccuracy,
            timestampMilliseconds: location.timestamp.timeIntervalSince1970 * 1_000,
            courseDegrees: course,
            speedMps: speed
        )
    }

    private static func isValid(_ location: CLLocation) -> Bool {
        let latitude = location.coordinate.latitude
        let longitude = location.coordinate.longitude
        let accuracy = location.horizontalAccuracy
        let timestamp = location.timestamp.timeIntervalSince1970
        let timestampMilliseconds = timestamp * 1_000
        return latitude.isFinite
            && (-90...90).contains(latitude)
            && longitude.isFinite
            && (-180...180).contains(longitude)
            && accuracy.isFinite
            && accuracy >= 0
            && timestamp.isFinite
            && timestamp >= 0
            && timestampMilliseconds.isFinite
    }
}
