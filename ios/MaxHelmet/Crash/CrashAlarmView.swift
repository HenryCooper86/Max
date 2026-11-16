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
                        .font(.system(size: 20, weight: .bold))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("疑似摔车 — 你还好吗？（\(remaining)s）")
                            .visorFont(.subhead, .bold)
                        Text("点此取消，或说“我没事”").visorFont(.caption, .medium)
                    }
                    Spacer()
                }
                .padding(Visor.Space.s3)
                .frame(minHeight: Visor.hit)
                .background(Visor.danger, in: RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous))
                .foregroundStyle(Visor.bg)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("疑似摔车，点击取消警报，剩余\(remaining)秒")
        }
    }
}

/// Alarm + escalated: full-screen, glanceable from the ground, tappable by
/// a gloved hand or a bystander. Deliberately the loudest surface in the app:
/// solid danger fill, dark ink, the largest type in the scale.
struct CrashAlarmView: View {
    let phase: CrashUIPhase
    let locationText: String?
    let callNumber: String
    let onCancel: () -> Void

    private var statusLine: String {
        switch phase {
        case let .escalated(ackText): return ackText ?? "正在通知紧急联系人…"
        default: return "无人响应将通知紧急联系人"
        }
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            ZStack {
                Visor.danger.ignoresSafeArea()
                VStack(spacing: Visor.Space.s6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 48, weight: .black))
                        .accessibilityHidden(true)
                    Text("检测到摔车")
                        .visorFont(.alarm, .black)
                        .minimumScaleFactor(0.6)
                        .multilineTextAlignment(.center)
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
                        Text("\(remaining) 秒后通知紧急联系人")
                            .visorFont(.title, .black, mono: true)
                            .multilineTextAlignment(.center)
                    }
                    if let locationText {
                        // Large enough for a bystander to read to 120.
                        Text(locationText)
                            .visorFont(.title, .bold, mono: true)
                            .multilineTextAlignment(.center)
                    } else {
                        Text("正在定位…").visorFont(.body)
                    }
                    Spacer(minLength: 0)
                    Button(action: onCancel) {
                        Text("我没事")
                            .visorFont(.display, .black)
                            .frame(maxWidth: .infinity, minHeight: 88)
                            .background(Visor.bg, in: RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous))
                            .foregroundStyle(Visor.text)
                    }
                    Button {
                        if let url = URL(string: "tel://\(callNumber)") {
                            Task { _ = await SystemURLOpener().open(url) }
                        }
                    } label: {
                        Text("拨打 \(callNumber)")
                            .visorFont(.title, .bold)
                            .frame(maxWidth: .infinity, minHeight: 66)
                            .overlay(
                                RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous)
                                    .strokeBorder(Visor.bg, lineWidth: 2)
                            )
                            .foregroundStyle(Visor.bg)
                    }
                }
                .padding(Visor.Space.s6)
                .foregroundStyle(Visor.bg)
            }
        }
    }
}
