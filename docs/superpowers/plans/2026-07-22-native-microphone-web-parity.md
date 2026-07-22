# Native Microphone Web-Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the circular iOS and Android microphone controls with one web-style, speech-reactive native dock while preserving mute, accessibility, and reduced-motion behavior.

**Architecture:** Each platform gets a pure microphone-dock presentation model and a focused native view/composable. The existing `AgentSession.State.voiceLevel` remains the sole input signal; pure helpers gate it to ready, unmuted Listening/Hearing states, then the UI smooths the value and renders the dock. `AgentScreen` only composes the new dock and moves Mute into the utility row.

**Tech Stack:** Kotlin 2.2, Jetpack Compose/Material 3, JUnit 4, Swift 5, SwiftUI, XCTest, Android SDK 36, iOS 17+

## Global Constraints

- Do not change microphone capture, WebSocket, ASR, playback, barge-in, permission, background-service, or relay-protocol code.
- The dock maximum width is 300 points/dp, minimum height is 64 points/dp, corner radius is 19 points/dp, and leading key is 46 points/dp.
- Visible labels are exactly `开始免提`, `连接中`, and `结束免提`; Mute labels are exactly `静音` and `取消静音`.
- Rider-input feedback is enabled only for a hands-free, Ready, unmuted session whose turn state is Listening or Hearing.
- The display curve uses noise floor `0.035`, sensitivity `1.7`, an 80 ms rise, and a 180 ms fall.
- Reduced Motion removes interpolation, key scaling, shimmer, and pulsing; the bars update discretely.
- The muted trailing slot is always a static microphone-slash symbol.
- Keep admin/settings-menu polish out of this implementation.
- Add no third-party dependencies.

---

## File Structure

- Create `android/app/src/main/java/com/horizon/maxhelmet/ui/VoiceMicDockModel.kt`: pure Android dock state, voice gating, level curve, and meter geometry.
- Create `android/app/src/main/java/com/horizon/maxhelmet/ui/VoiceMicDock.kt`: Compose dock and Mute utility pill only.
- Create `android/app/src/test/java/com/horizon/maxhelmet/ui/VoiceMicDockTest.kt`: JUnit coverage for the pure Android model.
- Modify `android/app/src/main/java/com/horizon/maxhelmet/ui/AgentScreen.kt`: compose the dock, place Mute in utilities, and remove circular controls.
- Create `ios/MaxHelmet/UI/VoiceMicDockModel.swift`: pure iOS dock state, voice gating, level curve, and meter geometry.
- Create `ios/MaxHelmet/UI/VoiceMicDock.swift`: SwiftUI dock and Mute utility pill only.
- Create `ios/MaxHelmetTests/VoiceMicDockTests.swift`: XCTest coverage for the pure iOS model.
- Modify `ios/MaxHelmet/UI/AgentScreen.swift`: compose the dock, place Mute in utilities, and remove circular controls.
- Modify `android/README.md`, `ios/README.md`, and `README.md`: describe the new web-parity dock and voice feedback without changing setup instructions.

---

### Task 1: Android microphone-dock presentation model

**Files:**
- Create: `android/app/src/main/java/com/horizon/maxhelmet/ui/VoiceMicDockModel.kt`
- Test: `android/app/src/test/java/com/horizon/maxhelmet/ui/VoiceMicDockTest.kt`

**Interfaces:**
- Consumes: `AgentSession.State`, `ConnectionState`, and `TurnState` from the existing Android agent package.
- Produces: `MicDockMode`, `MicDockPresentation`, `isVoiceInputActive(state)`, `micDisplayLevel(state)`, `micDockPresentation(state)`, and `micMeterHeights(level)` for Task 2.

- [ ] **Step 1: Write the failing model tests**

Create `android/app/src/test/java/com/horizon/maxhelmet/ui/VoiceMicDockTest.kt`:

