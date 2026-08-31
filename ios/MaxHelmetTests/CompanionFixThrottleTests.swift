import CoreLocation
import XCTest
@testable import MaxHelmet

final class CompanionFixThrottleTests: XCTestCase {
    func testFirstValidFixEmitsImmediatelyAsSequenceOneWithExactValues() throws {
        var throttle = CompanionFixThrottle()
        let timestamp = Date(timeIntervalSince1970: 1_700_000_000.125)
        let location = makeLocation(
            latitude: 31.2304,
            longitude: 121.4737,
            accuracy: 4.5,
            course: 123.25,
            speed: 8.75,
            timestamp: timestamp
        )

        let fix = try XCTUnwrap(throttle.accept(location, now: 10))

        XCTAssertEqual(fix.sequence, 1)
        XCTAssertEqual(fix.latitude, 31.2304)
        XCTAssertEqual(fix.longitude, 121.4737)
        XCTAssertEqual(fix.horizontalAccuracyMeters, 4.5)
        XCTAssertEqual(fix.timestampMilliseconds, 1_700_000_000_125, accuracy: 0.001)
        XCTAssertEqual(fix.courseDegrees, 123.25)
        XCTAssertEqual(fix.speedMps, 8.75)
    }

    func testInsideWindowReplacesOnePendingAndAcceptAtBoundaryChoosesCurrent() throws {
        var throttle = CompanionFixThrottle()
        XCTAssertEqual(throttle.accept(makeLocation(latitude: 10), now: 100)?.sequence, 1)

        XCTAssertNil(throttle.accept(makeLocation(latitude: 20), now: 100.2))
        XCTAssertNil(throttle.accept(makeLocation(latitude: 30), now: 100.999))
        let emitted = try XCTUnwrap(throttle.accept(makeLocation(latitude: 40), now: 101))

        XCTAssertEqual(emitted.sequence, 2)
        XCTAssertEqual(emitted.latitude, 40, "the current boundary sample is newer than the retained sample")
        XCTAssertNil(throttle.flushNewest(now: 102))
    }

    func testFlushEmitsNewestOnlyWhenDueAndAdvancesSequenceOnce() throws {
        var throttle = CompanionFixThrottle()
        XCTAssertNotNil(throttle.accept(makeLocation(latitude: 1), now: 0))
        XCTAssertNil(throttle.accept(makeLocation(latitude: 2), now: 0.2))
        XCTAssertNil(throttle.accept(makeLocation(latitude: 3), now: 0.8))

        XCTAssertNil(throttle.flushNewest(now: 0.999))
        let fix = try XCTUnwrap(throttle.flushNewest(now: 1))

        XCTAssertEqual(fix.sequence, 2)
        XCTAssertEqual(fix.latitude, 3)
        XCTAssertNil(throttle.flushNewest(now: 2))
        XCTAssertEqual(throttle.accept(makeLocation(latitude: 4), now: 2)?.sequence, 3)
    }

    func testLongRideSequenceIsMonotonicAndResetStartsANewRideAtOne() {
        var throttle = CompanionFixThrottle()
        var sequences: [Int] = []
        for second in 0..<180 {
            if let fix = throttle.accept(makeLocation(latitude: Double(second % 80)), now: Double(second)) {
                sequences.append(fix.sequence)
            }
        }

        XCTAssertEqual(sequences, Array(1...180))

        throttle.reset()
        XCTAssertEqual(throttle.accept(makeLocation(latitude: 1), now: 1_000)?.sequence, 1)
    }

    func testValueCopiesRetainIndependentOneSlotRideState() {
        var original = CompanionFixThrottle()
        XCTAssertEqual(original.accept(makeLocation(latitude: 1), now: 10)?.sequence, 1)
        XCTAssertNil(original.accept(makeLocation(latitude: 2), now: 10.2))
        var copy = original

        XCTAssertEqual(copy.flushNewest(now: 11)?.latitude, 2)
        XCTAssertNil(copy.flushNewest(now: 12))
        XCTAssertEqual(original.flushNewest(now: 11)?.latitude, 2)
        XCTAssertEqual(original.accept(makeLocation(latitude: 3), now: 12)?.sequence, 3)
        XCTAssertEqual(copy.accept(makeLocation(latitude: 4), now: 12)?.sequence, 3)
    }

    func testInvalidLocationsDoNotEmitConsumeSequenceOrAdvanceClock() {
        let invalidLocations = [
            makeLocation(latitude: .nan),
            makeLocation(latitude: .infinity),
            makeLocation(latitude: -91),
            makeLocation(latitude: 91),
            makeLocation(longitude: -.infinity),
            makeLocation(longitude: -181),
            makeLocation(longitude: 181),
            makeLocation(accuracy: -1),
            makeLocation(accuracy: .nan),
            makeLocation(accuracy: .infinity),
            makeLocation(timestamp: Date(timeIntervalSince1970: -1)),
            makeLocation(timestamp: Date(timeIntervalSince1970: .nan)),
            makeLocation(timestamp: Date(timeIntervalSince1970: .infinity))
        ]
        var throttle = CompanionFixThrottle()

        for invalid in invalidLocations {
            XCTAssertNil(throttle.accept(invalid, now: 20))
        }

        XCTAssertEqual(throttle.accept(makeLocation(latitude: 0, longitude: 0, accuracy: 0, timestamp: Date(timeIntervalSince1970: 0)), now: 20)?.sequence, 1)
        XCTAssertEqual(throttle.accept(makeLocation(latitude: -90, longitude: 180), now: 21)?.sequence, 2)
        XCTAssertEqual(throttle.accept(makeLocation(latitude: 90, longitude: -180), now: 22)?.sequence, 3)
    }

