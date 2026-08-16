import CoreGraphics
import SwiftUI

/// How the HUD arranges itself for the space it has.
enum HudLayout {
    case portrait
    /// Phone held sideways: helmet beside the utility/readout region.
    case landscape
}

enum HudMetrics {
    /// The helmet's visual design size; it never grows past this.
    static let helmetMaxDiameter: CGFloat = 300
    /// The minimum visible and tappable diameter for the sole session control.
    static let helmetMinDiameter: CGFloat = 116

    /// Retained dock-removal regression metrics. Deterministic allocation below
    /// uses smaller, explicit viewport budgets rather than aggregate chrome.
    static let portraitChrome: CGFloat = 218
    static let landscapeChrome: CGFloat = 118

    /// The top status strip remains visible even without alerts.
    static let topBarHeight: CGFloat = 44
    /// Alert content scrolls in this bounded viewport. It includes the top bar
    /// so one finite region owns the ordered alert stack.
    static let portraitAlertViewportCap: CGFloat = 220
    static let landscapeAlertViewportCap: CGFloat = 160
    /// Vertical gap between the top bar and the alert stack beneath it.
    static let alertStackSpacing: CGFloat = 8
    /// A live route is showing. The viewport is a bounded scroll region, so the
    /// ordinary caps clip the guidance card rather than shrinking it — half the
    /// route map in portrait, a sliver in landscape. While navigating the
    /// viewport asks for the whole card instead; the helmet-floor clamp below
    /// still wins on screens too short to grant it, and `guidanceMapHeight`
    /// shrinks the map to whatever is actually granted.
    static let guidanceAlertViewportCap: CGFloat =
        topBarHeight + alertStackSpacing + guidanceCardNominalHeight
    /// Active mute is at least 44 points; this adds its normal breathing room.
    static let utilityViewportMinimum: CGFloat = 52
    /// A useful captions card needs at least two turns beyond utility controls.
    static let captionsMinimumRoom: CGFloat = 96
    /// Stack gaps between header/helmet/utility in portrait and header/row in
    /// landscape. These are fixed view hierarchy gaps, not measured content.
    static let portraitStackGaps: CGFloat = 24
    static let landscapeStackGap: CGFloat = 8
    /// Share of width reserved for the helmet in landscape.
    static let landscapeHelmetColumn: CGFloat = 0.42

    /// AgentScreen applies this padding outside its layout GeometryReader.
    /// The pure allocation therefore receives this smaller proposal, not an
    /// outer safe-area/window size.
    static func contentPadding(for layout: HudLayout) -> EdgeInsets {
        switch layout {
        case .portrait:
            return EdgeInsets(top: 10, leading: 20, bottom: 18, trailing: 20)
        case .landscape:
            return EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16)
        }
    }
}

/// Inputs that may select visibility, but deliberately contain no intrinsic
/// alert, captions, or readout measurement. Those views scroll within their
/// allocated regions instead of feeding geometry back to the parent.
struct HudLayoutInputs: Equatable {
    let hazardVisible: Bool
    let crashCheckInVisible: Bool
    let guidanceVisible: Bool
    let recordingVisible: Bool
    let captionsRequested: Bool
    let handsFreeActive: Bool

    var alertsVisible: Bool {
        hazardVisible || crashCheckInVisible || guidanceVisible || recordingVisible
    }

    /// The mute utility is distinct from the session Button and only exists
    /// for a real active session. It alters the minimum utility space because
    /// its reachable 44-point target must fit in the scroll region.
    var muteUtilityVisible: Bool { handsFreeActive }

    /// Compatibility initializer for callers that only know whether any alert
    /// is visible. AgentScreen itself uses `hudLayoutInputs(...)` so every
    /// source remains independently observable at the production boundary.
    init(alertsVisible: Bool, captionsRequested: Bool, handsFreeActive: Bool) {
        self.init(
            hazardVisible: alertsVisible,
            crashCheckInVisible: false,
            guidanceVisible: false,
            recordingVisible: false,
            captionsRequested: captionsRequested,
            handsFreeActive: handsFreeActive
        )
    }

