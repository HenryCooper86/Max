import SwiftUI

// MARK: - presentation helpers

private func connectionLabel(_ state: ConnectionState) -> String {
    switch state {
    case .offline: return "离线"
    case .connecting: return "连接中"
    case .relay: return "中继在线"
    case .provider: return "代理握手"
    case .ready: return "已就绪"
    case .degraded: return "降级"
    }
}

/// Dot colour for the connection badge.
private func connectionTone(_ state: ConnectionState) -> Color {
    switch state {
    case .relay, .ready: return Visor.ok
    case .connecting, .provider: return Visor.warn
    case .offline, .degraded: return Visor.danger
    }
}

private func turnCaption(_ turn: TurnState, name: String) -> String {
    switch turn {
    case .idle: return "待机"
    case .listening: return "免提待命 · 请讲话"
    case .hearing: return "正在聆听…"
    case .thinking: return "\(name) 思考中…"
    case .speaking: return "\(name) 回答中"
    }
}

/// True once a crash incident is past check-in — the point at which the
/// full-screen alarm cover replaces the check-in banner in the alerts stack.
func isAlarmPhase(_ phase: CrashUIPhase) -> Bool {
    switch phase {
    case .alarm, .escalated: return true
    default: return false
    }
}

/// Whole seconds left in a crash countdown window (check-in or alarm),
/// clamped to zero once the window has fully elapsed. `now` and `sinceT`
/// must both be `ProcessInfo.processInfo.systemUptime` readings — never
/// `Date()` — so the countdown is immune to wall-clock adjustments.
func crashCountdownSeconds(windowS: Double, sinceT: TimeInterval, now: TimeInterval) -> Int {
    let remaining = windowS - (now - sinceT)
    return max(0, Int(remaining.rounded()))
}

/// The headline under the visor — the main words on the clean screen.
/// An elevated fused hazard prefixes it with the safety call-out.
private func readoutHeadline(_ state: AgentSession.State, name: String) -> String {
    let base: String
    if !state.handsFree {
        base = "你好，我是\(name)"
    } else if state.micMuted {
        base = "麦克风已静音"
    } else if state.connection == .ready {
        base = turnCaption(state.turnState, name: name)
    } else {
        base = connectionLabel(state.connection)
    }
    let presentedHazard = isHazardPresentationActive(state) ? state.fusedHazard : .normal
    switch presentedHazard {
    case .normal: return base
    case .caution: return "注意路况 · " + base
    case .critical: return "高风险 · 优先安全 · " + base
    }
}

private func readoutHint(_ state: AgentSession.State, wakePhrase: String?) -> String {
    if !state.handsFree {
        if let wakePhrase, !wakePhrase.isEmpty { return "点按镜面开始对话，或说“\(wakePhrase)”" }
        return "点按镜面开始对话，再点一次结束"
    }
    if state.micMuted { return "点按「取消静音」后继续对话" }
    return "再点一次镜面结束对话"
}

func helmetToggleAccessibilityLabel(handsFree: Bool) -> String {
    handsFree ? "结束免提" : "开启免提"
}

func helmetToggleAccessibilityHint(handsFree: Bool) -> String {
    handsFree ? "结束免提会话，或取消正在进行的连接" : "开启免提会话"
}

func helmetToggleAccessibilityValue(handsFree: Bool) -> String {
    handsFree ? "免提已开启" : "免提未开启"
}

/// The voice-mode main screen: wordmark and connection state on top, the Visor
/// hero (also the session toggle), a greeting/hint, a utility pill row and the
/// optional transcript. Safety banners appear under the pill row so the visor never moves.
/// All rider + test settings live in the gear sheet.
struct AgentScreen: View {
    @State private var navigationDetailsPresented = false
    @ObservedObject var viewModel: MainViewModel
    @ObservedObject var session: AgentSession
    /// Compact vertical space means the phone is sideways. Info.plist has always
    /// permitted that; the layout never accounted for it.
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var state: AgentSession.State { session.state }