```kotlin
package com.horizon.maxhelmet.ui

import com.horizon.maxhelmet.agent.AgentSession
import com.horizon.maxhelmet.agent.ConnectionState
import com.horizon.maxhelmet.agent.TurnState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceMicDockTest {
    @Test
    fun `maps idle connecting live and muted states`() {
        val idle = AgentSession.State()
        val connecting = idle.copy(handsFree = true, connection = ConnectionState.PROVIDER)
        val live = connecting.copy(connection = ConnectionState.READY)
        val muted = live.copy(micMuted = true)

        assertEquals(MicDockMode.IDLE, micDockPresentation(idle).mode)
        assertEquals("开始免提", micDockPresentation(idle).label)
        assertEquals(MicDockMode.CONNECTING, micDockPresentation(connecting).mode)
        assertEquals("连接中", micDockPresentation(connecting).label)
        assertEquals(MicDockMode.LIVE, micDockPresentation(live).mode)
        assertEquals("结束免提", micDockPresentation(live).label)
        assertEquals(MicDockMode.MUTED, micDockPresentation(muted).mode)
    }

    @Test
    fun `animates only ready unmuted rider input`() {
        val base = AgentSession.State(
            handsFree = true,
            connection = ConnectionState.READY,
            turnState = TurnState.LISTENING,
            voiceLevel = 0.5f
        )

        assertTrue(isVoiceInputActive(base))
        assertTrue(isVoiceInputActive(base.copy(turnState = TurnState.HEARING)))
        assertFalse(isVoiceInputActive(base.copy(turnState = TurnState.THINKING)))
        assertFalse(isVoiceInputActive(base.copy(turnState = TurnState.SPEAKING)))
        assertFalse(isVoiceInputActive(base.copy(connection = ConnectionState.DEGRADED)))
        assertFalse(isVoiceInputActive(base.copy(micMuted = true)))
    }

    @Test
    fun `applies the noise floor sensitivity and clamp`() {
        val state = AgentSession.State(
            handsFree = true,
            connection = ConnectionState.READY,
            turnState = TurnState.LISTENING
        )

        assertEquals(0f, micDisplayLevel(state.copy(voiceLevel = 0.035f)), 0.0001f)
        assertEquals(0.7905f, micDisplayLevel(state.copy(voiceLevel = 0.5f)), 0.0001f)
        assertEquals(1f, micDisplayLevel(state.copy(voiceLevel = 1f)), 0.0001f)
        assertEquals(0f, micDisplayLevel(state.copy(turnState = TurnState.THINKING, voiceLevel = 1f)), 0.0001f)
    }

    @Test
    fun `returns stable three bar geometry`() {
        assertEquals(listOf(6f, 6f, 6f), micMeterHeights(0f))
        assertEquals(listOf(14f, 18f, 15f), micMeterHeights(1f))
        assertEquals(listOf(14f, 18f, 15f), micMeterHeights(2f))
    }
}
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd android
./gradlew :app:testDebugUnitTest --tests 'com.horizon.maxhelmet.ui.VoiceMicDockTest'
```

Expected: compilation fails with unresolved references such as `MicDockMode` and `micDockPresentation`.

- [ ] **Step 3: Implement the pure model**

Create `android/app/src/main/java/com/horizon/maxhelmet/ui/VoiceMicDockModel.kt`:

```kotlin
package com.horizon.maxhelmet.ui

import com.horizon.maxhelmet.agent.AgentSession
import com.horizon.maxhelmet.agent.ConnectionState
import com.horizon.maxhelmet.agent.TurnState

internal const val MIC_DOCK_NOISE_FLOOR = 0.035f
internal const val MIC_DOCK_SENSITIVITY = 1.7f

internal enum class MicDockMode { IDLE, CONNECTING, LIVE, MUTED }

internal data class MicDockPresentation(
    val mode: MicDockMode,
    val label: String,
    val accessibilityLabel: String,
    val displayLevel: Float
)

internal fun isVoiceInputActive(state: AgentSession.State): Boolean =
    state.handsFree &&
        state.connection == ConnectionState.READY &&
        !state.micMuted &&
        (state.turnState == TurnState.LISTENING || state.turnState == TurnState.HEARING)

internal fun micDisplayLevel(state: AgentSession.State): Float {
    if (!isVoiceInputActive(state)) return 0f
    return ((state.voiceLevel - MIC_DOCK_NOISE_FLOOR).coerceAtLeast(0f) * MIC_DOCK_SENSITIVITY)
        .coerceIn(0f, 1f)
}

internal fun micDockPresentation(state: AgentSession.State): MicDockPresentation {
    val mode = when {
        !state.handsFree -> MicDockMode.IDLE
        state.connection != ConnectionState.READY -> MicDockMode.CONNECTING
        state.micMuted -> MicDockMode.MUTED
        else -> MicDockMode.LIVE
    }
    val label = when (mode) {
        MicDockMode.IDLE -> "开始免提"
        MicDockMode.CONNECTING -> "连接中"
        MicDockMode.LIVE, MicDockMode.MUTED -> "结束免提"
    }
    val accessibilityLabel = when (mode) {
        MicDockMode.IDLE -> "开始免提"
        MicDockMode.CONNECTING -> "正在连接免提，点按取消"
        MicDockMode.LIVE, MicDockMode.MUTED -> "结束免提"
    }
    return MicDockPresentation(mode, label, accessibilityLabel, micDisplayLevel(state))
}

internal fun micMeterHeights(level: Float): List<Float> {
    val value = level.coerceIn(0f, 1f)
    return listOf(6f + 8f * value, 6f + 12f * value, 6f + 9f * value)
}
```

