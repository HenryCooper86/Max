import CoreLocation
import SwiftUI
import XCTest
@testable import MaxHelmet

@MainActor
final class NavigationDetailsTests: XCTestCase {
    private let start = CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737)
    private var route: NavigationRoute {
        let end = CLLocationCoordinate2D(latitude: 31.33, longitude: 121.57)
        return NavigationRoute(destinationName: "上海外滩", destinationCoordinate: end,
            polyline: [start, end], steps: [
                ManeuverStep(instruction: "右转进入南京东路", coordinate: start, alongRouteMeters: 500),
                ManeuverStep(instruction: "左转进入中山东一路，沿道路向北行驶", coordinate: end, alongRouteMeters: 1200)
            ], totalDistanceMeters: 2000, totalEtaSeconds: 600)
    }

    func testUpcomingTurnsOmitPassedStepsAndUseDistanceFromRider() {
        let steps = navigationStepDetails(route: route, index: 1, remainingMeters: 1200)
        XCTAssertEqual(steps.map(\.id), [1])
        XCTAssertEqual(steps.first?.distanceMeters, 400)
        XCTAssertTrue(navigationStepDetails(route: route, index: 2, remainingMeters: 0).isEmpty)
    }

    func testStreetCameraFollowsConvertedRiderAndTurnMarker() throws {
        let state = guidance()
        let overview = try XCTUnwrap(AMapRouteDisplayModel.make(guidance: state))
        let detail = try XCTUnwrap(AMapRouteDisplayModel.make(guidance: state, followsRider: true))
        let rider = CoordinateDatum.wgs84ToGcj02(start)
        XCTAssertEqual(detail.bounds.center.latitude, rider.latitude, accuracy: 0.000001)
        XCTAssertEqual(detail.bounds.center.longitude, rider.longitude, accuracy: 0.000001)
        XCTAssertLessThan(detail.bounds.latitudeSpan, overview.bounds.latitudeSpan)
        XCTAssertTrue(coordinatesEqual(try XCTUnwrap(detail.nextTurn), rider))
        XCTAssertEqual(detail.destinationName, "上海外滩")
    }

    func testManeuverIconsMatchInstructions() {
        XCTAssertEqual(navigationManeuverSymbol("左转进入中山路"), "arrow.turn.up.left")
        XCTAssertEqual(navigationManeuverSymbol("右转"), "arrow.turn.up.right")
        XCTAssertEqual(navigationManeuverSymbol("掉头"), "arrow.uturn.left")
        XCTAssertEqual(navigationManeuverSymbol("直行"), "arrow.up")
    }

    func testDetailedLayoutSnapshot() throws {
        let previous = UserDefaults.standard.object(forKey: AMapConsentStore.defaultsKey)
        UserDefaults.standard.set("accepted", forKey: AMapConsentStore.defaultsKey)
        defer { UserDefaults.standard.set(previous, forKey: AMapConsentStore.defaultsKey) }
        let controller = UIHostingController(rootView: NavigationDetailsView(guidance: guidance()))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.frame = window.bounds
        controller.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        controller.view.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(size: window.bounds.size).image { _ in
            XCTAssertTrue(controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true))
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = "navigation-details-portrait"
        attachment.lifetime = .keepAlways
        add(attachment)
        window.isHidden = true
    }

    private func guidance() -> GuidanceState {
        GuidanceState(destinationName: route.destinationName, polyline: route.polyline,
            currentLocation: start, maneuverInstruction: route.steps[0].instruction,
            distanceToManeuverMeters: 500, remainingDistanceMeters: 2000,
            remainingSeconds: 600, offRoute: false,
            upcomingSteps: navigationStepDetails(route: route, index: 0, remainingMeters: 2000))
    }
}
