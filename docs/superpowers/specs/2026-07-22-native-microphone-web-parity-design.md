# Native Microphone Web-Parity Design

Date: 2026-07-22  
Status: Approved for planning

## Summary

Replace the separate circular microphone controls in the iOS and Android apps with one native, web-style microphone dock. The dock keeps the web control's proportions, visual hierarchy, labels, and start/end behavior while adapting the trailing keyboard-hint area into a live input meter for touch devices. When the app is listening to the rider, the meter, key, and border respond to the existing normalized microphone level. Mute remains available as a utility action beside Captions and Settings.

The web client is the visual reference. Each mobile client will implement the dock with native SwiftUI or Jetpack Compose primitives rather than embedding web content or drawing the entire control on a canvas.

## Scope

### Goals

- Make the primary microphone control on iOS and Android immediately recognizable as the same control used on Web.
- Provide restrained, real-time visual feedback when the rider's microphone receives speech.
- Preserve start, end, mute, accessibility, and reduced-motion behavior.
- Keep the iOS and Android state mapping, dimensions, colors, and animation response aligned.

### Non-goals

- Changing the microphone capture, WebSocket, ASR, playback, or barge-in pipelines.
- Redesigning the helmet gauge or state readout, which already consume the live microphone level.
- Changing the web microphone dock.
- Polishing the admin or settings menus. That work will be designed separately after microphone parity is complete.

## Existing Context

The web app renders a machined rectangular dock with a 300-pixel maximum width and 64-pixel minimum height. It contains a 46-pixel icon key, a primary text label, and a trailing keyboard hint. The idle palette is ember; an active hands-free session uses lume green.

The native clients currently diverge from this pattern:

- Android uses one circular Start control when idle and separate circular Mute and End controls during a session.
- iOS uses the same circular Start/Mute/End arrangement.
- Both native session models already expose `voiceLevel` as a normalized `0...1` value derived from microphone PCM frames.
- Both native helmet gauges already react to `voiceLevel`, so this feature needs only presentation-layer changes.

## Interaction Design

### Layout

The bottom primary control becomes a single dock with these native layout equivalents:

- Maximum width: 300 points/dp, constrained to the available screen width.
- Minimum height: 64 points/dp.
- Corner radius: 19 points/dp.
- Outer horizontal padding: 8 points/dp on the leading edge and 15 points/dp on the trailing edge.
- Three regions: a 46-point icon key, a flexible text label, and a compact trailing input meter.
- The label is separated from the key by a subtle vertical divider, matching Web.

The dock remains centered beneath the utility row. It replaces all current circular primary controls.

### State Mapping

| State | Leading key | Label | Border/key palette | Trailing region | Tap action |
| --- | --- | --- | --- | --- | --- |
| Hands-free off | Microphone | 开始免提 | Ember | Quiet three-bar meter at rest | Start session |
| Starting or reconnecting | X | 连接中 | Amber transitioning to lume | Quiet progress shimmer | Cancel/end session |
| Live and unmuted | X | 结束免提 | Lume | Live input meter | End session |
| Live and muted | X | 结束免提 | Lume border with muted amber cue | Static microphone-slash symbol | End session |

The dock always represents the hands-free session action. Muting is not assigned to the dock tap, preventing an ambiguous control whose action changes between End and Mute.

### Mute Placement

During an active hands-free session, Mute appears as a small utility pill alongside Captions and Settings:

- Unmuted: microphone icon and `静音`.
- Muted: microphone-slash icon and `取消静音`, tinted amber.
- When hands-free is off, the Mute utility is hidden because there is no active capture session to mute.

This preserves native functionality without weakening the primary start/end hierarchy.

## Voice-Reactive Motion

The existing `voiceLevel` drives a presentation-only display level. Input feedback is enabled only when all of the following are true:

- Hands-free is active.
- The microphone is not muted.
- The turn state is Listening or Hearing.

Agent playback, Thinking, Connecting, and idle silence must not trigger the speech animation.

To prevent room noise and frame-to-frame jitter from making the control flicker:

- Apply a small noise floor before visualization.
- Clamp the display level to `0...1` and use the same approximate sensitivity as the web gauge (`voiceLevel × 1.7`).
- Smooth increases quickly and decreases more slowly, using an 80 ms rise and 180 ms fall.

The trailing meter contains three rounded vertical bars. Their resting height stays visible so the control does not reflow. As display level rises, the bars grow by slightly different factors to create an organic input signal. The same level also adds:

- Up to 4% scale on the icon key.
- A restrained lume glow on the icon key and outer border.
- No continuous animation when the input remains below the noise floor.

The motion communicates rider input, not generic activity. The helmet gauge remains the larger ambient signal; the dock feedback is a localized confirmation at the point of interaction.

### Reduced Motion

When the operating system requests reduced motion:

- Disable key scaling, progress shimmer, and interpolated pulsing.
- Keep the dock's state colors and labels.
- Update the trailing bars discretely without animated interpolation; do not scale or pulse the key or border.

No required state is communicated through animation alone.

## Native Architecture

### iOS

Add a focused SwiftUI `VoiceMicDock` view in the voice screen module. It receives a small immutable presentation model containing the dock state, label, mute state, and display level. `PrimaryControls` is reduced to hosting this dock. `SecondaryControls` conditionally adds the Mute pill.

Use standard `Button`, `RoundedRectangle`, `Image(systemName:)`, and layout views so VoiceOver receives normal button semantics. Decorative meter bars are accessibility-hidden.

### Android

Add a focused Compose `VoiceMicDock` composable with the same inputs and state mapping. `PrimaryControls` hosts the dock, while `SecondaryControls` conditionally includes the Mute pill.

Use a Material surface with an explicit button role and content description. The decorative meter is excluded from TalkBack semantics.

### Shared Rules

Swift and Kotlin cannot share source directly, so parity is maintained through the same named states and constants on each platform:

- Dock states: Idle, Connecting, Live, Muted.
- Dimensions and color tokens matching the web dock.
- Voice-active predicate.
- Noise floor, sensitivity, and meter response curve.

Pure state and meter calculations remain separate from rendering so they can be tested without launching the UI.

## Data Flow

```text
PCM microphone frame
  -> existing native RMS calculation
  -> AgentSession.State.voiceLevel
  -> voice-active predicate (session + mute + turn state)
  -> clamped/smoothed display level
  -> VoiceMicDock meter, key scale, and glow
```

No new audio taps, permissions, background services, or network messages are introduced.

## Error and Edge Handling

- Permission denial or microphone startup failure continues through the existing session error path; the dock returns to the idle action when hands-free stops.
- During automatic reconnect, the dock shows `连接中` and does not react to stale `voiceLevel`.
- Muting immediately forces the display level to zero and removes speech-reactive motion.
- Ending the session immediately resets the visual level instead of waiting for the last smoothing animation.
- Hazard state continues to own the helmet and alert palette. The dock remains a session control and does not become a second hazard indicator.

## Accessibility

- Maintain at least a 44-point iOS and 48-dp Android touch target; the 64-point dock exceeds both.
- Expose one clear action label: `开始免提`, `正在连接免提，点按取消`, or `结束免提`.
- Expose Mute separately with its current state and action.
- Keep visible text for all session states; color and motion are supplementary.
- Preserve sufficient contrast for ember, lume, amber, text, dividers, and focus indicators against the dark HUD.

## Verification

### Automated

- Unit-test state mapping for off, connecting, ready, reconnecting, muted, and ended sessions.
- Unit-test the voice-active predicate so playback and Thinking never animate the microphone dock.
- Unit-test meter clamping, noise-floor behavior, and reset-to-zero behavior.
- Build the Android debug app and run its available unit tests.
- Build the iOS app for a simulator and run the `MaxHelmetTests` suite.

### Manual

On one iOS and one Android simulator or device:

1. Confirm idle geometry and palette resemble the web dock.
2. Start hands-free and confirm the Connecting and Live labels/actions.
3. Speak softly and loudly; verify the meter, key, and glow respond proportionally.
4. Remain silent and play Max speech; verify the dock does not show rider-input animation.
5. Mute and unmute; verify placement, labels, palette, and immediate animation reset.
6. End and reconnect a session; verify no stale level or stuck animation.
7. Enable Reduced Motion and repeat the state checks.
8. Verify VoiceOver and TalkBack announce the primary and Mute actions correctly.

## Acceptance Criteria

- iOS and Android use one primary rectangular dock that visibly matches the web microphone control.
- Both clients preserve session start/end and mute behavior.
- Real rider input produces proportional dock feedback only while the microphone is actively listening.
- Silence, Max playback, muted capture, Thinking, and Connecting do not produce rider-input animation.
- Reduced Motion and screen-reader behavior meet the rules above.
- Native tests and builds pass without changes to the audio or relay protocols.
