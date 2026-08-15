import SwiftUI
import UIKit
import XCTest
@testable import MaxHelmet

@MainActor
final class GuidanceMapLoadContainerRenderingTests: XCTestCase {
    func testFailureSequenceKeepsSameMapMountedAndSuccessRemovesOnlyOverlay() throws {
        let state = LoadState()
        let mapTracker = ViewTracker(identifier: "test.guidance.map")
        let overlayTracker = ViewTracker(identifier: "test.guidance.unavailable")
        let root = LoadContainerHarness(
            state: state,
            mapTracker: mapTracker,
            overlayTracker: overlayTracker
        )
        let controller = UIHostingController(rootView: root)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 240))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.frame = window.bounds
        settle(controller)

        let originalMap = try XCTUnwrap(
            findSubview(identifier: "test.guidance.map", in: controller.view)
        )
        XCTAssertNil(findSubview(identifier: "test.guidance.unavailable", in: controller.view))
        XCTAssertEqual(mapTracker.makeCount, 1)
        XCTAssertEqual(mapTracker.dismantleCount, 0)

        for _ in 0..<10 {
            state.loadFailed = true
            settle(controller)
            XCTAssertTrue(
                originalMap === findSubview(identifier: "test.guidance.map", in: controller.view)
            )
            XCTAssertNotNil(
                findSubview(identifier: "test.guidance.unavailable", in: controller.view)
            )
            XCTAssertEqual(mapTracker.makeCount, 1)
            XCTAssertEqual(mapTracker.dismantleCount, 0)
        }

        state.loadFailed = false
        settle(controller)

        XCTAssertTrue(
            originalMap === findSubview(identifier: "test.guidance.map", in: controller.view)
        )
        XCTAssertNil(findSubview(identifier: "test.guidance.unavailable", in: controller.view))
        XCTAssertEqual(mapTracker.makeCount, 1)
        XCTAssertEqual(mapTracker.dismantleCount, 0)
        XCTAssertEqual(overlayTracker.makeCount, 1)
        XCTAssertEqual(overlayTracker.dismantleCount, 1)

        state.loadFailed = true
        settle(controller)
        XCTAssertTrue(
            originalMap === findSubview(identifier: "test.guidance.map", in: controller.view)
        )
        XCTAssertNotNil(findSubview(identifier: "test.guidance.unavailable", in: controller.view))
        XCTAssertEqual(mapTracker.makeCount, 1)
        XCTAssertEqual(mapTracker.dismantleCount, 0)

        state.loadFailed = false
        settle(controller)
        XCTAssertTrue(
            originalMap === findSubview(identifier: "test.guidance.map", in: controller.view)
        )
        XCTAssertNil(findSubview(identifier: "test.guidance.unavailable", in: controller.view))
        XCTAssertEqual(overlayTracker.makeCount, 2)
        XCTAssertEqual(overlayTracker.dismantleCount, 2)

        withExtendedLifetime((window, controller)) {}
    }
}

@MainActor
private final class LoadState: ObservableObject {
    @Published var loadFailed = false
}

private struct LoadContainerHarness: View {
    @ObservedObject var state: LoadState
    let mapTracker: ViewTracker
    let overlayTracker: ViewTracker

    var body: some View {
        GuidanceMapLoadContainer(
            showsUnavailableOverlay: state.loadFailed,
            mapContent: { TrackedUIKitView(tracker: mapTracker) },
            failureOverlay: { TrackedUIKitView(tracker: overlayTracker) }
        )
    }
}

@MainActor
private final class ViewTracker {
    let identifier: String
    var makeCount = 0
    var dismantleCount = 0

    init(identifier: String) {
        self.identifier = identifier
    }
}

private struct TrackedUIKitView: UIViewRepresentable {
    let tracker: ViewTracker

    func makeCoordinator() -> Coordinator {
        Coordinator(tracker: tracker)
    }

    func makeUIView(context: Context) -> UIView {
        tracker.makeCount += 1
        let view = UIView()
        view.accessibilityIdentifier = tracker.identifier
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {}

    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
        coordinator.tracker.dismantleCount += 1
    }

    final class Coordinator {
        let tracker: ViewTracker

        init(tracker: ViewTracker) {
            self.tracker = tracker
        }
    }
}

@MainActor
private func settle(_ controller: UIViewController) {
    controller.view.setNeedsLayout()
    controller.view.layoutIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    controller.view.layoutIfNeeded()
}

private func findSubview(identifier: String, in root: UIView) -> UIView? {
    if root.accessibilityIdentifier == identifier { return root }
    for child in root.subviews {
        if let match = findSubview(identifier: identifier, in: child) { return match }
    }
    return nil
}