    var body: some View {
        let tint = visorTint(state)
        let presentedHazard = isHazardPresentationActive(state) ? state.fusedHazard : .normal
        let layout = hudLayout(verticalSizeClassIsCompact: verticalSizeClass == .compact)

        ZStack {
            GeometryReader { proxy in
                // Nothing claims space above the visor. Alerts and the
                // navigation card arrive below the pill row instead, so the
                // visor — the one control the rider taps — never moves.
                let inputs = hudLayoutInputs(
                    hazardVisible: false,
                    crashCheckInVisible: false,
                    guidanceVisible: false,
                    recordingVisible: false,
                    captionsRequested: viewModel.showCaptions,
                    handsFreeActive: state.handsFree
                )
                HudRegionLayout(
                    layout: layout,
                    inputs: inputs,
                    alertContent: { _ in
                        TopBar(state: state)
                    },
                    helmetContent: { stage in
                        VisorView(
                            mode: visorMode(state),
                            tint: tint,
                            voiceLevel: state.voiceLevel,
                            dimmed: state.micMuted,
                            hazard: presentedHazard,
                            handsFree: state.handsFree,
                            stage: stage,
                            onTap: viewModel.toggleHandsFree
                        )
                    },
                    utilityContent: { captionsVisible in
                        utilityContent(captionsVisible: captionsVisible, layout: layout)
                    }
                )
            }
            .padding(.horizontal, layout == .landscape ? 16 : 20)
            .padding(.top, 10)
            .padding(.bottom, layout == .landscape ? 10 : 18)
            .frame(maxWidth: layout == .landscape ? .infinity : 560)
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if isAlarmPhase(state.crashPhase) {
                CrashAlarmView(
                    phase: state.crashPhase,
                    locationText: state.crashLocationText,
                    callNumber: viewModel.crashCallTarget == "contact" ? (viewModel.crashContactNumber.isEmpty ? "120" : viewModel.crashContactNumber) : "120",
                    onCancel: { session.crashController.riderTapCancelled() }
                )
                .zIndex(10)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Visor.bg.ignoresSafeArea())
        .visorAnimation(viewModel.showCaptions)
        .visorAnimation(state.micMuted)
        .onAppear { viewModel.refreshRelayHealth() }
        // The relay requires a login (HTTP 401): open the settings sheet on the
        // 账号 section so the rider can sign in right where the fix is.
        .onChange(of: state.authRequired) { _, required in
            // Handles the stale-identity case too: a 401 while "logged in"
            // means the stored session died server-side — the view model drops
            // it so the login form (not the identity row) is what opens.
            if required { viewModel.handleAuthRequired() }
        }
        .sheet(isPresented: $viewModel.showPreferences) {
            SettingsSheet(title: "设置") {
                SettingsPanel(state: state, viewModel: viewModel)
            }
            // Attached to the settings sheet so 导出日志 (tapped from inside it)
            // can present the share sheet stacked on top — a second .sheet on the
            // main screen would be blocked while the settings sheet is up.
            .sheet(item: $viewModel.exportFile) { file in
                ActivityView(items: [file.url])
            }
        }
        .sheet(isPresented: $viewModel.showGallery) {
            GalleryView(model: viewModel.galleryModel, onClose: { viewModel.showGallery = false })
        }
        .onChange(of: state.galleryRequestToken) { _, _ in
            viewModel.galleryModel.refresh()
            viewModel.showGallery = true
        }
    }

    // MARK: - the two arrangements

    /// The live route card. It sits under the pill row with the other alerts;
    /// its map keeps the designed height, and the column scrolls if a short
    /// screen cannot hold everything.
    @ViewBuilder private func navigationCard(layout: HudLayout) -> some View {
        if let guidance = state.guidance {
            GuidanceCard(
                guidance: guidance,
                mapHeight: guidanceMapHeight(forAlertViewport: HudMetrics.guidanceAlertViewportCap, layout: layout),
                arrangement: guidanceCardArrangement(for: layout),
                onConfirm: { id, accepted in session.confirmNavigation(id: id, accepted: accepted) },
                music: session.music,
                hudCast: session.hudCast,
                onDetailsPresentationChanged: { navigationDetailsPresented = $0 }
            )
            .transition(.opacity)
        }
    }

    /// Safety banners that come and go mid-ride. They sit directly under the
    /// pill row: a hazard already recolours the visor and leads the headline,
    /// so the banner adds the detail without displacing anything above it.
    @ViewBuilder private func transientAlerts() -> some View {
        if let alert = state.hazardAlert {
            HazardBanner(alert: alert)
        }
        if case let .checkIn(sinceT) = state.crashPhase {
            CrashCheckInBanner(sinceT: sinceT, onCancel: { session.crashController.riderTapCancelled() })
        }
        if state.recording {
            RecordingIndicator(startedAt: state.recordingStartedAt)
        }
    }

    @ViewBuilder private func captionsCard() -> some View {
        CaptionsOverlay(
            items: state.transcript,
            assistantName: Visor.assistantName,
            canFlag: { state.canFlagTurn($0) },
            onFlag: { item, reason in viewModel.flagTurn(item, reason: reason) }
        )
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private func utilityContent(captionsVisible: Bool, layout: HudLayout) -> some View {
        // With a route card in the column there is not always room for the
        // transcript to take "the rest": it gets a fixed height and the column
        // scrolls instead.
        let navigating = state.guidance != nil
        return UtilityColumn(fillsViewport: captionsVisible && !navigating) {
            StateReadout(
                headline: readoutHeadline(state, name: Visor.assistantName),
                hint: readoutHint(state, wakePhrase: Visor.wakePhrase)
            )
            SecondaryControls(state: state, viewModel: viewModel)
            transientAlerts()
            navigationCard(layout: layout)
            MusicPlaybackCard(model: session.music, presentsPicker: !navigationDetailsPresented)
            if captionsVisible {
                captionsCard()
                    .frame(height: navigating ? CaptionsOverlay.heightBesideRoute : nil)
            } else {
                Spacer(minLength: 0)
            }
        }
    }
}

/// The column under the visor. With captions on it is exactly as tall as the
/// region it was granted, so the captions card takes what is left under the
/// readout, pills and any banner, and ends on its own rounded edge on screen.
private struct UtilityColumn<Content: View>: View {
    @Environment(\.hudUtilityViewportHeight) private var viewportHeight
    let fillsViewport: Bool
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Visor.Space.s4) { content }
            .frame(height: fillsViewport ? viewportHeight : nil, alignment: .top)
    }
}

