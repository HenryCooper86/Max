import CoreLocation
import XCTest
@testable import MaxHelmet

final class GeoTests: XCTestCase {

    func testHaversineKnownDistance() {
        // ~111 km per degree of latitude.
        let a = CLLocationCoordinate2D(latitude: 39.0, longitude: 116.0)
        let b = CLLocationCoordinate2D(latitude: 40.0, longitude: 116.0)
        XCTAssertEqual(Geo.haversineMeters(a, b), 111_195, accuracy: 500)
    }

    func testCrossTrackDistanceToSegment() {
        // A point due east of the midpoint of a north-south segment.
        let start = CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40)
        let end = CLLocationCoordinate2D(latitude: 39.92, longitude: 116.40)
        let point = CLLocationCoordinate2D(latitude: 39.91, longitude: 116.401) // ~85 m east
        let d = Geo.crossTrackMeters(point: point, segStart: start, segEnd: end)
        XCTAssertEqual(d, 85, accuracy: 25)
    }

    func testCrossTrackClampsToSegmentEnds() {
        // A point beyond the segment end measures to the endpoint, not the line.
        let start = CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40)
        let end = CLLocationCoordinate2D(latitude: 39.91, longitude: 116.40)
        let beyond = CLLocationCoordinate2D(latitude: 39.93, longitude: 116.40)
        let d = Geo.crossTrackMeters(point: beyond, segStart: start, segEnd: end)
        XCTAssertEqual(d, Geo.haversineMeters(beyond, end), accuracy: 5)
    }

    func testNearestSegmentDistanceOverPolyline() {
        let polyline = [
            CLLocationCoordinate2D(latitude: 39.90, longitude: 116.40),
            CLLocationCoordinate2D(latitude: 39.90, longitude: 116.42),
            CLLocationCoordinate2D(latitude: 39.92, longitude: 116.42)
        ]
        let near = CLLocationCoordinate2D(latitude: 39.90, longitude: 116.41) // on first segment
        XCTAssertLessThan(Geo.nearestSegmentDistance(near, polyline), 20)
    }
}
