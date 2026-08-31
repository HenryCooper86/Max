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
                HStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill")
                    VStack(alignment: .leading, spacing: 2) {
                        Text("疑似摔车 — 你还好吗？（\(remaining)s）").font(.system(size: 15, weight: .bold))
                        Text("点此取消，或说“我没事”").font(.system(size: 12))
                    }
                    Spacer()
                }
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 14).fill(Color.red.opacity(0.92)))
                .foregroundColor(.white)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("疑似摔车，点击取消警报，剩余\(remaining)秒")
        }
    }
}

/// Alarm + escalated: full-screen, glanceable from the ground, tappable by
/// a gloved hand or a bystander.
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
                Color.red.opacity(0.96).ignoresSafeArea()
                VStack(spacing: 24) {
                    Text("检测到摔车").font(.system(size: 34, weight: .black))
                    Text(statusLine).font(.system(size: 17, weight: .semibold))
                    // Only the alarm phase counts down to escalation; once
                    // escalated the ack/status line above is the live signal.
                    if case let .alarm(sinceT) = phase {
                        let remaining = crashCountdownSeconds(
                            windowS: CrashTuning.standard.alarmWindowS,
                            sinceT: sinceT,
                            now: ProcessInfo.processInfo.systemUptime
                        )
                        Text("\(remaining) 秒后通知紧急联系人")
                            .font(.system(size: 26, weight: .black, design: .monospaced))
                    }
                    if let locationText {
                        // Large enough for a bystander to read to 120.
                        Text(locationText).font(.system(size: 24, weight: .bold, design: .monospaced))
                    } else {
                        Text("正在定位…").font(.system(size: 17))
                    }
                    Button(action: onCancel) {
                        Text("我没事")
                            .font(.system(size: 28, weight: .black))
                            .frame(maxWidth: .infinity, minHeight: 88)
                            .background(RoundedRectangle(cornerRadius: 20).fill(Color.white))
                            .foregroundColor(.red)
                    }
                    Button {
                        if let url = URL(string: "tel://\(callNumber)") {
                            Task { _ = await SystemURLOpener().open(url) }
                        }
                    } label: {
                        Text("拨打 \(callNumber)")
                            .font(.system(size: 22, weight: .bold))
                            .frame(maxWidth: .infinity, minHeight: 66)
                            .background(RoundedRectangle(cornerRadius: 20).fill(Color.black.opacity(0.35)))
                            .foregroundColor(.white)
                    }
                }
                .padding(28)
                .foregroundColor(.white)
            }
        }
    }
}