// MARK: - top bar: wordmark + connection state

private struct TopBar: View {
    let state: AgentSession.State

    var body: some View {
        HStack(spacing: Visor.Space.s3) {
            Text(Visor.assistantName)
                .visorFont(.body, .semibold)
                .foregroundStyle(Visor.text)
                .lineLimit(1)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            HStack(spacing: Visor.Space.s2) {
                if state.bluetoothRouted {
                    Image(systemName: "headphones")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Visor.textSecondary)
                        .accessibilityLabel("蓝牙音频")
                }
                HStack(spacing: 6) {
                    Circle()
                        .fill(connectionTone(state.connection))
                        .frame(width: 6, height: 6)
                    Text(connectionLabel(state.connection))
                        .visorFont(.caption, .medium)
                        .foregroundStyle(Visor.textSecondary)
                        .lineLimit(1)
                }
                .padding(.horizontal, Visor.Space.s3 - 2)
                .frame(minHeight: 28)
                .overlay(Capsule().strokeBorder(Visor.line, lineWidth: Visor.hairline))
                .accessibilityElement(children: .combine)
                .accessibilityLabel("连接状态：\(connectionLabel(state.connection))")
            }
        }
        .frame(maxWidth: .infinity, minHeight: HudMetrics.topBarHeight)
        .visorAnimation(state.connection)
    }
}

// MARK: - alerts (safety-critical: kept on every screen)

private struct RecordingIndicator: View {
    let startedAt: Double?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            HStack(spacing: Visor.Space.s2) {
                Circle().fill(Visor.danger).frame(width: 8, height: 8)
                Text("录像中").visorFont(.footnote, .semibold).foregroundStyle(Visor.text)
                Text(elapsed).visorFont(.footnote, .medium, mono: true).foregroundStyle(Visor.textSecondary)
            }
            .padding(.horizontal, Visor.Space.s3)
            .frame(minHeight: 32)
            .background(Capsule().fill(Visor.surface2))
            .overlay(Capsule().strokeBorder(Visor.line, lineWidth: Visor.hairline))
            .accessibilityElement(children: .combine)
        }
    }

    private var elapsed: String {
        guard let startedAt else { return "00:00" }
        let s = max(0, Int(Date().timeIntervalSince1970 - startedAt))
        return String(format: "%02d:%02d", s / 60, s % 60)
    }
}

