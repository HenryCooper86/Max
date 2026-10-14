import SwiftUI
import UIKit
import XCTest
@testable import MaxHelmet

/// Renderer-level contracts for the production HUD region component. These
/// tests inspect actual UIKit scroll views and rendered fixture bounds instead
/// of reasserting the allocator's return values.
@MainActor
final class HudRegionLayoutRenderingTests: XCTestCase {
    private let phone15Portrait = CGSize(width: 390, height: 751)
    private let phone15Landscape = CGSize(width: 734, height: 342)
    private let phoneSEPortrait = CGSize(width: 375, height: 647)
    private let phoneSELandscape = CGSize(width: 667, height: 355)

    func testActualHudRegionsKeepHelmetAndViewportsStableWhileRenderedAlertsGrow() {
        let inputs = hudLayoutInputs(
            hazardVisible: true,
            crashCheckInVisible: true,
            guidanceVisible: true,
            recordingVisible: true,
            captionsRequested: true,
            handsFreeActive: true
        )
        var helmetFrames: [CGRect] = []
        var alertContentHeights: [CGFloat] = []

        // Each fixture changes a real rendered alert view, not an unused loop
        // variable. Larger guidance text must grow the scroll content only.
        for alertContentHeight in [CGFloat(0), 232, 320, 500] {
            let rendered = render(
                layout: .portrait,
                outerSize: phone15Portrait,
                inputs: inputs,
                alertContentHeight: alertContentHeight,
                utilityContentHeight: 500
            )
            let helmet = requiredRenderedView(HudAccessibilityID.helmetButton, in: rendered.controller.view)
            let alertViewport = requiredScrollView(HudAccessibilityID.alertViewport, in: rendered.controller.view)
            let utilityViewport = requiredScrollView(HudAccessibilityID.utilityViewport, in: rendered.controller.view)

            helmetFrames.append(helmet.bounds)
            alertContentHeights.append(alertViewport.contentSize.height)
            XCTAssertGreaterThanOrEqual(helmet.bounds.height, 116)
            XCTAssertEqual(helmet.bounds.height, 300, accuracy: 0.5)
            // Navigating: the viewport takes the whole guidance card (284) so
            // the route map is not clipped, and the utility row keeps what is
            // left after the helmet holds its full 300.
            XCTAssertEqual(alertViewport.bounds.height, 284, accuracy: 0.5)
            XCTAssertEqual(utilityViewport.bounds.height, 115, accuracy: 0.5)
            XCTAssertTrue(alertViewport.isScrollEnabled)
            XCTAssertTrue(utilityViewport.isScrollEnabled)
            XCTAssertNotNil(HudRenderProbe.find(HudAccessibilityID.guidanceMapAction, in: rendered.controller.view))
            XCTAssertNotNil(HudRenderProbe.find(HudAccessibilityID.muteUtility, in: rendered.controller.view))
            XCTAssertNotNil(HudRenderProbe.find(HudAccessibilityID.secondaryAction, in: rendered.controller.view))
            assertRenderedAction(HudAccessibilityID.guidanceMapAction, belongsTo: alertViewport, in: rendered.controller.view)
            assertRenderedAction(HudAccessibilityID.muteUtility, belongsTo: utilityViewport, in: rendered.controller.view, minimumHeight: 44)
            assertRenderedAction(HudAccessibilityID.secondaryAction, belongsTo: utilityViewport, in: rendered.controller.view)
            XCTAssertEqual(allScrollViews(in: rendered.controller.view).count, 2, "captions must not introduce a nested vertical scroll view")
        }

        XCTAssertEqual(helmetFrames.map(\.size), Array(repeating: helmetFrames[0].size, count: helmetFrames.count))
        XCTAssertGreaterThan(alertContentHeights[3], alertContentHeights[0])

        let overflowing = render(
            layout: .portrait,
            outerSize: phone15Portrait,
            inputs: inputs,
            alertContentHeight: 500,
            utilityContentHeight: 500
        )
        let alertViewport = requiredScrollView(HudAccessibilityID.alertViewport, in: overflowing.controller.view)
        let utilityViewport = requiredScrollView(HudAccessibilityID.utilityViewport, in: overflowing.controller.view)
        XCTAssertGreaterThan(alertViewport.contentSize.height, alertViewport.bounds.height)
        XCTAssertGreaterThan(utilityViewport.contentSize.height, utilityViewport.bounds.height)
    }