    init(
        hazardVisible: Bool,
        crashCheckInVisible: Bool,
        guidanceVisible: Bool,
        recordingVisible: Bool,
        captionsRequested: Bool,
        handsFreeActive: Bool
    ) {
        self.hazardVisible = hazardVisible
        self.crashCheckInVisible = crashCheckInVisible
        self.guidanceVisible = guidanceVisible
        self.recordingVisible = recordingVisible
        self.captionsRequested = captionsRequested
        self.handsFreeActive = handsFreeActive
    }
}

/// Maps the exact visible sources used by AgentScreen into independent HUD
/// inputs. Keeping them separate makes a new safety source observable without
/// reintroducing intrinsic-height measurement state.
func hudLayoutInputs(
    hazardVisible: Bool,
    crashCheckInVisible: Bool,
    guidanceVisible: Bool,
    recordingVisible: Bool,
    captionsRequested: Bool,
    handsFreeActive: Bool
) -> HudLayoutInputs {
    HudLayoutInputs(
        hazardVisible: hazardVisible,
        crashCheckInVisible: crashCheckInVisible,
        guidanceVisible: guidanceVisible,
        recordingVisible: recordingVisible,
        captionsRequested: captionsRequested,
        handsFreeActive: handsFreeActive
    )
}

/// The complete, deterministic set of frames that AgentScreen applies.
struct HudDeterministicAllocation: Equatable {
    let alertViewportHeight: CGFloat
    let helmetDiameter: CGFloat
    let utilityViewportHeight: CGFloat
    let captionsVisible: Bool

    func occupiedHeight(for layout: HudLayout) -> CGFloat {
        switch layout {
        case .portrait:
            return alertViewportHeight + helmetDiameter + utilityViewportHeight
                + HudMetrics.portraitStackGaps
        case .landscape:
            return alertViewportHeight + utilityViewportHeight
                + HudMetrics.landscapeStackGap
        }
    }
}

/// Rendering properties derived from the same deterministic allocation.
/// Keeping this explicit gives tests a production-consumed statement of the
/// scrolling/accessibility policy without inspecting source text.
struct HudRenderingPolicy: Equatable {
    let alertViewportScrolls: Bool
    let utilityViewportScrolls: Bool
    let alertChildrenRemainAccessible: Bool
    let requiresRuntimeMeasurement: Bool
    let alertViewportHeightCap: CGFloat
    let helmetButtonDiameter: CGFloat
}

/// Landscape whenever vertical space is compact. This remains UIKit-free so
/// all allocation behavior is unit-testable.
func hudLayout(verticalSizeClassIsCompact: Bool) -> HudLayout {
    verticalSizeClassIsCompact ? .landscape : .portrait
}

/// Converts the real outer HUD size to the `GeometryReader` proposal after the
/// exact padding AgentScreen applies around that reader. This is deliberately
/// the only place the outer device/safe-area dimensions are converted.
func hudGeometryProposal(outerSize: CGSize, layout: HudLayout) -> CGSize {
    let padding = HudMetrics.contentPadding(for: layout)
    return CGSize(
        width: max(0, outerSize.width - padding.leading - padding.trailing),
        height: max(0, outerSize.height - padding.top - padding.bottom)
    )
}

/// The fixed minimum that leaves active mute's 44-point target reachable.
func hudUtilityViewportMinimum(for inputs: HudLayoutInputs) -> CGFloat {
    inputs.muteUtilityVisible ? HudMetrics.utilityViewportMinimum : 0
}

/// What the alert viewport asks for before the helmet-floor clamp applies.
/// A live route asks for the whole guidance card; every other alert keeps the
/// ordinary per-orientation cap, so the map costs the HUD nothing outside
/// navigation.
func hudDesiredAlertViewportHeight(
    layout: HudLayout,
    inputs: HudLayoutInputs
) -> CGFloat {
    if inputs.guidanceVisible { return HudMetrics.guidanceAlertViewportCap }
    guard inputs.alertsVisible else { return HudMetrics.topBarHeight }
    switch layout {
    case .portrait: return HudMetrics.portraitAlertViewportCap
    case .landscape: return HudMetrics.landscapeAlertViewportCap
    }
}

