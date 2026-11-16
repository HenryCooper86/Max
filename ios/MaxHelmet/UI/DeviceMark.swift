import SwiftUI
import UIKit

/// The eight bundled device marks (brand/devices/*.svg, shipped as vector
/// image sets in Assets.xcassets).
enum DeviceMark: String, CaseIterable, Equatable {
    case motorcycleHelmet = "motorcycle-helmet"
    case bicycleHelmet = "bicycle-helmet"
    case sunglasses
    case smartGlasses = "smart-glasses"
    case assistiveGlasses = "assistive-glasses"
    case arHeadset = "ar-headset"
    case vrHeadset = "vr-headset"
    case wearable

    var assetName: String { "device-" + rawValue }

    /// The relay's `deviceProfile` when it names a known mark; otherwise by
    /// device family: helmet -> motorcycle-helmet, glasses -> smart-glasses,
    /// other -> wearable.
    static func resolve(profile: String?, kind: DeviceKind) -> DeviceMark {
        if let profile = profile?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
           let mark = DeviceMark(rawValue: profile) {
            return mark
        }
        switch kind {
        case .helmet: return .motorcycleHelmet
        case .glasses: return .smartGlasses
        case .other: return .wearable
        }
    }
}

/// The assistant's mark: the owner's PNG logo from the relay when there is
/// one, otherwise the bundled device mark. Rounded square.
struct AssistantMarkView: View {
    var size: CGFloat = 28

    var body: some View {
        let theme = VisorTheme.shared
        Group {
            if let logo = theme.customLogo {
                Image(uiImage: logo).resizable().scaledToFill()
            } else {
                Image(theme.deviceMark.assetName).resizable().scaledToFit()
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
                .strokeBorder(Visor.line, lineWidth: Visor.hairline)
        )
        .accessibilityHidden(true)
    }
}