- [ ] **Step 4: Run the focused and full Android unit suites**

Run:

```bash
cd android
./gradlew :app:testDebugUnitTest --tests 'com.horizon.maxhelmet.ui.VoiceMicDockTest'
./gradlew :app:testDebugUnitTest
```

Expected: `VoiceMicDockTest` passes, followed by `BUILD SUCCESSFUL` for the full unit suite.

- [ ] **Step 5: Commit the Android model**

```bash
git add android/app/src/main/java/com/horizon/maxhelmet/ui/VoiceMicDockModel.kt android/app/src/test/java/com/horizon/maxhelmet/ui/VoiceMicDockTest.kt
git commit -m "test(android): define microphone dock states"
```

---

### Task 2: Android Compose dock and screen integration

**Files:**
- Create: `android/app/src/main/java/com/horizon/maxhelmet/ui/VoiceMicDock.kt`
- Modify: `android/app/src/main/java/com/horizon/maxhelmet/ui/AgentScreen.kt:25-65, 286-297, 650-744`

**Interfaces:**
- Consumes: all Task 1 model interfaces plus `HudColors`.
- Produces: `VoiceMicDock(state, onClick)` and `MuteUtilityPill(muted, onClick)` for `AgentScreen`.

- [ ] **Step 1: Add the focused Compose component**

Create `android/app/src/main/java/com/horizon/maxhelmet/ui/VoiceMicDock.kt` with these behaviors and constants:

```kotlin
package com.horizon.maxhelmet.ui

import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.horizon.maxhelmet.agent.AgentSession
import com.horizon.maxhelmet.ui.theme.HudColors
import kotlin.math.PI
import kotlin.math.sin

@Composable
internal fun VoiceMicDock(state: AgentSession.State, onClick: () -> Unit) {
    val presentation = micDockPresentation(state)
    val context = LocalContext.current
    val reduceMotion = Settings.Global.getFloat(
        context.contentResolver,
        Settings.Global.ANIMATOR_DURATION_SCALE,
        1f
    ) == 0f
    val animatedLevel = remember { Animatable(0f) }

    LaunchedEffect(presentation.displayLevel, presentation.mode, reduceMotion) {
        val target = presentation.displayLevel
        if (reduceMotion || presentation.mode != MicDockMode.LIVE) {
            animatedLevel.snapTo(target)
        } else {
            animatedLevel.animateTo(
                target,
                tween(
                    durationMillis = if (target > animatedLevel.value) 80 else 180,
                    easing = LinearEasing
                )
            )
        }
    }

    val connectingPhase = if (presentation.mode == MicDockMode.CONNECTING && !reduceMotion) {
        val transition = rememberInfiniteTransition(label = "micDockConnecting")
        val phase by transition.animateFloat(
            initialValue = 0f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart),
            label = "micDockConnectingPhase"
        )
        phase
    } else {
        0f
    }

    val meterLevel = if (reduceMotion) presentation.displayLevel else animatedLevel.value
    val motionLevel = if (reduceMotion) 0f else animatedLevel.value
    val accent = when (presentation.mode) {
        MicDockMode.IDLE -> HudColors.Ember
        MicDockMode.CONNECTING -> HudColors.Amber
        MicDockMode.LIVE, MicDockMode.MUTED -> HudColors.Lume
    }
    val shape = RoundedCornerShape(19.dp)
    val keyScale = 1f + motionLevel * 0.04f

    Surface(
        onClick = onClick,
        modifier = Modifier
            .widthIn(max = 300.dp)
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .shadow(
                elevation = (12f + 8f * motionLevel).dp,
                shape = shape,
                ambientColor = accent.copy(alpha = 0.20f + 0.22f * motionLevel),
                spotColor = accent.copy(alpha = 0.20f + 0.22f * motionLevel)
            )
            .semantics {
                contentDescription = presentation.accessibilityLabel
                role = Role.Button
            },
        shape = shape,
        color = Color(0xFF11100E),
        border = BorderStroke(1.dp, accent.copy(alpha = 0.34f + 0.28f * motionLevel))
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 64.dp)
                .background(
                    Brush.verticalGradient(listOf(Color(0x0DFFFFFF), Color.Transparent, Color(0x22110E0D)))
                )
                .padding(start = 8.dp, end = 15.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(13.dp)
        ) {
            Box(
                modifier = Modifier
                    .size(46.dp)
                    .graphicsLayer { scaleX = keyScale; scaleY = keyScale }
                    .background(accent.copy(alpha = 0.13f), RoundedCornerShape(13.dp))
                    .border(1.dp, accent.copy(alpha = 0.30f + 0.25f * motionLevel), RoundedCornerShape(13.dp)),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = if (presentation.mode == MicDockMode.IDLE) Icons.Filled.Mic else Icons.Filled.Close,
                    contentDescription = null,
                    tint = accent,
                    modifier = Modifier.size(25.dp)
                )
            }
            Box(Modifier.width(1.dp).height(28.dp).background(Color(0x24C4DAD8)))
            Text(
                text = presentation.label,
                modifier = Modifier.weight(1f),
                color = HudColors.HudInk,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.64.sp
            )
            when (presentation.mode) {
                MicDockMode.MUTED -> Icon(
                    imageVector = Icons.Filled.MicOff,
                    contentDescription = null,
                    tint = HudColors.Amber,
                    modifier = Modifier.size(20.dp)
                )
                MicDockMode.CONNECTING -> VoiceInputMeter(
                    heights = listOf(6f, 12f, 6f),
                    color = HudColors.Amber,
                    level = 0f,
                    phase = if (reduceMotion) null else connectingPhase
                )
                MicDockMode.IDLE, MicDockMode.LIVE -> VoiceInputMeter(
                    heights = micMeterHeights(meterLevel),
                    color = accent,
                    level = meterLevel,
                    phase = null
                )
            }
        }
    }
}

@Composable
private fun VoiceInputMeter(heights: List<Float>, color: Color, level: Float, phase: Float?) {
    Row(
        modifier = Modifier.width(24.dp).height(20.dp).semantics { },
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        heights.forEachIndexed { index, height ->
            val shimmer = phase?.let {
                (0.5 + 0.5 * sin(it * 2 * PI - index * 1.7)).toFloat()
            }
            Box(
                Modifier
                    .width(4.dp)
                    .height(height.dp)
                    .background(
                        color.copy(alpha = shimmer?.let { 0.25f + 0.65f * it } ?: 0.28f + 0.72f * level),
                        RoundedCornerShape(4.dp)
                    )
            )
        }
    }
}

@Composable
internal fun MuteUtilityPill(muted: Boolean, onClick: () -> Unit) {
    val tint = if (muted) HudColors.Amber else HudColors.HudDim
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(50),
        color = if (muted) HudColors.Amber.copy(alpha = 0.16f) else HudColors.PanelElevated
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Icon(
                imageVector = if (muted) Icons.Filled.MicOff else Icons.Filled.Mic,
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(16.dp)
            )
            Text(if (muted) "取消静音" else "静音", color = tint, fontSize = 13.sp, fontWeight = FontWeight.Medium)
        }
    }
}
```

- [ ] **Step 2: Replace the Android circular controls**

In `AgentScreen.kt`, change the screen composition to:

```kotlin
SecondaryControls(state = state, viewModel = viewModel)
Spacer(Modifier.height(16.dp))
VoiceMicDock(state = state, onClick = onToggleHandsFree)
```

Replace `SecondaryControls` with:

```kotlin
@Composable
private fun SecondaryControls(state: AgentSession.State, viewModel: MainViewModel) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        PillToggle(glyph = "💬", label = "字幕", on = viewModel.showCaptions, onClick = viewModel::toggleCaptions)
        if (state.handsFree) {
            MuteUtilityPill(muted = state.micMuted, onClick = viewModel::toggleMute)
        }
        PillToggle(glyph = "⚙", label = "设置", on = false, onClick = { viewModel.showPreferences = true })
    }
}
```

Delete the old `PrimaryControls` and `CircleControl` functions. Remove the now-unused `Close`, `Mic`, `MicOff`, `Icon`, and `ImageVector` imports from `AgentScreen.kt`; those imports belong only in `VoiceMicDock.kt`.

