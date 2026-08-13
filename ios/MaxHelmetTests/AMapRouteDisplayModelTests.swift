import CoreLocation
import XCTest
@testable import MaxHelmet

final class AMapRouteDisplayModelTests: XCTestCase {
    private func guidance(
        polyline: [CLLocationCoordinate2D],
        current: CLLocationCoordinate2D? = nil
    ) -> GuidanceState {
        GuidanceState(
            destinationName: "人民广场",
            polyline: polyline,
            currentLocation: current,
            maneuverInstruction: "右转",
            distanceToManeuverMeters: 120,
            remainingDistanceMeters: 1200,
            remainingSeconds: 300,
            offRoute: false
        )
    }

    func testConvertsRouteAndRiderToGCJ02WithoutMutatingGuidance() throws {
        let start = CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737)
        let end = CLLocationCoordinate2D(latitude: 31.2314, longitude: 121.4750)
        let input = guidance(polyline: [start, end], current: start)
        let original = input

        let model = try XCTUnwrap(AMapRouteDisplayModel.make(guidance: input))

        XCTAssertTrue(coordinatesEqual(model.polyline[0], CoordinateDatum.wgs84ToGcj02(start)))
        XCTAssertTrue(coordinatesEqual(try XCTUnwrap(model.currentLocation), CoordinateDatum.wgs84ToGcj02(start)))
        XCTAssertEqual(input, original)
    }

    func testRejectsShortOrNonFiniteGeometry() {
        let valid = CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737)
        XCTAssertNil(AMapRouteDisplayModel.make(guidance: guidance(polyline: [])))
        XCTAssertNil(AMapRouteDisplayModel.make(guidance: guidance(polyline: [valid])))
        XCTAssertNil(AMapRouteDisplayModel.make(guidance: guidance(polyline: [valid, .init(latitude: .nan, longitude: 121)])))
        XCTAssertNil(AMapRouteDisplayModel.make(guidance: guidance(polyline: [valid, valid], current: .init(latitude: 31, longitude: .infinity))))
        XCTAssertNil(AMapRouteDisplayModel.make(guidance: guidance(polyline: [valid, .init(latitude: 91, longitude: 121)])))
        XCTAssertNil(AMapRouteDisplayModel.make(guidance: guidance(polyline: [valid, valid], current: .init(latitude: 31, longitude: 181))))
    }

    func testDegenerateRouteGetsFiniteNonZeroBounds() throws {
        let point = CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737)
        let model = try XCTUnwrap(AMapRouteDisplayModel.make(guidance: guidance(polyline: [point, point])))
        XCTAssertGreaterThan(model.bounds.latitudeSpan, 0)
        XCTAssertGreaterThan(model.bounds.longitudeSpan, 0)
        XCTAssertTrue(model.bounds.latitudeSpan.isFinite)
        XCTAssertTrue(model.bounds.longitudeSpan.isFinite)
    }

    func testBoundsIncludeConvertedCurrentLocation() throws {
        let route = [
            CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737),
            CLLocationCoordinate2D(latitude: 31.2314, longitude: 121.4750)
        ]
        let current = CLLocationCoordinate2D(latitude: 31.8, longitude: 121.9)
        let model = try XCTUnwrap(AMapRouteDisplayModel.make(guidance: guidance(polyline: route, current: current)))
        let displayedCurrent = try XCTUnwrap(model.currentLocation)
        let displayedCoordinates = model.polyline + [displayedCurrent]
        let minimumLatitude = displayedCoordinates.map(\.latitude).min()!
        let maximumLatitude = displayedCoordinates.map(\.latitude).max()!
        let minimumLongitude = displayedCoordinates.map(\.longitude).min()!
        let maximumLongitude = displayedCoordinates.map(\.longitude).max()!

        XCTAssertEqual(model.bounds.center.latitude, (minimumLatitude + maximumLatitude) / 2, accuracy: 1e-10)
        XCTAssertEqual(model.bounds.center.longitude, (minimumLongitude + maximumLongitude) / 2, accuracy: 1e-10)
        XCTAssertEqual(model.bounds.latitudeSpan, maximumLatitude - minimumLatitude, accuracy: 1e-10)
        XCTAssertEqual(model.bounds.longitudeSpan, maximumLongitude - minimumLongitude, accuracy: 1e-10)
    }
}
