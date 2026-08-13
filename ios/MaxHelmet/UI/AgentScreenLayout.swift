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
    /// Landscape furniture in the readout column plus the top strip. Kept for
    /// the original dock-removal regression test; allocation uses the two
    /// separate regions below because they sit beside rather than below one
    /// another.
    static let landscapeChrome: CGFloat = 118
    /// Top bar, its stack spacing, and vertical screen padding in landscape.
    static let landscapeTopChrome: CGFloat = 44
    /// The remaining landscape chrome in the readout column.
    static let landscapeReadoutChrome: CGFloat = 74
    /// Captions at their design height, plus the card padding.
    static let captionsMax: CGFloat = 218
    /// Under this the caption list shows less than two turns, at which point
    /// hiding it would be more honest than showing a sliver.
    static let captionsMin: CGFloat = 96

    /// Share of the width the helmet column takes in landscape. The rest is the
    /// readout, captions and controls, which need the wider half for text.
    static let landscapeHelmetColumn: CGFloat = 0.42
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
    captionsRequested: Bool
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
        let viewportCapacity = max(
            0,
            available.height - HudMetrics.landscapeTopChrome - HudMetrics.helmetMinDiameter
        )
        alertViewportHeight = min(contentHeight, viewportCapacity)

        let captionRoom = available.height - HudMetrics.landscapeTopChrome
            - alertViewportHeight - HudMetrics.landscapeReadoutChrome
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