    func testActualHudRegionsUseOuterDeviceSizesAfterProductionPadding() {
        let inputs = hudLayoutInputs(
            hazardVisible: true,
            crashCheckInVisible: true,
            guidanceVisible: true,
            recordingVisible: true,
            captionsRequested: true,
            handsFreeActive: true
        )
        let fixtures: [(String, HudLayout, CGSize, CGSize, CGFloat, CGFloat)] = [
            // Navigating, so the alert viewport asks for the whole 284-point
            // guidance card. Portrait grants it outright. Landscape cannot:
            // the helmet's 116-point floor and its 8-point gap cap the header
            // at 198/211, and the helmet falls to that floor to pay for it.
            ("iPhone 15 portrait", .portrait, phone15Portrait, CGSize(width: 350, height: 723), 300, 284),
            ("iPhone SE portrait", .portrait, phoneSEPortrait, CGSize(width: 335, height: 619), 259, 284),
            ("iPhone 15 landscape", .landscape, phone15Landscape, CGSize(width: 702, height: 322), 116, 198),
            ("iPhone SE landscape", .landscape, phoneSELandscape, CGSize(width: 635, height: 335), 116, 211),
        ]

        for (name, layout, outerSize, expectedProposal, expectedHelmet, expectedAlertViewport) in fixtures {
            XCTAssertEqual(
                hudGeometryProposal(outerSize: outerSize, layout: layout),
                expectedProposal,
                "\(name) must subtract the real HUD padding exactly once"
            )

            let rendered = render(
                layout: layout,
                outerSize: outerSize,
                inputs: inputs,
                alertContentHeight: 500,
                utilityContentHeight: 500
            )
            let helmet = requiredRenderedView(HudAccessibilityID.helmetButton, in: rendered.controller.view)
            let alertViewport = requiredScrollView(HudAccessibilityID.alertViewport, in: rendered.controller.view)
            XCTAssertEqual(helmet.bounds.height, expectedHelmet, accuracy: 0.5, "\(name)")
            XCTAssertEqual(alertViewport.bounds.height, expectedAlertViewport, accuracy: 0.5, "\(name)")
            XCTAssertGreaterThanOrEqual(helmet.bounds.height, 116, "\(name)")
        }
    }

    func testVisibleStateMappingSeparatesAlertSourcesAndMakesActiveMuteReachable() {
        let active = hudLayoutInputs(
            hazardVisible: true,
            crashCheckInVisible: true,
            guidanceVisible: true,
            recordingVisible: true,
            captionsRequested: true,
            handsFreeActive: true
        )
        let inactive = hudLayoutInputs(
            hazardVisible: false,
            crashCheckInVisible: false,
            guidanceVisible: false,
            recordingVisible: false,
            captionsRequested: true,
            handsFreeActive: false
        )

        XCTAssertTrue(active.hazardVisible)
        XCTAssertTrue(active.crashCheckInVisible)
        XCTAssertTrue(active.guidanceVisible)
        XCTAssertTrue(active.recordingVisible)
        XCTAssertTrue(active.alertsVisible)
        XCTAssertTrue(active.muteUtilityVisible)
        XCTAssertFalse(inactive.alertsVisible)
        XCTAssertFalse(inactive.muteUtilityVisible)
        XCTAssertGreaterThan(
            hudUtilityViewportMinimum(for: active),
            hudUtilityViewportMinimum(for: inactive),
            "an active mute control has a larger minimum utility region"
        )

        let rendered = render(
            layout: .landscape,
            outerSize: phoneSELandscape,
            inputs: active,
            alertContentHeight: 500,
            utilityContentHeight: 500
        )
        XCTAssertNotNil(HudRenderProbe.find(HudAccessibilityID.muteUtility, in: rendered.controller.view))
    }

    func testRenderedGeometryDoesNotDependOnSwiftUIAccessibilityExposure() {
        let rendered = render(
            layout: .portrait,
            outerSize: phone15Portrait,
            inputs: HudLayoutInputs(alertsVisible: true, captionsRequested: true, handsFreeActive: true),
            alertContentHeight: 500,
            utilityContentHeight: 500,
            accessibilityHidden: true
        )
        let alert = requiredScrollView(HudAccessibilityID.alertViewport, in: rendered.controller.view)
        let utility = requiredScrollView(HudAccessibilityID.utilityViewport, in: rendered.controller.view)
        let helmet = requiredRenderedView(HudAccessibilityID.helmetButton, in: rendered.controller.view)
        XCTAssertEqual(alert.bounds.height, 220, accuracy: 0.5)
        XCTAssertEqual(helmet.bounds.height, 300, accuracy: 0.5)
        XCTAssertGreaterThan(alert.contentSize.height, alert.bounds.height)
        XCTAssertGreaterThan(utility.contentSize.height, utility.bounds.height)
        XCTAssertEqual(allScrollViews(in: rendered.controller.view).count, 2)
        assertRenderedAction(HudAccessibilityID.muteUtility, belongsTo: utility, in: rendered.controller.view, minimumHeight: 44)
    }

