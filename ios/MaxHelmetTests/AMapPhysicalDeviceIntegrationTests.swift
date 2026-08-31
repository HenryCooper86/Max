import XCTest
@testable import MaxHelmet

#if targetEnvironment(simulator) || !RUN_AMAP_DEVICE_INTEGRATION
final class AMapPhysicalDeviceIntegrationTests: XCTestCase {
    func testConfiguredDeviceLoadsNativeRouteMap() throws {
        throw XCTSkip("Native AMap rendering requires the explicit physical-device integration run.")
    }
}
#else
import MAMapKit
import SwiftUI
import UIKit

@MainActor
final class AMapPhysicalDeviceIntegrationTests: XCTestCase {
    func testConfiguredDeviceLoadsNativeRouteMap() throws {
        let decision = AMapConsentStore().decision
        XCTAssertEqual(
            decision,
            .accepted,
            "Accept the production AMap disclosure in the Debug route harness before this test."
        )
        let consent = try XCTUnwrap(AMapAcceptedConsent(decision: decision))
        let key = try XCTUnwrap(AMapConfiguration().apiKey, "The configured device test requires the ignored local key.")
        let model = try XCTUnwrap(
            AMapRouteDisplayModel.make(guidance: AMapDeviceValidationHarness.guidanceFixture)
        )
        let loadFinished = expectation(description: "AMap map load finished")
        let probe = DeviceMapLoadProbe(loadFinished: loadFinished)
        let root = DeviceMapRecoveryHarness(
            model: model,
            consent: consent,
            apiKey: key,
            probe: probe
        )
        let controller = UIHostingController(rootView: root)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 240))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.frame = window.bounds
        controller.view.layoutIfNeeded()

        wait(for: [loadFinished], timeout: 20)
        XCTAssertEqual(probe.callbacks.last, false)
        XCTAssertFalse(probe.failed)

        let mapView = try XCTUnwrap(findSubview(MAMapView.self, in: controller.view))
        XCTAssertEqual(mapView.overlays.count, 1)
        XCTAssertEqual(mapView.annotations.count, 1)
        XCTAssertFalse(mapView.isUserInteractionEnabled)
        XCTAssertFalse(mapView.isZoomEnabled)
        XCTAssertFalse(mapView.isScrollEnabled)
        XCTAssertFalse(mapView.isRotateEnabled)
        XCTAssertFalse(mapView.isRotateCameraEnabled)
        XCTAssertFalse(mapView.touchPOIEnabled)
        XCTAssertFalse(mapView.showsUserLocation)
        XCTAssertTrue(mapView.region.center.latitude.isFinite)
        XCTAssertTrue(mapView.region.center.longitude.isFinite)
        XCTAssertGreaterThan(mapView.region.span.latitudeDelta, 0)
        XCTAssertGreaterThan(mapView.region.span.longitudeDelta, 0)
        XCTAssertGreaterThan(mapView.logoSize.width, 0)
        XCTAssertGreaterThan(mapView.logoSize.height, 0)

        let logo = try XCTUnwrap(findAccessibilitySubview("malogo", in: mapView))
        XCTAssertFalse(logo.isHidden)
        XCTAssertGreaterThan(logo.alpha, 0)
        XCTAssertTrue(mapView.bounds.intersects(mapView.convert(logo.bounds, from: logo)))

        let snapshotFinished = expectation(description: "AMap complete snapshot")
        mapView.takeSnapshot(in: mapView.bounds, timeoutInterval: 15) { image, state in
            XCTAssertEqual(state, 1)
            XCTAssertNotNil(image)
            XCTAssertGreaterThan(image?.size.width ?? 0, 0)
            XCTAssertGreaterThan(image?.size.height ?? 0, 0)
            snapshotFinished.fulfill()
        }
        wait(for: [snapshotFinished], timeout: 20)

        withExtendedLifetime((window, controller, probe)) {}
    }
}

@MainActor
private struct DeviceMapRecoveryHarness: View {
    let model: AMapRouteDisplayModel
    let consent: AMapAcceptedConsent
    let apiKey: String
    @ObservedObject var probe: DeviceMapLoadProbe

    var body: some View {
        GuidanceMapLoadContainer(
            showsUnavailableOverlay: probe.failed,
            mapContent: {
                AMapRouteMap(
                    model: model,
                    consent: consent,
                    apiKey: apiKey,
                    loadFailed: probe.binding
                )
            },
            failureOverlay: {
                Text("地图暂不可用")
            }
        )
    }
}

@MainActor
private final class DeviceMapLoadProbe: ObservableObject {
    @Published private(set) var failed = false
    private(set) var callbacks: [Bool] = []
    private var fulfilledSuccess = false
    private let loadFinished: XCTestExpectation

    init(loadFinished: XCTestExpectation) {
        self.loadFinished = loadFinished
    }

    var binding: Binding<Bool> {
        Binding(
            get: { self.failed },
            set: { next in
                self.callbacks.append(next)
                self.failed = next
                if !next, !self.fulfilledSuccess {
                    self.fulfilledSuccess = true
                    self.loadFinished.fulfill()
                }
            }
        )
    }
}

private func findSubview<T: UIView>(_ type: T.Type, in root: UIView) -> T? {
    if let match = root as? T { return match }
    for child in root.subviews {
        if let match = findSubview(type, in: child) { return match }
    }
    return nil
}

private func findAccessibilitySubview(_ identifier: String, in root: UIView) -> UIView? {
    if root.accessibilityIdentifier == identifier { return root }
    for child in root.subviews {
        if let match = findAccessibilitySubview(identifier, in: child) { return match }
    }
    return nil
}
#endif
