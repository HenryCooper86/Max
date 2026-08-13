import CoreGraphics

/// How the HUD arranges itself for the space it has.
///
/// The screen was one portrait column with a hard-coded 300×300 helmet and a
/// 190pt caption panel. Info.plist has always allowed landscape, and in
/// landscape an iPhone gives the app roughly 390pt of height against a stack
/// that wants ~600 — so the column overflowed and its pieces drew on top of one
/// another. Sizing lives here, as plain arithmetic, so it can be tested without
/// standing up a view.
enum HudLayout {
    case portrait
    /// Phone held sideways: helmet beside the readout instead of above it.
    case landscape
}

enum HudMetrics {
    /// The helmet's design size; it never grows past this.
    static let helmetMaxDiameter: CGFloat = 300
    /// The minimum visible and tappable diameter for the sole session control.
    /// Captions and alert scrolling yield before this Button does.
    static let helmetMinDiameter: CGFloat = 116

    /// Portrait furniture above and below the helmet: top bar, state readout,
    /// secondary controls, the VStack spacings and the screen padding.
    /// Measured against the constants in AgentScreen.swift.
    static let portraitChrome: CGFloat = 218
    /// Kept for the dock-removal regression test. Landscape allocation now
    /// measures the actual readout/control column instead of guessing it.
    static let landscapeChrome: CGFloat = 118
    /// Top bar, its stack spacing, and vertical screen padding in landscape.
    static let landscapeTopChrome: CGFloat = 44
    /// Captions at their design height, plus the card padding.
    static let captionsMax: CGFloat = 218
    /// Under this the caption list shows less than two turns, at which point
    /// hiding it would be more honest than showing a sliver.
    static let captionsMin: CGFloat = 96

    /// Share of the width the helmet column takes in landscape. The rest is the
    /// readout, captions and controls, which need the wider half for text.
    static let landscapeHelmetColumn: CGFloat = 0.42
}

/// Intrinsic heights measured from the two fixed children in landscape's right
/// column. `fixedHeight` adds the actual VStack gaps that appear with or
/// without a captions card; this avoids treating a wrapped readout as a 74pt
/// constant.
struct LandscapeColumnMetrics: Equatable {
    let readoutHeight: CGFloat
    let controlsHeight: CGFloat

    static let unmeasured = LandscapeColumnMetrics(readoutHeight: 0, controlsHeight: 0)

    func fixedHeight(captionsVisible: Bool) -> CGFloat {
        let gaps: CGFloat = captionsVisible ? 24 : 16
        return max(0, readoutHeight) + max(0, controlsHeight) + gaps
    }
}

struct LandscapeColumnSignature: Equatable {
    let token: String
}

struct LandscapeColumnMeasurement: Equatable {
    let signature: LandscapeColumnSignature
    let metrics: LandscapeColumnMetrics
}

/// A metric is only safe for the right column content and width that measured
/// it. On any mismatch, captions wait one layout pass for a fresh preference.
func landscapeColumnForLayout(
    signature: LandscapeColumnSignature,
    measurement: LandscapeColumnMeasurement?
) -> LandscapeColumnMetrics? {
    guard let measurement, measurement.signature == signature else { return nil }
    return measurement.metrics
}

/// Alert inputs that can alter intrinsic alert height. A height preference is
/// only valid for the exact signature that produced it.
struct AlertContentSignature: Equatable {
    let hazardToken: String?
    let crashCheckInToken: String?
    let guidanceToken: String?
    let recording: Bool

    var isVisible: Bool {
        hazardToken != nil || crashCheckInToken != nil || guidanceToken != nil || recording
    }
}

struct AlertContentMeasurement: Equatable {
    let signature: AlertContentSignature
    let height: CGFloat
}