    private func render(
        layout: HudLayout,
        outerSize: CGSize,
        inputs: HudLayoutInputs,
        alertContentHeight: CGFloat,
        utilityContentHeight: CGFloat,
        accessibilityHidden: Bool = false
    ) -> RenderedHud {
        let root = AnyView(
            HudRegionLayout(
                layout: layout,
                inputs: inputs,
                alertContent: { _ in
                    VStack(alignment: .leading, spacing: 8) {
                        Text("安全和导航提醒")
                        Button("启用地图") {}
                            .accessibilityIdentifier(HudAccessibilityID.guidanceMapAction)
                            .background(HudRenderProbe(identifier: HudAccessibilityID.guidanceMapAction))
                        Color.clear.frame(height: alertContentHeight)
                    }
                    .background(HudRenderProbe(identifier: HudAccessibilityID.alertViewport))
                },
                helmetContent: { _ in
                    Button("开始或停止免提") {}
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .contentShape(Rectangle())
                        .background(HudRenderProbe(identifier: HudAccessibilityID.helmetButton))
                },
                utilityContent: { _ in
                    VStack(alignment: .leading, spacing: 8) {
                        Text("会话状态")
                        Color.clear.frame(height: utilityContentHeight)
                        if inputs.muteUtilityVisible {
                            Button("静音") {}
                                .frame(minHeight: 44)
                                .accessibilityIdentifier(HudAccessibilityID.muteUtility)
                                .background(HudRenderProbe(identifier: HudAccessibilityID.muteUtility))
                        }
                        Button("设置") {}
                            .accessibilityIdentifier(HudAccessibilityID.secondaryAction)
                            .background(HudRenderProbe(identifier: HudAccessibilityID.secondaryAction))
                    }
                    .background(HudRenderProbe(identifier: HudAccessibilityID.utilityViewport))
                }
            )
            // This is the same outer padding AgentScreen applies before the
            // production component's GeometryReader receives its proposal.
            .padding(HudMetrics.contentPadding(for: layout))
            .accessibilityHidden(accessibilityHidden)
        )
        let controller = UIHostingController(rootView: root)
        let window = UIWindow(frame: CGRect(origin: .zero, size: outerSize))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.frame = window.bounds
        // The fixtures are HUD-safe outer rectangles. A newly created window
        // otherwise injects the simulator's status-bar inset a second time;
        // this public UIKit test-host setting removes only that host artifact.
        let systemSafeArea = controller.view.safeAreaInsets
        controller.additionalSafeAreaInsets = UIEdgeInsets(
            top: -systemSafeArea.top,
            left: -systemSafeArea.left,
            bottom: -systemSafeArea.bottom,
            right: -systemSafeArea.right
        )
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        HudRenderProbe.waitForLayout(HudAccessibilityID.utilityViewport, in: controller.view)
        controller.view.layoutIfNeeded()
        return RenderedHud(window: window, controller: controller)
    }

    private func requiredScrollView(_ identifier: String, in root: UIView) -> UIScrollView {
        guard let scrollView = HudRenderProbe.scrollView(identifier, in: root) else {
            XCTFail("Missing physical UIScrollView for fixture \(identifier): \(viewTree(root))")
            return UIScrollView()
        }
        return scrollView
    }

    private func requiredRenderedView(_ identifier: String, in root: UIView) -> UIView {
        guard let view = HudRenderProbe.find(identifier, in: root) else {
            XCTFail("Missing rendered fixture \(identifier): \(viewTree(root))")
            return UIView()
        }
        return view
    }

    private func allScrollViews(in root: UIView) -> [UIScrollView] {
        let here = (root as? UIScrollView).map { [$0] } ?? []
        return here + root.subviews.flatMap(allScrollViews)
    }

    private func assertRenderedAction(_ identifier: String, belongsTo viewport: UIScrollView, in root: UIView, minimumHeight: CGFloat = 1) {
        let action = requiredRenderedView(identifier, in: root)
        XCTAssertTrue(HudRenderProbe.scrollView(identifier, in: root) === viewport)
        XCTAssertGreaterThan(action.bounds.width, 0, identifier)
        XCTAssertGreaterThanOrEqual(action.bounds.height, minimumHeight, identifier)
        let contentFrame = action.convert(action.bounds, to: viewport)
        XCTAssertGreaterThanOrEqual(contentFrame.minY, -0.5, identifier)
        XCTAssertLessThanOrEqual(contentFrame.maxY, viewport.contentSize.height + 0.5, identifier)
        viewport.scrollRectToVisible(contentFrame, animated: false)
        viewport.layoutIfNeeded()
        let visibleFrame = action.convert(action.bounds, to: root)
            .intersection(viewport.convert(viewport.bounds, to: root))
        XCTAssertGreaterThanOrEqual(visibleFrame.height, minimumHeight - 0.5, "\(identifier) must be reachable by scrolling")
    }

    private func viewTree(_ root: UIView) -> String {
        let label = "\(type(of: root))(frame: \(root.frame), id: \(root.accessibilityIdentifier ?? "nil"), children: \(root.subviews.count))"
        return ([label] + root.subviews.map(viewTree)).joined(separator: " | ")
    }
}

private struct RenderedHud {
    let window: UIWindow
    let controller: UIViewController
}
