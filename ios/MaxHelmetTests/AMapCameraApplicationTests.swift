import CoreLocation
import XCTest
@testable import MaxHelmet

/// `AMapRouteMap` is a `UIViewRepresentable`, and its first pass runs against a
/// map view that has no size yet (`MAMapView(frame: .zero)`). Fitting a region
/// to a zero viewport cannot take, so the SDK keeps its default camera — which
/// is why a Shanghai route rendered over Beijing with the polyline off-screen.
///
/// The camera decision therefore cannot be keyed off route identity alone: it
/// must stay pending until the view actually has bounds, then apply once.
final class AMapCameraApplicationTests: XCTestCase {
    private let bund = AMapCoordinateBounds(
        center: CLLocationCoordinate2D(latitude: 31.2312, longitude: 121.4745),
        latitudeSpan: 0.0016,
        longitudeSpan: 0.0016
    )
    private let westLake = AMapCoordinateBounds(
        center: CLLocationCoordinate2D(latitude: 30.2489, longitude: 120.1445),
        latitudeSpan: 0.0200,
        longitudeSpan: 0.0200
    )
    private let laidOut = CGSize(width: 358, height: 120)

    func testCameraIsWithheldWhileTheMapViewHasNoSize() {
        XCTAssertFalse(
            shouldApplyAMapCamera(lastApplied: nil, bounds: bund, viewportSize: .zero)
        )
    }

    func testCameraIsWithheldWhenOnlyOneAxisHasCollapsed() {
        XCTAssertFalse(
            shouldApplyAMapCamera(
                lastApplied: nil,
                bounds: bund,
                viewportSize: CGSize(width: 358, height: 0)
            )
        )
    }

    /// The regression: the zero-frame pass must not count as "already applied".
    func testCameraIsAppliedOnTheFirstPassThatHasRealBounds() {
        XCTAssertTrue(
            shouldApplyAMapCamera(lastApplied: nil, bounds: bund, viewportSize: laidOut)
        )
    }

    func testAnUnchangedRouteDoesNotRefightTheCameraOnEveryUpdate() {
        XCTAssertFalse(
            shouldApplyAMapCamera(lastApplied: bund, bounds: bund, viewportSize: laidOut)
        )
    }

    func testANewRouteRecentersTheCamera() {
        XCTAssertTrue(
            shouldApplyAMapCamera(lastApplied: westLake, bounds: bund, viewportSize: laidOut)
        )
    }
}