/// Rejects stale preference measurements on the same render pass that a new
/// alert arrives or expands. The caller then reserves the conservative safe
/// viewport until SwiftUI publishes a matching measurement.
func alertContentHeightForLayout(
    alertsVisible: Bool,
    signature: AlertContentSignature,
    measurement: AlertContentMeasurement?,
    availableHeight: CGFloat
) -> CGFloat {
    guard alertsVisible,
          let measurement,
          measurement.signature == signature
    else {
        return alertsVisible ? max(0, availableHeight) : 0
    }
    return max(0, measurement.height)
}

/// Landscape whenever the vertical space is compact — the same signal
/// `UIUserInterfaceSizeClass.compact` carries, passed in as a Bool so this
/// stays free of UIKit and testable.
func hudLayout(verticalSizeClassIsCompact: Bool) -> HudLayout {
    verticalSizeClassIsCompact ? .landscape : .portrait
}

/// The vertical allocation AgentScreen applies to its measured alerts,
/// semantic helmet Button, and optional captions.
struct HudAllocation: Equatable {
    let alertViewportHeight: CGFloat
    let helmetDiameter: CGFloat
    let captionsHeight: CGFloat?
    let alertsAreScrollable: Bool
}

/// Allocates a bounded alert viewport separately from alert content.
///
/// Guidance can grow for wrapping or Dynamic Type, but it may only use the
/// viewport left after fixed chrome and the 116pt helmet target. Captions take
/// the remaining optional space and never reduce that target.
func hudAllocation(
    layout: HudLayout,
    available: CGSize,
    alertContentHeight: CGFloat,
    captionsRequested: Bool,
    landscapeColumn: LandscapeColumnMetrics? = nil
) -> HudAllocation {
    let contentHeight = max(0, alertContentHeight)
    let alertViewportHeight: CGFloat
    let captionsHeight: CGFloat?
    let helmetDiameter: CGFloat

    switch layout {
    case .portrait:
        let viewportCapacity = max(
            0,
            available.height - HudMetrics.portraitChrome - HudMetrics.helmetMinDiameter
        )
        alertViewportHeight = min(contentHeight, viewportCapacity)

        let captionRoom = available.height - HudMetrics.portraitChrome
            - alertViewportHeight - HudMetrics.helmetMinDiameter
        captionsHeight = captionsRequested && captionRoom >= HudMetrics.captionsMin
            ? min(HudMetrics.captionsMax, captionRoom)
            : nil

        let remainingHeight = available.height - HudMetrics.portraitChrome
            - alertViewportHeight - (captionsHeight ?? 0)
        helmetDiameter = min(HudMetrics.helmetMaxDiameter, max(HudMetrics.helmetMinDiameter, remainingHeight))

    case .landscape:
        // Until the fixed column measures, suppress optional captions rather
        // than risk them covering the mute/secondary controls for one pass.
        let captionsRequested = captionsRequested && landscapeColumn != nil
        let column = landscapeColumn ?? .unmeasured
        let minimumRowHeight = max(
            HudMetrics.helmetMinDiameter,
            column.fixedHeight(captionsVisible: false)
        )
        let viewportCapacity = max(
            0,
            available.height - HudMetrics.landscapeTopChrome - minimumRowHeight
        )
        alertViewportHeight = min(contentHeight, viewportCapacity)

        let captionRoom = available.height - HudMetrics.landscapeTopChrome
            - alertViewportHeight - column.fixedHeight(captionsVisible: true)
        captionsHeight = captionsRequested && captionRoom >= HudMetrics.captionsMin
            ? min(HudMetrics.captionsMax, captionRoom)
            : nil

        let heightForHelmet = available.height - HudMetrics.landscapeTopChrome - alertViewportHeight
        helmetDiameter = min(
            HudMetrics.helmetMaxDiameter,
            max(
                HudMetrics.helmetMinDiameter,
                min(heightForHelmet, available.width * HudMetrics.landscapeHelmetColumn)
            )
        )
    }

    return HudAllocation(
        alertViewportHeight: alertViewportHeight,
        helmetDiameter: helmetDiameter,
        captionsHeight: captionsHeight,
        alertsAreScrollable: contentHeight > alertViewportHeight
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
