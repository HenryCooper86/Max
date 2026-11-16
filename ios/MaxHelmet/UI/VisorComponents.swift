import SwiftUI

// Shared Visor building blocks. Hierarchy comes from spacing and surface steps,
// not boxes in boxes: a group is ONE surface1 card whose rows are separated by
// hairlines.

// MARK: - surfaces

/// A flat surface with a 1pt hairline.
struct VisorCard<Content: View>: View {
    var fill: Color = Visor.surface1
    var stroke: Color = Visor.line
    var radius: CGFloat = Visor.Radius.card
    var padding: CGFloat = Visor.Space.s4
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Visor.Space.s2) { content }
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(fill, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(stroke, lineWidth: Visor.hairline)
            )
    }
}

struct VisorDivider: View {
    var strong = false
    var body: some View {
        Rectangle()
            .fill(strong ? Visor.lineStrong : Visor.line)
            .frame(height: Visor.hairline)
            .accessibilityHidden(true)
    }
}

// MARK: - grouped list

/// Section header + a single card of rows (the iOS grouped-list idiom).
struct VisorGroup<Content: View>: View {
    let title: String
    var footer: String?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Visor.Space.s2) {
            Text(title)
                .visorFont(.footnote, .semibold)
                .foregroundStyle(Visor.textSecondary)
                .padding(.horizontal, Visor.Space.s4)
                .accessibilityAddTraits(.isHeader)
            VStack(spacing: 0) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Visor.surface1, in: RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous)
                        .strokeBorder(Visor.line, lineWidth: Visor.hairline)
                )
                .clipShape(RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous))
            if let footer, !footer.isEmpty {
                Text(footer)
                    .visorFont(.caption)
                    .foregroundStyle(Visor.textTertiary)
                    .padding(.horizontal, Visor.Space.s4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A row inside a `VisorGroup`: leading text, optional trailing content, a
/// hairline underneath. At least 44pt tall.
struct VisorRow<Trailing: View>: View {
    var title: String? = nil
    var subtitle: String? = nil
    var titleColor: Color = Visor.text
    var divider = true
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack(alignment: .center, spacing: Visor.Space.s3) {
            if title != nil || subtitle != nil {
                VStack(alignment: .leading, spacing: 2) {
                    if let title {
                        Text(title).visorFont(.subhead).foregroundStyle(titleColor)
                    }
                    if let subtitle {
                        Text(subtitle)
                            .visorFont(.caption)
                            .foregroundStyle(Visor.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: Visor.Space.s2)
            }
            trailing
        }
        .padding(.horizontal, Visor.Space.s4)
        .padding(.vertical, Visor.Space.s2)
        .frame(minHeight: Visor.hit)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) {
            if divider { VisorDivider().padding(.leading, Visor.Space.s4) }
        }
    }
}

extension VisorRow where Trailing == EmptyView {
    init(title: String? = nil, subtitle: String? = nil, titleColor: Color = Visor.text, divider: Bool = true) {
        self.init(title: title, subtitle: subtitle, titleColor: titleColor, divider: divider) { EmptyView() }
    }
}

/// A tappable row with a trailing chevron.
struct VisorChevronRow: View {
    let title: String
    var subtitle: String? = nil
    var titleColor: Color = Visor.text
    var enabled = true
    var divider = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VisorRow(title: title, subtitle: subtitle, titleColor: titleColor, divider: divider) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Visor.textTertiary)
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : Visor.disabledOpacity)
    }
}

/// A row with a trailing switch.
struct VisorToggleRow: View {
    let title: String
    var subtitle: String? = nil
    @Binding var isOn: Bool
    var divider = true

    var body: some View {
        VisorRow(title: title, subtitle: subtitle, divider: divider) {
            Toggle(title, isOn: $isOn)
                .labelsHidden()
                .tint(Visor.accent)
        }
    }
}

/// A single-line free text row: caption above, field below.
struct VisorFieldRow<Field: View>: View {
    let title: String
    var hint: String? = nil
    var divider = true
    @ViewBuilder let field: Field

