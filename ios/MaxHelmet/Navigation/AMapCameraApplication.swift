import CoreGraphics

/// Decides when the route camera may be applied to the map view.
///
/// `UIViewRepresentable.makeUIView` builds `MAMapView(frame: .zero)` and runs
/// before SwiftUI has given the view a size. AMap cannot fit a region to a zero
/// viewport, so that attempt is silently dropped and the SDK keeps its default
/// camera. Treating the zero-frame pass as "already applied" therefore strands
/// the map on the default city with the route drawn off-screen — the camera
/// must stay pending until the viewport has real bounds, then apply once.
///
/// Kept free of the AMap SDK (and of the `targetEnvironment(simulator)` gate
/// around `AMapRouteMap`) so the rule is testable without a device.
func shouldApplyAMapCamera(
    lastApplied: AMapCoordinateBounds?,
    bounds: AMapCoordinateBounds,
    viewportSize: CGSize
) -> Bool {
    guard viewportSize.width > 0, viewportSize.height > 0 else { return false }
    guard let lastApplied else { return true }
    return lastApplied != bounds
}
