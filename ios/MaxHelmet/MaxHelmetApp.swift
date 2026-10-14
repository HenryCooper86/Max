import SwiftUI

/// App entry — the iOS counterpart of android/.../MainActivity.kt. Hosts the
/// single hands-free HUD, forces dark mode (the HUD is designed dark), and keeps
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
                .preferredColorScheme(.dark)
                .onAppear {
                    #if DEBUG
                    AMapDeviceValidationHarness.apply(
                        arguments: ProcessInfo.processInfo.arguments,
                        defaults: .standard,
                        installGuidance: session.installAMapDeviceValidationGuidance
                    )
                    #endif
                    updateIdleTimer()
                }
                .onChange(of: scenePhase) { _, phase in
                    updateIdleTimer()
                    if phase == .background {
                        session.music.setAppInBackground(true)
                        session.stopCameraForSession()
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
