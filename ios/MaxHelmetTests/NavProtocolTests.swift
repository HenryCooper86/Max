import CoreLocation
import XCTest
@testable import MaxHelmet

final class NavProtocolTests: XCTestCase {

    func testParsesNavRouteWithStepsAndPolyline() {
        let event = parseAgentEvent(#"""
        {
          "type": "nav.route",
          "commandId": "nav-1",
          "destinationName": "人民广场",
          "destination": {"lat": 31.2304, "lon": 121.4737},
          "distanceMeters": 5230.5,
          "etaSeconds": 900,
          "polyline": [
            {"lat": 31.2, "lon": 121.4},
            {"lat": 31.21, "lon": 121.41},
            {"lat": 31.2304, "lon": 121.4737}
          ],
          "steps": [
            {"instruction": "沿人民路直行300米", "lat": 31.205, "lon": 121.405, "alongRouteMeters": 300},
            {"instruction": "右转进入南京路", "lat": 31.21, "lon": 121.41, "alongRouteMeters": 1200}
          ]
        }
        """#)

        guard case let .navRoute(route) = event else {
            return XCTFail("expected navRoute, got \(event)")
        }

        XCTAssertEqual(route.commandId, "nav-1")
        XCTAssertEqual(route.destinationName, "人民广场")
        XCTAssertTrue(coordinatesEqual(route.destination, CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737)))
        XCTAssertEqual(route.distanceMeters, 5230.5)
        XCTAssertEqual(route.etaSeconds, 900)

        XCTAssertEqual(route.polyline.count, 3)
        XCTAssertTrue(coordinatesEqual(route.polyline[0], CLLocationCoordinate2D(latitude: 31.2, longitude: 121.4)))
        XCTAssertTrue(coordinatesEqual(route.polyline[1], CLLocationCoordinate2D(latitude: 31.21, longitude: 121.41)))
        XCTAssertTrue(coordinatesEqual(route.polyline[2], CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737)))

        XCTAssertEqual(route.steps.count, 2)
        XCTAssertEqual(route.steps[0].instruction, "沿人民路直行300米")
        XCTAssertTrue(coordinatesEqual(route.steps[0].coordinate, CLLocationCoordinate2D(latitude: 31.205, longitude: 121.405)))
        XCTAssertEqual(route.steps[0].alongRouteMeters, 300)
        XCTAssertEqual(route.steps[1].instruction, "右转进入南京路")
        XCTAssertTrue(coordinatesEqual(route.steps[1].coordinate, CLLocationCoordinate2D(latitude: 31.21, longitude: 121.41)))
        XCTAssertEqual(route.steps[1].alongRouteMeters, 1200)
    }

    func testParsesNavError() {
        let event = parseAgentEvent(#"{"type":"nav.error","commandId":"nav-2","code":"destination.notFound"}"#)

        guard case let .navError(commandId, code) = event else {
            return XCTFail("expected navError, got \(event)")
        }
        XCTAssertEqual(commandId, "nav-2")
        XCTAssertEqual(code, "destination.notFound")
    }

    func testMalformedNavRouteMissingPolylineIsUnhandled() {
        let event = parseAgentEvent(#"""
        {
          "type": "nav.route",
          "commandId": "nav-3",
          "destinationName": "人民广场",
          "destination": {"lat": 31.2304, "lon": 121.4737},
          "distanceMeters": 5230.5,
          "etaSeconds": 900,
          "steps": []
        }
        """#)

        guard case .unhandled = event else {
            return XCTFail("expected unhandled, got \(event)")
        }
    }

    func testBuildNavRequestStartShapeOmitsDestinationKeys() throws {
        let json = buildNavRequest(commandId: "c1", reason: "start", originLat: 31.2304, originLon: 121.4737,
                                   query: "人民广场", destinationLat: nil, destinationLon: nil, destinationName: nil)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])

        XCTAssertEqual(parsed["type"] as? String, ClientEventTypes.navRequest)
        XCTAssertEqual(parsed["commandId"] as? String, "c1")
        XCTAssertEqual(parsed["reason"] as? String, "start")
        let origin = try XCTUnwrap(parsed["origin"] as? [String: Any])
        XCTAssertEqual(origin["lat"] as? Double, 31.2304)
        XCTAssertEqual(origin["lon"] as? Double, 121.4737)
        XCTAssertEqual(parsed["query"] as? String, "人民广场")
        XCTAssertNil(parsed["destination"])
        XCTAssertNil(parsed["destinationName"])
    }

    func testBuildNavRequestRerouteShapeOmitsQueryKey() throws {
        let json = buildNavRequest(commandId: "c2", reason: "reroute", originLat: 31.24, originLon: 121.49,
                                   query: nil, destinationLat: 31.2304, destinationLon: 121.4737, destinationName: "人民广场")
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])

        XCTAssertEqual(parsed["type"] as? String, ClientEventTypes.navRequest)
        XCTAssertEqual(parsed["reason"] as? String, "reroute")
        XCTAssertNil(parsed["query"])
        let destination = try XCTUnwrap(parsed["destination"] as? [String: Any])
        XCTAssertEqual(destination["lat"] as? Double, 31.2304)
        XCTAssertEqual(destination["lon"] as? Double, 121.4737)
        XCTAssertEqual(parsed["destinationName"] as? String, "人民广场")
    }
}