- [ ] **Step 3: Build and test Android**

Run:

```bash
cd android
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

Expected: every unit test passes and `android/app/build/outputs/apk/debug/app-debug.apk` is produced with `BUILD SUCCESSFUL`.

- [ ] **Step 4: Commit the Android dock**

```bash
git add android/app/src/main/java/com/horizon/maxhelmet/ui/AgentScreen.kt android/app/src/main/java/com/horizon/maxhelmet/ui/VoiceMicDock.kt
git commit -m "feat(android): add web-style voice mic dock"
```

---

### Task 3: iOS microphone-dock presentation model

**Files:**
- Create: `ios/MaxHelmet/UI/VoiceMicDockModel.swift`
- Test: `ios/MaxHelmetTests/VoiceMicDockTests.swift`

**Interfaces:**
- Consumes: `AgentSession.State`, `ConnectionState`, and `TurnState` from the existing iOS target.
- Produces: `MicDockMode`, `MicDockPresentation`, `isVoiceInputActive(_:)`, `micDisplayLevel(_:)`, `micDockPresentation(_:)`, and `micMeterHeights(_:)` for Task 4.

- [ ] **Step 1: Write the failing iOS model tests**

Create `ios/MaxHelmetTests/VoiceMicDockTests.swift`:

```swift
import XCTest
@testable import MaxHelmet

final class VoiceMicDockTests: XCTestCase {
    func testMapsIdleConnectingLiveAndMutedStates() {
        var state = AgentSession.State()
        XCTAssertEqual(micDockPresentation(state).mode, .idle)
        XCTAssertEqual(micDockPresentation(state).label, "开始免提")

        state.handsFree = true
        state.connection = .provider
        XCTAssertEqual(micDockPresentation(state).mode, .connecting)
        XCTAssertEqual(micDockPresentation(state).label, "连接中")

        state.connection = .ready
        XCTAssertEqual(micDockPresentation(state).mode, .live)
        XCTAssertEqual(micDockPresentation(state).label, "结束免提")

        state.micMuted = true
        XCTAssertEqual(micDockPresentation(state).mode, .muted)
    }

    func testAnimatesOnlyReadyUnmutedRiderInput() {
        var state = AgentSession.State()
        state.handsFree = true
        state.connection = .ready
        state.turnState = .listening
        state.voiceLevel = 0.5

        XCTAssertTrue(isVoiceInputActive(state))
        state.turnState = .hearing
        XCTAssertTrue(isVoiceInputActive(state))
        state.turnState = .thinking
        XCTAssertFalse(isVoiceInputActive(state))
        state.turnState = .speaking
        XCTAssertFalse(isVoiceInputActive(state))
        state.turnState = .listening
        state.connection = .degraded
        XCTAssertFalse(isVoiceInputActive(state))
        state.connection = .ready
        state.micMuted = true
        XCTAssertFalse(isVoiceInputActive(state))
    }

    func testAppliesNoiseFloorSensitivityAndClamp() {
        var state = AgentSession.State()
        state.handsFree = true
        state.connection = .ready
        state.turnState = .listening

        state.voiceLevel = 0.035
        XCTAssertEqual(micDisplayLevel(state), 0, accuracy: 0.0001)
        state.voiceLevel = 0.5
        XCTAssertEqual(micDisplayLevel(state), 0.7905, accuracy: 0.0001)
        state.voiceLevel = 1
        XCTAssertEqual(micDisplayLevel(state), 1, accuracy: 0.0001)
        state.turnState = .thinking
        XCTAssertEqual(micDisplayLevel(state), 0, accuracy: 0.0001)
    }

    func testReturnsStableThreeBarGeometry() {
        XCTAssertEqual(micMeterHeights(0), [6, 6, 6])
        XCTAssertEqual(micMeterHeights(1), [14, 18, 15])
        XCTAssertEqual(micMeterHeights(2), [14, 18, 15])
    }
}
```

- [ ] **Step 2: Run the iOS test target and verify it fails**

Run:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcodebuild -project ios/MaxHelmet.xcodeproj -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:MaxHelmetTests/VoiceMicDockTests test
```

Expected: compilation fails with unresolved references such as `MicDockMode` and `micDockPresentation`.

- [ ] **Step 3: Implement the pure iOS model**

