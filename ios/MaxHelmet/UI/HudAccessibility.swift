import SwiftUI
import UIKit

// What VoiceOver announces for the HUD's primary controls, kept as plain values
// so HudAccessibilityTests can pin them (the GuidanceCard contract pattern).

struct MuteUtilityAccessibility: Equatable {
    let label: String
    let value: String
    let hint: String
}

/// The label names the action, the value says whether the rider is heard.
func muteUtilityAccessibility(muted: Bool) -> MuteUtilityAccessibility {
    MuteUtilityAccessibility(
        label: muted ? L("pill.unmute") : L("pill.mute"),
        value: muted ? L("a11y.mute.value.off") : L("a11y.mute.value.on"),
        hint: muted ? L("a11y.mute.hint.unmute") : L("a11y.mute.hint.mute", ("name", Visor.assistantName))
    )
}

struct CrashAlarmAccessibilityContract: Equatable {
    /// The alarm covers the HUD; without the modal trait VoiceOver can still
    /// reach the controls underneath and a bystander gets lost.
    let isModal: Bool
    let titleIsHeader: Bool
}

let crashAlarmAccessibilityContract = CrashAlarmAccessibilityContract(isModal: true, titleIsHeader: true)

/// "I'm OK" alone does not say that it silences the alarm.
func crashAlarmCancelAccessibilityLabel() -> String { L("a11y.crash.cancel") }
func crashAlarmCancelAccessibilityHint() -> String { L("a11y.crash.cancel.hint") }
func crashAlarmCallAccessibilityHint(number: String) -> String { L("a11y.crash.call.hint", ("number", number)) }
func crashCheckInAccessibilityHint() -> String { L("a11y.crash.checkIn.hint") }

struct MascotAccessibilityContract: Equatable {
    let hidden: Bool
    let hitTestable: Bool
}

/// The hummingbird only reacts to the conversation; the visor under it is the control.
let mascotAccessibilityContract = MascotAccessibilityContract(hidden: true, hitTestable: false)

struct TypedInputAccessibility: Equatable {
    let fieldLabel: String
    let sendLabel: String
}

var typedInputAccessibility: TypedInputAccessibility {
    TypedInputAccessibility(fieldLabel: L("a11y.typed.field"), sendLabel: L("a11y.typed.send"))
}

// MARK: - Dynamic Type for symbols

/// The point size a HUD symbol should use so it grows with the text beside
/// it. `maximum` caps glanceable glyphs whose space on the HUD is fixed.
func hudIconPointSize(
    _ base: CGFloat,
    relativeTo style: Font.TextStyle,
    dynamicTypeSize: DynamicTypeSize,
    maximum: CGFloat? = nil
) -> CGFloat {
    let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicTypeSize))
    let scaled = UIFontMetrics(forTextStyle: style.uiTextStyle).scaledValue(for: base, compatibleWith: traits)
    guard let maximum else { return scaled }
    return min(scaled, max(maximum, base))
}

private extension Font.TextStyle {
    var uiTextStyle: UIFont.TextStyle {
        switch self {
        case .largeTitle: return .largeTitle
        case .title: return .title1
        case .title2: return .title2
        case .title3: return .title3
        case .headline: return .headline
        case .subheadline: return .subheadline
        case .callout: return .callout
        case .footnote: return .footnote
        case .caption: return .caption1
        case .caption2: return .caption2
        default: return .body
        }
    }
}

private struct HudIconModifier: ViewModifier {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let base: CGFloat
    let weight: Font.Weight
    let style: Font.TextStyle
    let maximum: CGFloat?

    func body(content: Content) -> some View {
        content.font(.system(
            size: hudIconPointSize(base, relativeTo: style, dynamicTypeSize: dynamicTypeSize, maximum: maximum),
            weight: weight
        ))
    }
}

extension View {
    /// A symbol font that scales with Dynamic Type like the text it sits beside.
    func hudIcon(_ size: CGFloat, _ weight: Font.Weight = .semibold, relativeTo style: Font.TextStyle = .body, maximum: CGFloat? = nil) -> some View {
        modifier(HudIconModifier(base: size, weight: weight, style: style, maximum: maximum))
    }
}
