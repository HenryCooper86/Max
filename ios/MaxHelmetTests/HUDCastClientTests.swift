import CoreLocation
import XCTest
@testable import MaxHelmet

@MainActor
final class HUDCastClientTests: XCTestCase {
    func testOnlyLocalAddressesWithExplicitPortsAreAccepted() {
        XCTAssertEqual(HUDCastClient.endpoint("192.168.1.20:8080")?.absoluteString, "ws://192.168.1.20:8080/cast/socket")
        XCTAssertNotNil(HUDCastClient.endpoint("rdk.local:8080"))
        for address in ["example.com:8080", "192.168.1.20", "user@192.168.1.20:8080", "10.1.2.3.evil:8080", "192.168.1.20:8080/path"] {
            XCTAssertNil(HUDCastClient.endpoint(address), address)
        }
    }

    func testFramesPreserveGCJ02EndpointsAndBoundGeometry() throws {
        let points = (0...4096).map { CLLocationCoordinate2D(latitude: 31 + Double($0) / 100000, longitude: 121.47) }
        var guidance = GuidanceState(destinationName: "终点", polyline: points, currentLocation: points[0],
            maneuverInstruction: "右转", distanceToManeuverMeters: 120, remainingDistanceMeters: 2000,
            remainingSeconds: 300, offRoute: false)
        guidance.upcomingSteps = [NavigationStepDetail(id: 0,
            step: ManeuverStep(instruction: "右转", coordinate: points[10], alongRouteMeters: 120), distanceMeters: 120)]
        let json = try XCTUnwrap(HUDCastClient.frame(guidance, sequence: 7))
        let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let line = try XCTUnwrap(frame["polyline"] as? [[String: Double]])
        XCTAssertEqual(line.count, 2048)
        XCTAssertEqual(line.first?["lat"], points.first?.latitude)
        XCTAssertEqual(line.last?["lat"], points.last?.latitude)
        XCTAssertEqual(frame["sequence"] as? Int, 7)
        XCTAssertEqual(frame["instruction"] as? String, "右转")
        let turns = try XCTUnwrap(frame["turns"] as? [[String: Any]])
        XCTAssertEqual(turns.count, 1)
        XCTAssertEqual(turns[0]["distance"] as? Double, 120)
        XCTAssertEqual(turns[0]["lat"] as? Double, points[10].latitude)
        guidance.confirmationID = UUID()
        XCTAssertNil(HUDCastClient.frame(guidance, sequence: 8))
        guidance.confirmationID = nil
        guidance.remainingSeconds = .nan
        XCTAssertNil(HUDCastClient.frame(guidance, sequence: 8))
    }

    func testNavigationEndingStopsCasting() {
        let client = HUDCastClient()
        client.update(nil)
        XCTAssertFalse(client.active)
        XCTAssertEqual(client.status, "未投屏")
    }
}