/// Allocates safe HUD regions without asking SwiftUI to measure any text.
///
/// Alerts and utility content may be arbitrarily tall at Dynamic Type sizes;
/// each gets a finite ScrollView viewport. Captions are optional utility
/// content and yield before the helmet's semantic 116-point Button does.
func hudDeterministicAllocation(
    layout: HudLayout,
    available: CGSize,
    inputs: HudLayoutInputs
) -> HudDeterministicAllocation {
    let height = max(0, available.height)

    switch layout {
    case .portrait:
        let utilityMinimum = hudUtilityViewportMinimum(for: inputs)
        let maximumHeader = max(
            0,
            height - HudMetrics.helmetMinDiameter
                - utilityMinimum
                - HudMetrics.portraitStackGaps
        )
        let desiredHeader = hudDesiredAlertViewportHeight(layout: .portrait, inputs: inputs)
        let header = min(desiredHeader, maximumHeader)
        let remainingAfterHeader = max(0, height - header - HudMetrics.portraitStackGaps)
        let helmet = min(
            HudMetrics.helmetMaxDiameter,
            max(HudMetrics.helmetMinDiameter, remainingAfterHeader - utilityMinimum)
        )
        let utility = max(0, remainingAfterHeader - helmet)
        let captionsVisible = inputs.captionsRequested
            && utility >= utilityMinimum + HudMetrics.captionsMinimumRoom

        return HudDeterministicAllocation(
            alertViewportHeight: header,
            helmetDiameter: helmet,
            utilityViewportHeight: utility,
            captionsVisible: captionsVisible
        )

    case .landscape:
        let maximumHeader = max(0, height - HudMetrics.helmetMinDiameter - HudMetrics.landscapeStackGap)
        let desiredHeader = hudDesiredAlertViewportHeight(layout: .landscape, inputs: inputs)
        let header = min(desiredHeader, maximumHeader)
        let rowHeight = max(0, height - header - HudMetrics.landscapeStackGap)
        let widthCap = available.width * HudMetrics.landscapeHelmetColumn
        // A very narrow future device still gets the accessible floor. Current
        // supported phones permit the documented 0.42 cap.
        let horizontalHelmetCap = max(HudMetrics.helmetMinDiameter, widthCap)
        let helmet = min(
            HudMetrics.helmetMaxDiameter,
            max(HudMetrics.helmetMinDiameter, min(rowHeight, horizontalHelmetCap))
        )
        let captionsVisible = inputs.captionsRequested
            && rowHeight >= hudUtilityViewportMinimum(for: inputs) + HudMetrics.captionsMinimumRoom

        return HudDeterministicAllocation(
            alertViewportHeight: header,
            helmetDiameter: helmet,
            utilityViewportHeight: rowHeight,
            captionsVisible: captionsVisible
        )
    }
}

/// The policy is consumed directly by AgentScreen when constructing both
/// scroll regions. There are no GeometryReader preferences or async reducers.
func hudRenderingPolicy(
    layout: HudLayout,
    inputs: HudLayoutInputs,
    allocation: HudDeterministicAllocation
) -> HudRenderingPolicy {
    HudRenderingPolicy(
        alertViewportScrolls: inputs.alertsVisible,
        utilityViewportScrolls: true,
        alertChildrenRemainAccessible: inputs.alertsVisible,
        requiresRuntimeMeasurement: false,
        alertViewportHeightCap: allocation.alertViewportHeight,
        helmetButtonDiameter: allocation.helmetDiameter
    )
}

/// The Canvas never receives a degenerate size. Layout provides a valid value;
/// this guard is defense in depth for any future direct HelmetVisual caller.
func helmetCanvasDiameter(_ diameter: CGFloat) -> CGFloat? {
    guard diameter.isFinite,
          diameter >= HudMetrics.helmetMinDiameter,
          diameter <= HudMetrics.helmetMaxDiameter
    else { return nil }
    return diameter
}

enum HudAccessibilityID {
    static let alertViewport = "hud.alertViewport"
    static let utilityViewport = "hud.utilityViewport"
    static let helmetButton = "hud.helmetButton"
    static let guidanceMapAction = "hud.guidanceMapAction"
    static let muteUtility = "hud.muteUtility"
    static let secondaryAction = "hud.secondaryAction"
}