    func testTimestampWhoseMillisecondConversionOverflowsIsRejectedWithoutConsumingSequence() {
        var throttle = CompanionFixThrottle()
        let hugeTimestamp = Date(timeIntervalSince1970: Double.greatestFiniteMagnitude / 2)

        XCTAssertNil(throttle.accept(makeLocation(timestamp: hugeTimestamp), now: 10))

        let firstValid = throttle.accept(makeLocation(timestamp: Date(timeIntervalSince1970: 1)), now: 10)
        XCTAssertEqual(firstValid?.sequence, 1)
        XCTAssertEqual(firstValid?.timestampMilliseconds, 1_000)
        XCTAssertEqual(firstValid?.timestampMilliseconds.isFinite, true)
    }

    func testInvalidOrBackwardClockDoesNotCorruptNewestPendingSample() throws {
        var throttle = CompanionFixThrottle()
        XCTAssertNotNil(throttle.accept(makeLocation(latitude: 1), now: 10))
        XCTAssertNil(throttle.accept(makeLocation(latitude: 2), now: 10.2))

        XCTAssertNil(throttle.accept(makeLocation(latitude: 99), now: .nan))
        XCTAssertNil(throttle.accept(makeLocation(latitude: 98), now: .infinity))
        XCTAssertNil(throttle.accept(makeLocation(latitude: 97), now: 9))
        XCTAssertNil(throttle.flushNewest(now: -.infinity))
        XCTAssertNil(throttle.flushNewest(now: 9.9))

        let retained = try XCTUnwrap(throttle.flushNewest(now: 11))
        XCTAssertEqual(retained.sequence, 2)
        XCTAssertEqual(retained.latitude, 2)
    }

    func testInvalidSampleInsideWindowDoesNotReplaceValidPending() throws {
        var throttle = CompanionFixThrottle()
        XCTAssertNotNil(throttle.accept(makeLocation(latitude: 1), now: 0))
        XCTAssertNil(throttle.accept(makeLocation(latitude: 2), now: 0.2))
        XCTAssertNil(throttle.accept(makeLocation(latitude: 91), now: 0.8))

        let retained = try XCTUnwrap(throttle.flushNewest(now: 1))
        XCTAssertEqual(retained.sequence, 2)
        XCTAssertEqual(retained.latitude, 2)
    }

    func testInvalidMotionIsOmittedWhileFiniteMotionIsPreserved() throws {
        let invalidMotion: [(CLLocationDirection, CLLocationSpeed)] = [
            (-1, -1),
            (.nan, .nan),
            (.infinity, .infinity),
            (360, -1),
            (361, -1)
        ]

        for (course, speed) in invalidMotion {
            var throttle = CompanionFixThrottle()
            let fix = try XCTUnwrap(throttle.accept(makeLocation(course: course, speed: speed), now: 0))
            XCTAssertNil(fix.courseDegrees)
            XCTAssertNil(fix.speedMps)
        }

        var throttle = CompanionFixThrottle()
        let valid = try XCTUnwrap(throttle.accept(makeLocation(course: 359.999, speed: 0), now: 0))
        XCTAssertEqual(valid.courseDegrees, 359.999)
        XCTAssertEqual(valid.speedMps, 0)
    }

    func testClockGateUsesCallerMonotonicTimeRatherThanLocationTimestamp() {
        var throttle = CompanionFixThrottle()
        XCTAssertNotNil(throttle.accept(makeLocation(timestamp: Date(timeIntervalSince1970: 1_000)), now: 5))
        XCTAssertNil(throttle.accept(makeLocation(timestamp: Date(timeIntervalSince1970: 5_000)), now: 5.9))
        XCTAssertEqual(throttle.flushNewest(now: 6)?.timestampMilliseconds, 5_000_000)
    }

    private func makeLocation(
        latitude: Double = 31.2304,
        longitude: Double = 121.4737,
        accuracy: CLLocationAccuracy = 4,
        course: CLLocationDirection = 0,
        speed: CLLocationSpeed = 0,
        timestamp: Date = Date(timeIntervalSince1970: 100)
    ) -> CLLocation {
        CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: longitude),
            altitude: 0,
            horizontalAccuracy: accuracy,
            verticalAccuracy: 1,
            course: course,
            speed: speed,
            timestamp: timestamp
        )
    }
}