    var body: some View {
        VStack(alignment: .leading, spacing: Visor.Space.s1) {
            Text(title).visorFont(.caption).foregroundStyle(Visor.textSecondary)
            field
                .visorFont(.subhead)
                .foregroundStyle(Visor.text)
                .tint(Visor.accent)
                .frame(minHeight: Visor.hit - Visor.Space.s2)
            if let hint {
                Text(hint)
                    .visorFont(.caption)
                    .foregroundStyle(Visor.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, Visor.Space.s4)
        .padding(.vertical, Visor.Space.s2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) {
            if divider { VisorDivider().padding(.leading, Visor.Space.s4) }
        }
    }
}

// MARK: - segmented control

struct VisorSegmentOption<Value: Hashable>: Identifiable {
    let value: Value
    let label: String
    var tint: Color? = nil
    var id: Value { value }
}

/// Trailing segmented control. Selected = accentSoft fill + accent label.
struct VisorSegmented<Value: Hashable>: View {
    let options: [VisorSegmentOption<Value>]
    let selection: Value?
    var enabled = true
    let onSelect: (Value) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options) { option in
                let selected = option.value == selection
                let tint = option.tint ?? Visor.accent
                Button { onSelect(option.value) } label: {
                    Text(option.label)
                        .visorFont(.footnote, selected ? .semibold : .regular)
                        .foregroundStyle(selected ? tint : Visor.textSecondary)
                        .lineLimit(1)
                        .padding(.horizontal, Visor.Space.s3)
                        .frame(minHeight: 32)
                        .background(
                            RoundedRectangle(cornerRadius: Visor.Radius.control - 2, style: .continuous)
                                .fill(selected ? (option.tint == nil ? Visor.accentSoft : Visor.soft(tint)) : Color.clear)
                        )
                        .frame(minHeight: Visor.hit)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(2)
        .background(Visor.surface2, in: RoundedRectangle(cornerRadius: Visor.Radius.control, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Visor.Radius.control, style: .continuous)
                .strokeBorder(Visor.line, lineWidth: Visor.hairline)
        )
        .visorAnimation(selection)
        .disabled(!enabled)
        .opacity(enabled ? 1 : Visor.disabledOpacity)
    }
}

/// Title on the left, segmented control trailing; stacks when it does not fit.
struct VisorSegmentedRow<Value: Hashable>: View {
    let title: String
    let options: [VisorSegmentOption<Value>]
    let selection: Value?
    var enabled = true
    var divider = true
    let onSelect: (Value) -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Visor.Space.s3) {
                label
                Spacer(minLength: Visor.Space.s2)
                control
            }
            VStack(alignment: .leading, spacing: Visor.Space.s2) {
                label
                ScrollView(.horizontal, showsIndicators: false) { control }
            }
        }
        .padding(.horizontal, Visor.Space.s4)
        .padding(.vertical, Visor.Space.s1)
        .frame(minHeight: Visor.hit + Visor.Space.s2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) {
            if divider { VisorDivider().padding(.leading, Visor.Space.s4) }
        }
    }

    private var label: some View {
        Text(title).visorFont(.subhead).foregroundStyle(Visor.text)
    }

    private var control: some View {
        VisorSegmented(options: options, selection: selection, enabled: enabled, onSelect: onSelect)
    }
}

// MARK: - buttons

enum VisorButtonKind { case primary, secondary, destructive, plain }

struct VisorButtonStyle: ButtonStyle {
    var kind: VisorButtonKind = .secondary
    var fullWidth = true
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        let fg: Color = {
            switch kind {
            case .primary: return Visor.onAccent
            case .secondary: return Visor.text
            case .destructive: return Visor.danger
            case .plain: return Visor.accent
            }
        }()
        let bg: Color = {
            switch kind {
            case .primary: return Visor.accent
            case .secondary: return Visor.surface3
            case .destructive: return Visor.dangerSoft
            case .plain: return .clear
            }
        }()
        configuration.label
            .visorFont(.subhead, .semibold)
            .foregroundStyle(fg)
            .padding(.horizontal, Visor.Space.s4)
            .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: Visor.hit)
            .background(bg, in: RoundedRectangle(cornerRadius: Visor.Radius.control, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Visor.Radius.control, style: .continuous))
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : Visor.disabledOpacity)
            .animation(reduceMotion ? nil : .easeOut(duration: Visor.Motion.fast), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == VisorButtonStyle {
    static func visor(_ kind: VisorButtonKind = .secondary, fullWidth: Bool = true) -> VisorButtonStyle {
        VisorButtonStyle(kind: kind, fullWidth: fullWidth)
    }
}

private struct VisorPillCompactKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
    /// Tighter pill padding, used when four English labels must share one row.
    var visorPillCompact: Bool {
        get { self[VisorPillCompactKey.self] }
        set { self[VisorPillCompactKey.self] = newValue }
    }
}

/// Utility pill (字幕 / 静音 / 相册 / 设置). Capsule, >= 44pt tall.
struct VisorPillLabel: View {
    @Environment(\.visorPillCompact) private var compact
    let icon: String
    let label: String
    var active = false
    var tint: Color? = nil

    var body: some View {
        let color = tint ?? Visor.accent
        HStack(spacing: compact ? 4 : Visor.Space.s2 - 2) {
            Image(systemName: icon).font(.system(size: 13, weight: .semibold))
            Text(label).visorFont(.footnote, .medium).lineLimit(1)
        }
        .foregroundStyle(active ? color : Visor.textSecondary)
        .padding(.horizontal, compact ? 9 : Visor.Space.s4 - 2)
        .frame(minHeight: 36)
        .background(Capsule().fill(active ? (tint == nil ? Visor.accentSoft : Visor.soft(color)) : Visor.surface2))
        .overlay(Capsule().strokeBorder(active ? color.opacity(0.55) : Visor.line, lineWidth: Visor.hairline))
        .frame(minHeight: Visor.hit)
        .contentShape(Capsule())
    }
}

// MARK: - sheet chrome

/// Title row for a bottom sheet: title left, 完成 right.
struct VisorSheetHeader: View {
    let title: String
    let onDone: () -> Void

    var body: some View {
        HStack {
            Text(title)
                .visorFont(.title, .semibold)
                .foregroundStyle(Visor.text)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            Button(L("common.done"), action: onDone)
                .buttonStyle(.visor(.plain, fullWidth: false))
        }
    }
}

/// Small status chip for read-only values.
struct VisorChip: View {
    let label: String
    var tint: Color = Visor.textSecondary
    var mono = false

    var body: some View {
        Text(label)
            .visorFont(.caption, .medium, mono: mono)
            .foregroundStyle(tint)
            .lineLimit(1)
            .padding(.horizontal, Visor.Space.s2 + 1)
            .padding(.vertical, 5)
            .background(Capsule().fill(Visor.surface2))
            .overlay(Capsule().strokeBorder(Visor.line, lineWidth: Visor.hairline))
    }
}
