import Foundation
import SwiftUI

/// Check-in: a tappable banner in the alerts stack, HazardBanner-sized.
/// `sinceT` is `ProcessInfo.processInfo.systemUptime` at the moment check-in
/// started (see `CrashUIPhase.checkIn`) — never wall-clock — so the countdown
/// survives the device sleeping/waking without jumping.
struct CrashCheckInBanner: View {
    let sinceT: TimeInterval
    let onCancel: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let remaining = crashCountdownSeconds(
                windowS: CrashTuning.standard.checkInWindowS,
                sinceT: sinceT,
                now: ProcessInfo.processInfo.systemUptime
            )
            Button(action: onCancel) {
                HStack(spacing: Visor.Space.s3) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .hudIcon(20, .bold, relativeTo: .headline)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(L("crash.banner.title", ("n", String(remaining))))
                            .visorFont(.subhead, .bold)
                        Text(L("crash.banner.sub")).visorFont(.caption, .medium)
                    }
                    Spacer()
                }
                .padding(Visor.Space.s3)
                .frame(minHeight: Visor.hit)
                .background(Visor.danger, in: RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous))
                .foregroundStyle(Visor.onDanger)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L("crash.banner.a11y", ("n", String(remaining))))
            .accessibilityHint(crashCheckInAccessibilityHint())
        }
    }
}

/// Alarm + escalated: full-screen, glanceable from the ground, tappable by
/// a gloved hand or a bystander. Deliberately the loudest surface in the app:
/// solid danger fill, the template's legible ink (dark on light reds, white on dark reds), the largest type in the scale.
struct CrashAlarmView: View {
    let phase: CrashUIPhase
    let locationText: String?
    let callNumber: String
    let onCancel: () -> Void

    private var statusLine: String {
        switch phase {
        case let .escalated(ackText): return ackText ?? L("crash.alarm.notifying")
        default: return L("crash.alarm.noreply")
        }
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            ZStack {
                Visor.danger.ignoresSafeArea()
                VStack(spacing: Visor.Space.s6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .hudIcon(48, .black, relativeTo: .largeTitle, maximum: 64)
                        .accessibilityHidden(true)
                    Text(L("crash.alarm.title"))
                        .visorFont(.alarm, .black)
                        .minimumScaleFactor(0.6)
                        .multilineTextAlignment(.center)
                        .accessibilityAddTraits(crashAlarmAccessibilityContract.titleIsHeader ? .isHeader : [])
                    Text(statusLine)
                        .visorFont(.body, .semibold)
                        .multilineTextAlignment(.center)
                    // Only the alarm phase counts down to escalation; once
                    // escalated the ack/status line above is the live signal.
                    if case let .alarm(sinceT) = phase {
                        let remaining = crashCountdownSeconds(
                            windowS: CrashTuning.standard.alarmWindowS,
                            sinceT: sinceT,
                            now: ProcessInfo.processInfo.systemUptime
                        )
                        Text(L("crash.alarm.countdown", ("n", String(remaining))))
                            .visorFont(.title, .black, mono: true)
                            .multilineTextAlignment(.center)
                    }
                    if let locationText {
                        // Large enough for a bystander to read to 120.
                        Text(locationText)
                            .visorFont(.title, .bold, mono: true)
                            .multilineTextAlignment(.center)
                    } else {
                        Text(L("crash.alarm.locating")).visorFont(.body)
                    }
                    Spacer(minLength: 0)
                    Button(action: onCancel) {
                        Text(L("crash.alarm.ok"))
                            .visorFont(.display, .black)
                            .frame(maxWidth: .infinity, minHeight: 88)
                            .background(Visor.bg, in: RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous))
                            .foregroundStyle(Visor.text)
                    }
                    .accessibilityLabel(crashAlarmCancelAccessibilityLabel())
                    .accessibilityHint(crashAlarmCancelAccessibilityHint())
                    Button {
                        if let url = URL(string: "tel://\(callNumber)") {
                            Task { _ = await SystemURLOpener().open(url) }
                        }
                    } label: {
                        Text(L("crash.alarm.call", ("number", callNumber)))
                            .visorFont(.title, .bold)
                            .frame(maxWidth: .infinity, minHeight: 66)
                            .overlay(
                                RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous)
                                    .strokeBorder(Visor.onDanger, lineWidth: 2)
                            )
                            .foregroundStyle(Visor.onDanger)
                    }
                    .accessibilityHint(crashAlarmCallAccessibilityHint(number: callNumber))
                }
                .padding(Visor.Space.s6)
                .foregroundStyle(Visor.onDanger)
            }
            .accessibilityElement(children: .contain)
            .accessibilityAddTraits(crashAlarmAccessibilityContract.isModal ? .isModal : [])
        }
    }
}