/// The production layout boundary: its actual `ScrollView`s, helmet frame, and
/// accessibility regions are shared by AgentScreen and renderer tests. Content
/// can grow without feeding intrinsic geometry into the allocation.
struct HudRegionLayout<AlertContent: View, HelmetContent: View, UtilityContent: View>: View {
    let layout: HudLayout
    let inputs: HudLayoutInputs
    /// Receives the viewport height it was granted so tall alert content (the
    /// guidance card's route map) can size itself to fit rather than clip.
    @ViewBuilder let alertContent: (_ viewportHeight: CGFloat) -> AlertContent
    @ViewBuilder let helmetContent: (_ diameter: CGFloat) -> HelmetContent
    @ViewBuilder let utilityContent: (_ captionsVisible: Bool) -> UtilityContent
    var utilityScrollTarget: AnyHashable? = nil

    var body: some View {
        GeometryReader { proxy in
            // AgentScreen owns the outer padding. This is the exact proposal
            // SwiftUI gives a GeometryReader after that padding is applied.
            let available = proxy.size
            let allocation = hudDeterministicAllocation(
                layout: layout,
                available: available,
                inputs: inputs
            )
            let policy = hudRenderingPolicy(layout: layout, inputs: inputs, allocation: allocation)

            Group {
                switch layout {
                case .portrait:
                    VStack(spacing: 0) {
                        alertViewport(height: allocation.alertViewportHeight, policy: policy)
                        Spacer(minLength: 0).frame(height: HudMetrics.portraitStackGaps / 2)
                        helmetContent(allocation.helmetDiameter)
                            .frame(width: allocation.helmetDiameter, height: allocation.helmetDiameter)
                            .accessibilityIdentifier(HudAccessibilityID.helmetButton)
                        Spacer(minLength: 0).frame(height: HudMetrics.portraitStackGaps / 2)
                        utilityViewport(
                            height: allocation.utilityViewportHeight,
                            captionsVisible: allocation.captionsVisible,
                            policy: policy
                        )
                    }
                case .landscape:
                    VStack(spacing: 0) {
                        alertViewport(height: allocation.alertViewportHeight, policy: policy)
                        Spacer(minLength: 0).frame(height: HudMetrics.landscapeStackGap)
                        HStack(spacing: 18) {
                            helmetContent(allocation.helmetDiameter)
                            .frame(
                                width: allocation.helmetDiameter,
                                height: allocation.utilityViewportHeight,
                                alignment: .center
                            )
                            .accessibilityIdentifier(HudAccessibilityID.helmetButton)
                            utilityViewport(
                                height: allocation.utilityViewportHeight,
                                captionsVisible: allocation.captionsVisible,
                                policy: policy
                            )
                            .frame(maxWidth: .infinity)
                        }
                        .frame(height: allocation.utilityViewportHeight)
                    }
                }
            }
            .frame(width: available.width, height: available.height)
        }
    }

    private func alertViewport(height: CGFloat, policy: HudRenderingPolicy) -> some View {
        ScrollView(.vertical) {
            alertContent(height)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDisabled(!policy.alertViewportScrolls)
        .scrollIndicators(.automatic)
        .frame(height: height)
        .accessibilityIdentifier(HudAccessibilityID.alertViewport)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("状态、安全和导航提醒")
        .accessibilityHint(policy.alertChildrenRemainAccessible ? "上下滑动可查看全部提醒" : "")
    }

    private func utilityViewport(
        height: CGFloat,
        captionsVisible: Bool,
        policy: HudRenderingPolicy
    ) -> some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                utilityContent(captionsVisible)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // Offer the whole region, so content that wants to sit at
                    // the bottom can reach it instead of being top-aligned with
                    // a dead band beneath. Taller content still grows and
                    // scrolls, since this is a minimum rather than a fixed size.
                    .frame(minHeight: height, alignment: .top)
            }
            .scrollDisabled(!policy.utilityViewportScrolls)
            .scrollIndicators(.automatic)
            .onChange(of: utilityScrollTarget) { _, target in
                if let target { withAnimation { proxy.scrollTo(target, anchor: .bottom) } }
            }
        }
        .frame(height: height)
        .accessibilityIdentifier(HudAccessibilityID.utilityViewport)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("会话状态和工具")
        .accessibilityHint("上下滑动可查看字幕和工具")
    }
}