private struct HazardBanner: View {
    let alert: HazardAlert

    var body: some View {
        let color = hazardColor(alert.severity)
        HStack(spacing: Visor.Space.s3) {
            Text(alert.directionLabel)
                .visorFont(.body, .bold)
                .foregroundStyle(color)
                .frame(minWidth: 56, minHeight: 40)
                .padding(.horizontal, Visor.Space.s2)
                .background(color.opacity(0.16), in: RoundedRectangle(cornerRadius: Visor.Radius.control, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(color)
                        .accessibilityHidden(true)
                    Text(alert.label).visorFont(.subhead, .semibold).foregroundStyle(Visor.text)
                }
                Text("\(alert.message) \(alert.advice)")
                    .visorFont(.caption)
                    .foregroundStyle(Visor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Text("\(alert.ttcSeconds)s")
                .visorFont(.subhead, .bold, mono: true)
                .foregroundStyle(color)
        }
        .padding(Visor.Space.s3)
        .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous)
                .strokeBorder(color, lineWidth: Visor.hairline)
        )
    }
}

// MARK: - readout under the visor

/// Greeting / state headline with a quiet hint beneath it.
private struct StateReadout: View {
    let headline: String
    let hint: String

    var body: some View {
        VStack(spacing: 6) {
            Text(headline)
                .visorFont(.title, .semibold)
                .foregroundStyle(Visor.text)
                .multilineTextAlignment(.center)
                // One line each, shrinking before truncating, so a long hazard
                // headline never pushes the pill row down.
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(hint)
                .visorFont(.subhead)
                .foregroundStyle(Visor.textSecondary)
                .multilineTextAlignment(.center)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
        .visorAnimation(headline)
    }
}

// MARK: - optional captions (字幕)

private struct CaptionsOverlay: View {
    let items: [TranscriptItem]
    let assistantName: String
    let canFlag: (TranscriptItem) -> Bool
    let onFlag: (TranscriptItem, String) -> Void

    private let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    /// The transcript scrolls inside its own card and follows the newest turn.
    /// It must never scroll the screen: that would carry the readout and the
    /// pill row (including the 字幕 pill that closes it) out of reach.
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                if items.isEmpty {
                    Text("暂无字幕")
                        .visorFont(.footnote)
                        .foregroundStyle(Visor.textTertiary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, Visor.Space.s5)
                } else {
                    VStack(spacing: Visor.Space.s3) {
                        ForEach(items) { item in
                            ChatBubble(
                                item: item,
                                assistantName: assistantName,
                                time: timeFormatter.string(from: item.at),
                                flaggable: canFlag(item),
                                onFlag: { reason in onFlag(item, reason) }
                            )
                            .id(item.id)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(Visor.Space.s4)
                }
            }
            .scrollIndicators(.hidden)
            .defaultScrollAnchor(.bottom)
            .onChange(of: items.last?.id) { _, latest in
                if let latest { withAnimation { proxy.scrollTo(latest, anchor: .bottom) } }
            }
            .onChange(of: items.last?.text) { _, _ in
                if let latest = items.last?.id { proxy.scrollTo(latest, anchor: .bottom) }
            }
            .onAppear {
                if let latest = items.last?.id { proxy.scrollTo(latest, anchor: .bottom) }
            }
        }
        .frame(maxWidth: .infinity)
        // Fills whatever the region has left under the pills and any banner,
        // so the card always ends on its own rounded edge inside the screen.
        .frame(minHeight: CaptionsOverlay.minimumHeight, maxHeight: .infinity)
        .background(RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous).fill(Visor.surface1))
        .overlay(RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous).strokeBorder(Visor.line, lineWidth: Visor.hairline))
        .clipShape(RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous))
    }

    static let minimumHeight: CGFloat = 140
    static let heightBesideRoute: CGFloat = 220
}

// MARK: - pill row (字幕 · 静音 · 相册 · 设置)

private struct SecondaryControls: View {
    let state: AgentSession.State
    @ObservedObject var viewModel: MainViewModel

