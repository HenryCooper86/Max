import SwiftUI
import UIKit
import XCTest
@testable import MaxHelmet

/// The utility viewport is taller than its content in most states, and a
/// ScrollView top-aligns short content — which left 字幕 / 相册 / 设置 floating
/// directly under the caption with a large dead band beneath them.
///
/// The viewport therefore proposes its own height to its content, so a trailing
/// `Spacer` can push the controls down to the bottom edge. Without that the
/// content keeps its ideal height and the spacer collapses to nothing.
@MainActor
final class HudUtilityAnchoringTests: XCTestCase {
    private let phone15Portrait = CGSize(width: 390, height: 751)
    private let phone15Landscape = CGSize(width: 734, height: 342)
    /// Keeps rendered hierarchies alive for the duration of each test.
    private var windows: [UIWindow] = []

    override func tearDown() {
        windows.removeAll()
        super.tearDown()
    }

    private func utilityViewport(layout: HudLayout, outerSize: CGSize) -> UIScrollView? {
        let root = AnyView(
            HudRegionLayout(
                layout: layout,
                inputs: hudLayoutInputs(
                    hazardVisible: false,
                    crashCheckInVisible: false,
                    guidanceVisible: false,
                    recordingVisible: false,
                    captionsRequested: false,
                    handsFreeActive: true
                ),
                alertContent: { _ in Text("提醒") },
                helmetContent: { _ in
                    Button("开始或停止免提") {}
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                },
                utilityContent: { _ in
                    // Deliberately short: a couple of rows in a region that is
                    // over a hundred points tall.
                    VStack(alignment: .leading, spacing: 12) {
                        Text("会话状态")
                        Spacer(minLength: 0)
                        Button("设置") {}
                    }
                    .background(HudRenderProbe(identifier: HudAccessibilityID.utilityViewport))
                }
            )
            .padding(HudMetrics.contentPadding(for: layout))
        )
        let controller = UIHostingController(rootView: root)
        let window = UIWindow(frame: CGRect(origin: .zero, size: outerSize))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.frame = window.bounds
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        HudRenderProbe.waitForLayout(HudAccessibilityID.utilityViewport, in: controller.view)
        controller.view.layoutIfNeeded()
        let found = HudRenderProbe.scrollView(HudAccessibilityID.utilityViewport, in: controller.view)
        windows.append(window)
        return found
    }

    private func assertContentFillsViewport(_ layout: HudLayout, _ outerSize: CGSize, _ name: String) {
        guard let viewport = utilityViewport(layout: layout, outerSize: outerSize) else {
            return XCTFail("missing utility viewport - \(name)")
        }

        XCTAssertGreaterThan(viewport.bounds.height, 100, "\(name): region should dwarf its content")
        XCTAssertEqual(
            viewport.contentSize.height,
            viewport.bounds.height,
            accuracy: 1,
            "\(name): short content must be offered the whole region"
        )
    }

    func testPortraitOffersTheWholeRegionToShortUtilityContent() {
        assertContentFillsViewport(.portrait, phone15Portrait, "portrait")
    }

    func testLandscapeOffersTheWholeRegionToShortUtilityContent() {
        assertContentFillsViewport(.landscape, phone15Landscape, "landscape")
    }
}
