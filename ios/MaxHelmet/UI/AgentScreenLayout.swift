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
    /// Below this the gauge ticks stop being readable, so the layout would
    /// rather scroll the captions than shrink the helmet further.
    static let helmetMinDiameter: CGFloat = 116

    /// Portrait furniture above and below the helmet: top bar, state readout,
    /// secondary controls, mic dock, the VStack spacings and the screen
    /// padding. Measured against the constants in AgentScreen.swift.
    static let portraitChrome: CGFloat = 296
    /// A hazard banner is two lines of text plus its padding.
    static let hazardBanner: CGFloat = 100
    /// The recording pill.
    static let recordingIndicator: CGFloat = 46
    /// The turn-by-turn guidance card, when navigation is running.
    static let guidanceCard: CGFloat = 92
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

/// Everything in the portrait column that is not the helmet.
func portraitChromeHeight(
    captionsVisible: Bool,
    hazardVisible: Bool,
    recordingVisible: Bool,
    guidanceVisible: Bool = false,
    crashVisible: Bool = false
) -> CGFloat {
    var height = HudMetrics.portraitChrome
    if hazardVisible { height += HudMetrics.hazardBanner }
    if recordingVisible { height += HudMetrics.recordingIndicator }
    if guidanceVisible { height += HudMetrics.guidanceCard }
    if crashVisible { height += HudMetrics.hazardBanner }
    if captionsVisible { height += HudMetrics.captionsMax }
    return height
}

/// The helmet's on-screen diameter for the space available.
///
/// Portrait takes what the column has left; landscape is bounded by its own
/// column on one axis and the full height on the other, so the bezel stays a
/// circle rather than being squashed into the short side.
func helmetDiameter(
    layout: HudLayout,
    available: CGSize,
    captionsVisible: Bool = false,
    hazardVisible: Bool = false,
    recordingVisible: Bool = false,
    guidanceVisible: Bool = false,
    crashVisible: Bool = false
) -> CGFloat {
    let unbounded: CGFloat
    switch layout {
    case .portrait:
        let chrome = portraitChromeHeight(
            captionsVisible: captionsVisible,
            hazardVisible: hazardVisible,
            recordingVisible: recordingVisible,
            guidanceVisible: guidanceVisible,
            crashVisible: crashVisible
        )
        unbounded = available.height - chrome
    case .landscape:
        // Whichever axis runs out first, so the helmet never overlaps the
        // column beside it and never overflows the row above the dock.
        var height = available.height - HudMetrics.hazardBanner * (hazardVisible ? 1 : 0)
        height -= HudMetrics.hazardBanner * (crashVisible ? 1 : 0)
        height -= 44  // top bar + spacing
        unbounded = min(height, available.width * HudMetrics.landscapeHelmetColumn)
    }
    return max(HudMetrics.helmetMinDiameter, min(HudMetrics.helmetMaxDiameter, unbounded))
}

/// Height for the caption card, or nil when there is not enough room to show
/// one honestly. Never fixed at 190: that is what pushed the mic dock — the one
/// control a rider must be able to hit — off the bottom of the screen.
func captionsHeight(
    layout: HudLayout,
    available: CGSize,
    hazardVisible: Bool,
    recordingVisible: Bool,
    guidanceVisible: Bool = false,
    crashVisible: Bool = false
) -> CGFloat? {
    let reserved: CGFloat
    switch layout {
    case .portrait:
        reserved =
            portraitChromeHeight(
                captionsVisible: false,
                hazardVisible: hazardVisible,
                recordingVisible: recordingVisible,
                guidanceVisible: guidanceVisible,
                crashVisible: crashVisible
            ) + HudMetrics.helmetMinDiameter
    case .landscape:
        // The helmet sits beside the captions, so it costs no height here —
        // only the readout, controls, dock, top bar and any banner do.
        reserved =
            190 + (hazardVisible ? HudMetrics.hazardBanner : 0)
            + (guidanceVisible ? HudMetrics.guidanceCard : 0)
            + (crashVisible ? HudMetrics.hazardBanner : 0)
    }
    let room = available.height - reserved
    guard room >= HudMetrics.captionsMin else { return nil }
    return min(HudMetrics.captionsMax, room)
}
