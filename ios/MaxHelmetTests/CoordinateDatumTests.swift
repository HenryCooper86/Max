// ios/MaxHelmetTests/CoordinateDatumTests.swift
import CoreLocation
import XCTest
@testable import MaxHelmet

final class CoordinateDatumTests: XCTestCase {
    func testLeavesPointsOutsideChinaUntouched() {
        let tokyo = CLLocationCoordinate2D(latitude: 35.683861, longitude: 139.77492)
        let converted = CoordinateDatum.wgs84ToGcj02(tokyo)
        XCTAssertEqual(converted.latitude, tokyo.latitude)
        XCTAssertEqual(converted.longitude, tokyo.longitude)
        let inverse = CoordinateDatum.gcj02ToWgs84(tokyo)
        XCTAssertEqual(inverse.latitude, tokyo.latitude)
        XCTAssertEqual(inverse.longitude, tokyo.longitude)
    }

    func testMatchesThePublishedShanghaiVector() {
        // Same eviltransform vector tests/geo.test.ts pins for the TS forward transform.
        let gcj = CoordinateDatum.wgs84ToGcj02(CLLocationCoordinate2D(latitude: 31.1774276, longitude: 121.5272106))
        XCTAssertEqual(gcj.latitude, 31.17530398, accuracy: 1e-4)
        XCTAssertEqual(gcj.longitude, 121.53146073, accuracy: 1e-4)
    }

    func testInverseRoundTripsUnderOneMeter() {
        // 1e-5 degrees ≈ 1.1 m of latitude; require better on both axes.
        for wgs in [
            CLLocationCoordinate2D(latitude: 39.911954, longitude: 116.377817), // Beijing
            CLLocationCoordinate2D(latitude: 22.543847, longitude: 113.912316), // Shenzhen
            CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737) // Shanghai
        ] {
            let roundTripped = CoordinateDatum.gcj02ToWgs84(CoordinateDatum.wgs84ToGcj02(wgs))
            XCTAssertEqual(roundTripped.latitude, wgs.latitude, accuracy: 1e-5)
            XCTAssertEqual(roundTripped.longitude, wgs.longitude, accuracy: 1e-5)
        }
    }

    func testChinaOffsetIsPlausible() {
        // Degree-hypot bound matches tests/geo.test.ts (0.0009..0.008 — the upper
        // bound is a degree-hypot proxy, looser than a naive 700 m mapping).
        let wgs = CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737)
        let gcj = CoordinateDatum.wgs84ToGcj02(wgs)
        let offset = hypot(gcj.latitude - wgs.latitude, gcj.longitude - wgs.longitude)
        XCTAssertGreaterThan(offset, 0.0009)
        XCTAssertLessThan(offset, 0.008)
    }
}
