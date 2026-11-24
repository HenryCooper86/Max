import SwiftUI

/// App entry — the iOS counterpart of android/.../MainActivity.kt. Hosts the
/// single hands-free HUD, follows the active design template's colour scheme (light for daylight), and keeps
/// the screen awake while open so riders can glance at it (FLAG_KEEP_SCREEN_ON).
@main
struct MaxHelmetApp: App {
    @StateObject private var viewModel = MainViewModel()
    @StateObject private var session = AgentSession.shared
    @ObservedObject private var hudCast = AgentSession.shared.hudCast
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            AgentScreen(viewModel: viewModel, session: session)
                .modifier(VisorSchemeModifier())
                .onAppear {
                    #if DEBUG
                    AMapDeviceValidationHarness.apply(
                        arguments: ProcessInfo.processInfo.arguments,
                        defaults: .standard,
                        installGuidance: session.installAMapDeviceValidationGuidance
                    )
                    // Recording aid: `--debug-demo-ride` starts hands-free with the
                    // guided demo ride and captions on, so a simulator can be recorded
                    // without taps.
                    if ProcessInfo.processInfo.arguments.contains("--debug-demo-ride"),
                       !session.state.handsFree {
                        viewModel.showCaptions = true
                        viewModel.setGuidedDemo(true)
                        viewModel.toggleHandsFree()
                    }
                    #endif
                    updateIdleTimer()
                }
                .onChange(of: scenePhase) { _, phase in
                    updateIdleTimer()
                    if phase == .background {
                        session.music.setAppInBackground(true)
                        session.stopCameraForSession()
                        session.stopLiveVideo()
                    }
                    else if phase == .active { session.music.setAppInBackground(false) }
                }
                .onChange(of: hudCast.active) { _, _ in updateIdleTimer() }
                .onChange(of: session.state.handsFree) { _, _ in updateIdleTimer() }
        }
    }

    private func updateIdleTimer() {
        // Riders glance at the HUD during active sessions; restore the system
        // default as soon as the app backgrounds or hands-free stops.
        UIApplication.shared.isIdleTimerDisabled = scenePhase == .active && (session.state.handsFree || hudCast.active)
    }
}

/// Applies the active template's colour scheme to the whole window, so system
/// chrome, sheets and the status bar match. Reads the observable theme in its
/// own body, so a template change updates it.
private struct VisorSchemeModifier: ViewModifier {
    func body(content: Content) -> some View {
        content.preferredColorScheme(Visor.colorScheme)
    }
}
