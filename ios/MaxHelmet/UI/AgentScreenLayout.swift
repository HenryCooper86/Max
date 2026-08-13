import CoreGraphics

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
}

/// Inputs that may select visibility, but deliberately contain no intrinsic
/// alert, captions, or readout measurement. Those views scroll within their
/// allocated regions instead of feeding geometry back to the parent.
struct HudLayoutInputs: Equatable {
    let alertsVisible: Bool
    let captionsRequested: Bool
    let handsFreeActive: Bool
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
        let maximumHeader = max(
            0,
            height - HudMetrics.helmetMinDiameter
                - HudMetrics.utilityViewportMinimum
                - HudMetrics.portraitStackGaps
        )
        let desiredHeader = inputs.alertsVisible
            ? HudMetrics.portraitAlertViewportCap
            : HudMetrics.topBarHeight
        let header = min(desiredHeader, maximumHeader)
        let remainingAfterHeader = max(0, height - header - HudMetrics.portraitStackGaps)
        let helmet = min(
            HudMetrics.helmetMaxDiameter,
            max(HudMetrics.helmetMinDiameter, remainingAfterHeader - HudMetrics.utilityViewportMinimum)
        )
        let utility = max(0, remainingAfterHeader - helmet)
        let captionsVisible = inputs.captionsRequested
            && utility >= HudMetrics.utilityViewportMinimum + HudMetrics.captionsMinimumRoom

        return HudDeterministicAllocation(
            alertViewportHeight: header,
            helmetDiameter: helmet,
            utilityViewportHeight: utility,
            captionsVisible: captionsVisible
        )

    case .landscape:
        let maximumHeader = max(0, height - HudMetrics.helmetMinDiameter - HudMetrics.landscapeStackGap)
        let desiredHeader = inputs.alertsVisible
            ? HudMetrics.landscapeAlertViewportCap
            : HudMetrics.topBarHeight
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
            && rowHeight >= HudMetrics.utilityViewportMinimum + HudMetrics.captionsMinimumRoom

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
