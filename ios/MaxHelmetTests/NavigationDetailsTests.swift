import CoreLocation
import MediaPlayer
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

    func testDetailedLayoutSnapshot() async throws {
        try await captureLayout(size: CGSize(width: 402, height: 874), name: "riding-map-portrait")
    }

    func testLandscapeLayoutSnapshot() async throws {
        try await captureLayout(size: CGSize(width: 874, height: 402), name: "riding-map-landscape")
    }

    func testSmallPhoneLayoutSnapshot() async throws {
        try await captureLayout(size: CGSize(width: 375, height: 667), name: "riding-map-small-phone")
    }

    func testExpandedStepsPortraitSnapshot() async throws {
        try await captureLayout(size: CGSize(width: 402, height: 874), name: "expanded-steps-portrait", expanded: true)
    }

    func testExpandedStepsLandscapeSnapshot() async throws {
        try await captureLayout(size: CGSize(width: 874, height: 402), name: "expanded-steps-landscape", expanded: true)
    }

    func testExpandedStepsSmallPhoneSnapshot() async throws {
        try await captureLayout(size: CGSize(width: 375, height: 667), name: "expanded-steps-small-phone", expanded: true)
    }

    private func captureLayout(size: CGSize, name: String, expanded: Bool = false) async throws {
        let previous = UserDefaults.standard.object(forKey: AMapConsentStore.defaultsKey)
        UserDefaults.standard.set("accepted", forKey: AMapConsentStore.defaultsKey)
        defer { UserDefaults.standard.set(previous, forKey: AMapConsentStore.defaultsKey) }
        let music = MusicPlaybackModel(prefersQQMusic: false, player: NavigationPreviewMusicDriver(), requestAuthorization: { .authorized })
        let controller = UIHostingController(rootView: NavigationDetailsView(guidance: guidance(), music: music, initiallyShowsSteps: expanded))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.frame = window.bounds
        controller.view.layoutIfNeeded()
        // A voice request arrives after the map is already open. Both screens
        // must observe this same model while playback begins.
        _ = await music.perform(.play)
        XCTAssertTrue(music.visible)
        try await Task.sleep(nanoseconds: 500_000_000)
        controller.view.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(size: window.bounds.size).image { _ in
            XCTAssertTrue(controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true))
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
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


@MainActor
private final class NavigationPreviewMusicDriver: MusicPlaybackDriving {
    let title: String? = "Evening Ride"
    let artist: String? = "Road Mix"
    let hasItem = true
    let itemIdentity: String? = "preview-track"
    var isPlaying = false
    var notificationObject: AnyObject { self }
    func beginObserving() {}
    func endObserving() {}
    func setQueue(_ collection: MPMediaItemCollection) {}
    func prepare(_ completion: @escaping @Sendable (Error?) -> Void) { completion(nil) }
    func play() { isPlaying = true }
    func pause() { isPlaying = false }
    func next() {}
    func previous() {}
}