Create `ios/MaxHelmet/UI/VoiceMicDockModel.swift`:

```swift
import Foundation

let micDockNoiseFloor: Float = 0.035
let micDockSensitivity: Float = 1.7

enum MicDockMode: Equatable {
    case idle, connecting, live, muted
}

struct MicDockPresentation: Equatable {
    let mode: MicDockMode
    let label: String
    let accessibilityLabel: String
    let displayLevel: Float
}

func isVoiceInputActive(_ state: AgentSession.State) -> Bool {
    state.handsFree &&
        state.connection == .ready &&
        !state.micMuted &&
        (state.turnState == .listening || state.turnState == .hearing)
}

func micDisplayLevel(_ state: AgentSession.State) -> Float {
    guard isVoiceInputActive(state) else { return 0 }
    return min(max((state.voiceLevel - micDockNoiseFloor) * micDockSensitivity, 0), 1)
}

func micDockPresentation(_ state: AgentSession.State) -> MicDockPresentation {
    let mode: MicDockMode
    if !state.handsFree {
        mode = .idle
    } else if state.connection != .ready {
        mode = .connecting
    } else if state.micMuted {
        mode = .muted
    } else {
        mode = .live
    }

    switch mode {
    case .idle:
        return MicDockPresentation(mode: mode, label: "开始免提", accessibilityLabel: "开始免提", displayLevel: 0)
    case .connecting:
        return MicDockPresentation(mode: mode, label: "连接中", accessibilityLabel: "正在连接免提，点按取消", displayLevel: 0)
    case .live:
        return MicDockPresentation(mode: mode, label: "结束免提", accessibilityLabel: "结束免提", displayLevel: micDisplayLevel(state))
    case .muted:
        return MicDockPresentation(mode: mode, label: "结束免提", accessibilityLabel: "结束免提", displayLevel: 0)
    }
}

func micMeterHeights(_ level: Float) -> [CGFloat] {
    let value = CGFloat(min(max(level, 0), 1))
    return [6 + 8 * value, 6 + 12 * value, 6 + 9 * value]
}
```

- [ ] **Step 4: Run focused and full iOS tests**

Run:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcodebuild -project ios/MaxHelmet.xcodeproj -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:MaxHelmetTests/VoiceMicDockTests test

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcodebuild -project ios/MaxHelmet.xcodeproj -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

Expected: `VoiceMicDockTests` passes, then the complete `MaxHelmetTests` target reports `** TEST SUCCEEDED **`.

- [ ] **Step 5: Commit the iOS model**

```bash
git add ios/MaxHelmet/UI/VoiceMicDockModel.swift ios/MaxHelmetTests/VoiceMicDockTests.swift
git commit -m "test(ios): define microphone dock states"
```

---

### Task 4: iOS SwiftUI dock and screen integration

**Files:**
- Create: `ios/MaxHelmet/UI/VoiceMicDock.swift`
- Modify: `ios/MaxHelmet/UI/AgentScreen.swift:158-172, 688-797`

**Interfaces:**
- Consumes: all Task 3 model interfaces plus `HudColors`.
- Produces: `VoiceMicDock(state:action:)` and `MuteUtilityPill(muted:action:)` for `AgentScreen`.

- [ ] **Step 1: Add the focused SwiftUI component**

Create `ios/MaxHelmet/UI/VoiceMicDock.swift`:

```swift
import SwiftUI

struct VoiceMicDock: View {
    let state: AgentSession.State
    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var displayedLevel: Float = 0

    private var presentation: MicDockPresentation { micDockPresentation(state) }

    private var accent: Color {
        switch presentation.mode {
        case .idle: return HudColors.ember
        case .connecting: return HudColors.amber
        case .live, .muted: return HudColors.lume
        }
    }

    var body: some View {
        TimelineView(
            .animation(
                minimumInterval: 1.0 / 30.0,
                paused: reduceMotion || presentation.mode != .connecting
            )
        ) { timeline in
            let phase = timeline.date.timeIntervalSinceReferenceDate
                .truncatingRemainder(dividingBy: 0.9) / 0.9
            let motionLevel: Float = reduceMotion ? 0 : displayedLevel

            Button(action: action) {
                HStack(spacing: 13) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 13)
                            .fill(accent.opacity(0.13))
                            .overlay(RoundedRectangle(cornerRadius: 13).stroke(accent.opacity(0.30 + 0.25 * Double(motionLevel))))
                        Image(systemName: presentation.mode == .idle ? "mic.fill" : "xmark")
                            .font(.system(size: 24, weight: .semibold))
                            .foregroundColor(accent)
                    }
                    .frame(width: 46, height: 46)
                    .scaleEffect(1 + CGFloat(motionLevel) * 0.04)

                    Rectangle().fill(Color(hex: 0xC4DAD8, alpha: 0.14)).frame(width: 1, height: 28)

                    Text(presentation.label)
                        .font(.system(size: 16, weight: .semibold))
                        .tracking(0.64)
                        .foregroundColor(HudColors.hudInk)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    trailing(phase: phase)
                }
                .padding(.leading, 8)
                .padding(.trailing, 15)
                .padding(.vertical, 8)
                .frame(maxWidth: 300, minHeight: 64)
                .background(
                    LinearGradient(
                        colors: [Color.white.opacity(0.05), Color.clear, Color(hex: 0x11100E)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 19)
                        .stroke(accent.opacity(0.34 + 0.28 * Double(motionLevel)), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 19))
                .shadow(
                    color: accent.opacity(0.12 + 0.22 * Double(motionLevel)),
                    radius: 12 + 8 * CGFloat(motionLevel),
                    y: 8
                )
            }
            .buttonStyle(.plain)
            .accessibilityLabel(presentation.accessibilityLabel)
        }
        .onAppear { displayedLevel = presentation.displayLevel }
        .onChange(of: presentation.displayLevel) { _, target in
            if reduceMotion {
                displayedLevel = target
            } else {
                withAnimation(.linear(duration: target > displayedLevel ? 0.08 : 0.18)) {
                    displayedLevel = target
                }
            }
        }
        .onChange(of: reduceMotion) { _, enabled in
            if enabled { displayedLevel = presentation.displayLevel }
        }
    }

    @ViewBuilder
    private func trailing(phase: Double) -> some View {
        switch presentation.mode {
        case .muted:
            Image(systemName: "mic.slash.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundColor(HudColors.amber)
                .frame(width: 24)
                .accessibilityHidden(true)
        case .connecting:
            VoiceInputMeter(
                heights: [6, 12, 6],
                color: HudColors.amber,
                level: 0,
                phase: reduceMotion ? nil : phase
            )
        case .idle, .live:
            VoiceInputMeter(
                heights: micMeterHeights(displayedLevel),
                color: accent,
                level: displayedLevel,
                phase: nil
            )
        }
    }
}

private struct VoiceInputMeter: View {
    let heights: [CGFloat]
    let color: Color
    let level: Float
    let phase: Double?

    var body: some View {
        HStack(spacing: 3) {
            ForEach(Array(heights.enumerated()), id: \.offset) { index, height in
                let shimmer = phase.map { 0.5 + 0.5 * sin($0 * 2 * .pi - Double(index) * 1.7) }
                Capsule()
                    .fill(color.opacity(shimmer.map { 0.25 + 0.65 * $0 } ?? 0.28 + 0.72 * Double(level)))
                    .frame(width: 4, height: height)
            }
        }
        .frame(width: 24, height: 20)
        .accessibilityHidden(true)
    }
}

struct MuteUtilityPill: View {
    let muted: Bool
    let action: () -> Void

    var body: some View {
        let tint = muted ? HudColors.amber : HudColors.hudDim
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: muted ? "mic.slash.fill" : "mic.fill")
                    .font(.system(size: 13, weight: .semibold))
                Text(muted ? "取消静音" : "静音")
                    .font(.system(size: 13, weight: .medium))
            }
            .foregroundColor(tint)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(Capsule().fill(muted ? HudColors.amber.opacity(0.16) : HudColors.panelElevated))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(muted ? "取消静音" : "静音")
    }
}
```

- [ ] **Step 2: Replace the iOS circular controls**

In `AgentScreen.swift`, change the screen composition to:

```swift
SecondaryControls(state: state, viewModel: viewModel)

VoiceMicDock(state: state, action: viewModel.toggleHandsFree)
```

Replace `SecondaryControls` with:

```swift
private struct SecondaryControls: View {
    let state: AgentSession.State
    @ObservedObject var viewModel: MainViewModel

    var body: some View {
        HStack {
            PillToggle(icon: "text.bubble", label: "字幕", on: viewModel.showCaptions) {
                viewModel.toggleCaptions()
            }

            Spacer(minLength: 8)

            if state.handsFree {
                MuteUtilityPill(muted: state.micMuted, action: viewModel.toggleMute)
                Spacer(minLength: 8)
            }

            PillToggle(icon: "gearshape.fill", label: "设置", on: false) {
                viewModel.showPreferences = true
            }
        }
    }
}
```