    var body: some View {
        ViewThatFits(in: .horizontal) {
            controlsRow
            controlsGrid
        }
        .frame(maxWidth: .infinity)
    }

    private var captionsPill: some View {
        PillToggle(icon: "text.bubble", label: "字幕", on: viewModel.showCaptions) {
            viewModel.showCaptions.toggle()
        }
    }

    private var galleryPill: some View {
        PillToggle(icon: "photo.stack", label: "相册", on: false) {
            viewModel.galleryModel.refresh()
            viewModel.showGallery = true
        }
    }

    private var settingsPill: some View {
        PillToggle(icon: "gearshape", label: "设置", on: false, accessibilityIdentifier: HudAccessibilityID.secondaryAction) {
            viewModel.showPreferences = true
        }
    }

    private var controlsRow: some View {
        HStack(spacing: Visor.Space.s2) {
            captionsPill
            if state.handsFree {
                MuteUtilityPill(muted: state.micMuted, action: viewModel.toggleMute)
            }
            galleryPill
            settingsPill
        }
        .frame(maxWidth: .infinity)
    }

    /// When the landscape utility column becomes narrow at Dynamic Type, the
    /// outer utility ScrollView owns the added vertical height. Every action
    /// stays reachable instead of compressing or clipping horizontally.
    private var controlsGrid: some View {
        VStack(spacing: Visor.Space.s2) {
            HStack(spacing: Visor.Space.s2) {
                captionsPill
                if state.handsFree {
                    MuteUtilityPill(muted: state.micMuted, action: viewModel.toggleMute)
                }
            }
            HStack(spacing: Visor.Space.s2) {
                galleryPill
                settingsPill
            }
        }
        .frame(maxWidth: .infinity)
    }
}

private struct PillToggle: View {
    let icon: String
    let label: String
    let on: Bool
    var accessibilityIdentifier = ""
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VisorPillLabel(icon: icon, label: label, active: on)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(accessibilityIdentifier)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

// MARK: - conversation bubble (used by the captions)

private struct ChatBubble: View {
    let item: TranscriptItem
    let assistantName: String
    let time: String
    var flaggable = false
    var onFlag: (String) -> Void = { _ in }

    private var isRider: Bool { item.speaker == .rider }

    var body: some View {
        HStack {
            if isRider { Spacer(minLength: 40) }
            VStack(alignment: isRider ? .trailing : .leading, spacing: 4) {
                Text(item.text)
                    .visorFont(.subhead)
                    .foregroundStyle(Visor.text)
                    .padding(.horizontal, Visor.Space.s3)
                    .padding(.vertical, Visor.Space.s2 + 1)
                    .background(
                        RoundedRectangle(cornerRadius: Visor.Radius.card, style: .continuous)
                            .fill(isRider ? Visor.user.opacity(0.14) : Visor.surface2)
                    )
                HStack(spacing: 6) {
                    Text(isRider ? "骑手" : assistantName)
                        .visorFont(.caption, .semibold)
                        .foregroundStyle(isRider ? Visor.user : Visor.textSecondary)
                    Text(time).visorFont(.caption, mono: true).foregroundStyle(Visor.textTertiary)
                    if !item.final {
                        Text("…").visorFont(.caption).foregroundStyle(Visor.textTertiary)
                    }
                    if let feedback = item.feedback {
                        Text("已标记 · \(feedback)")
                            .visorFont(.caption, .semibold)
                            .foregroundStyle(Visor.danger)
                    } else if flaggable {
                        // One tap opens the preset reasons — no typing mid-ride.
                        Menu {
                            ForEach(turnFlagReasons, id: \.self) { reason in
                                Button(reason) { onFlag(reason) }
                            }
                        } label: {
                            Text("有问题?")
                                .visorFont(.caption, .semibold)
                                .foregroundStyle(Visor.danger)
                                .padding(.horizontal, 8)
                                .frame(minHeight: 28)
                                .overlay(Capsule().strokeBorder(Visor.danger.opacity(0.4), lineWidth: Visor.hairline))
                                .frame(minHeight: Visor.hit)
                                .contentShape(Rectangle())
                        }
                    }
                }
            }
            if !isRider { Spacer(minLength: 40) }
        }
    }
}

// MARK: - share sheet (transcript export)

private struct ActivityView: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
