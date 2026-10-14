import SwiftUI
import UIKit

/// Test-only backgrounds expose rendered bounds without depending on how a
/// particular SwiftUI runtime bridges semantic accessibility into UIKit.
/// A clear, noninteractive background does not propose a size to its parent.
struct HudRenderProbe: UIViewRepresentable {
    let identifier: String

    func makeUIView(context: Context) -> HudRenderProbeView {
        let view = HudRenderProbeView()
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        view.accessibilityIdentifier = identifier
        return view
    }

    func updateUIView(_ view: HudRenderProbeView, context: Context) {
        view.accessibilityIdentifier = identifier
    }

    static func find(_ identifier: String, in root: UIView) -> UIView? {
        if root is HudRenderProbeView, root.accessibilityIdentifier == identifier { return root }
        for child in root.subviews {
            if let match = find(identifier, in: child) { return match }
        }
        return nil
    }

    /// Each probe is inside actual scroll content; its nearest UIKit scroll
    /// ancestor is the physical viewport even when that viewport has no AX ID.
    static func scrollView(_ identifier: String, in root: UIView) -> UIScrollView? {
        var ancestor = find(identifier, in: root)?.superview
        while let view = ancestor {
            if let scroll = view as? UIScrollView { return scroll }
            ancestor = view.superview
        }
        return nil
    }

    static func waitForLayout(_ identifier: String, in root: UIView) {
        let deadline = Date().addingTimeInterval(1)
        repeat {
            root.layoutIfNeeded()
            if let probe = find(identifier, in: root), probe.bounds.height > 0 { return }
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        } while Date() < deadline
    }
}

final class HudRenderProbeView: UIView {}