Delete the old `PrimaryControls` and `CircleControl` structs. Keep `PillToggle` because Captions and Settings still use it.

- [ ] **Step 3: Build and test iOS**

Run:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcodebuild -project ios/MaxHelmet.xcodeproj -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

Expected: the synchronized Xcode groups discover both new source files automatically and the run ends with `** TEST SUCCEEDED **`.

- [ ] **Step 4: Commit the iOS dock**

```bash
git add ios/MaxHelmet/UI/AgentScreen.swift ios/MaxHelmet/UI/VoiceMicDock.swift
git commit -m "feat(ios): add web-style voice mic dock"
```

---

### Task 5: Cross-platform verification and documentation

**Files:**
- Modify: `README.md:44-62`
- Modify: `android/README.md:108-118`
- Modify: `ios/README.md:130-145`

**Interfaces:**
- Consumes: completed Android and iOS docks from Tasks 2 and 4.
- Produces: verified parity evidence and accurate repository documentation.

- [ ] **Step 1: Run the repository and native verification suites**

Run:

```bash
npm test
npm run build
cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug
cd ..
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcodebuild -project ios/MaxHelmet.xcodeproj -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

Expected: Vitest passes, the web production build succeeds, Android reports `BUILD SUCCESSFUL`, and iOS reports `** TEST SUCCEEDED **`.

- [ ] **Step 2: Verify Android behavior with the mock relay**

Start the relay in one terminal:

```bash
VOICE_PROVIDER=mock npm run dev:server
```

Install and launch the Android app in another terminal:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am force-stop com.horizon.maxhelmet
adb shell monkey -p com.horizon.maxhelmet 1
```

Pass when the idle dock matches Web, Connecting and Live labels are correct, speaking into the emulator microphone moves the three bars and glow, Max playback does not move them, Mute moves to the utility row and stops the meter, and ending the session resets the level immediately. Turn Android animator duration scale off and confirm the meter updates discretely without scaling or shimmer.

- [ ] **Step 3: Verify iOS behavior with the mock relay**

Build, install, and launch on the documented simulator:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcodebuild -project ios/MaxHelmet.xcodeproj -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath /tmp/MaxHelmetMicDock build

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl boot 'iPhone 17 Pro' || true
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl install booted \
  /tmp/MaxHelmetMicDock/Build/Products/Debug-iphonesimulator/MaxHelmet.app
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl launch booted com.horizon.maxhelmet
```

Pass when the same state, rider-input, playback, Mute, reset, VoiceOver, and Reduce Motion checks from Android pass on iOS.

- [ ] **Step 4: Update the capability documentation**

Add this bullet to each native README's implemented-capabilities list and replace the root README's old mobile-control bullet with the same fact:

```markdown
- Web-parity microphone dock — the native 300 × 64 start/end control mirrors the web HUD; its three-bar meter, key, and lume glow react only to live rider input, while Mute remains a separate utility action.
```

Do not replace screenshot assets unless new captures were produced from both platforms in the verified idle state.

- [ ] **Step 5: Run final diff and verification checks**

Run:

```bash
git diff --check
git status --short
rg -n "CircleControl|PrimaryControls" android/app/src/main/java/com/horizon/maxhelmet/ui/AgentScreen.kt ios/MaxHelmet/UI/AgentScreen.swift
```

Expected: `git diff --check` is silent; `git status --short` lists only the intended README changes; the `rg` command exits with no matches.

- [ ] **Step 6: Commit documentation and verification evidence**

```bash
git add README.md android/README.md ios/README.md
git commit -m "docs: describe native voice-reactive mic dock"
```

---

## Completion Criteria

- Android and iOS use one rectangular web-parity start/end dock and no longer render circular primary microphone controls.
- Mute is visible as a utility pill only during hands-free sessions.
- The pure models and their Android/iOS tests agree on every state, gating rule, curve, and meter height.
- Rider speech drives the meter, key scale, and glow; silence, reconnecting, muted capture, Thinking, and Max playback do not.
- Reduced Motion and screen-reader checks pass on both platforms.
- Web, Android, and iOS build/test commands pass.
- Documentation accurately describes the shipped control without presenting stale screenshots as new evidence.
