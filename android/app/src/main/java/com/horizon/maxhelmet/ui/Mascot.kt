package com.horizon.maxhelmet.ui

import android.content.Context
import android.graphics.ImageDecoder
import android.graphics.drawable.Animatable
import android.graphics.drawable.Drawable
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.coerceIn
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.horizon.maxhelmet.R
import com.horizon.maxhelmet.agent.AgentSession

/**
 * The assistant's character: a hummingbird, filmed hovering and cut out of
 * its background, that keeps the lens company.
 *
 * A filmed bird cannot act, so its moods are shown by how it flies: it leans
 * in to listen, drifts while the assistant thinks, bobs while it speaks and
 * starts back at a hazard. The wearer can move it too: it drifts the way the
 * phone is tipped and flies to a finger on the screen. The footage is an
 * animated image with transparency.
 * It is drawn straight onto a canvas, so it never takes a tap meant for the
 * lens. With animations turned off, or before Android 9, it is a still frame.
 *
 * Footage credit: public/character/CREDITS.txt.
 */
internal enum class MascotMood { READY, LISTENING, THINKING, SPEAKING, ALERT, ASLEEP }

/** The mood that goes with what the lens is showing. */
internal fun mascotMood(mode: VisorMode, hazardShown: Boolean): MascotMood = when {
    mode != VisorMode.OFFLINE && hazardShown -> MascotMood.ALERT
    mode == VisorMode.IDLE -> MascotMood.READY
    mode == VisorMode.CONNECTING || mode == VisorMode.THINKING -> MascotMood.THINKING
    mode == VisorMode.LISTENING -> MascotMood.LISTENING
    mode == VisorMode.SPEAKING -> MascotMood.SPEAKING
    else -> MascotMood.ASLEEP
}

internal fun mascotMood(state: AgentSession.State): MascotMood =
    mascotMood(visorMode(state), isHazardPresentationActive(state))

/** The bird's width and its offset from the lens's centre, for a lens this
 *  wide: on the upper right of the rim, on every screen. */
internal fun mascotPlacement(lensWidth: Dp): Pair<Dp, DpOffset> {
    val half = lensWidth / 2
    return (half * 0.62f).coerceIn(72.dp, 180.dp) to DpOffset(half * 0.74f, -half * 0.42f)
}

/**
 * The tilt filter. The bird drifts the way the phone is tipped, like
 * something floating, and comes back when the phone is held still in its new
 * position: the resting posture is tracked slowly and only the change from it
 * moves the bird. The output is smoothed and limited so a shaking phone, on a
 * moving bike for one, makes the bird sway rather than jitter.
 *
 * Gravity is in g, in the phone's own axes as Android reports it (x to the
 * right, y up the screen; upright is y = +1).
 */
internal class MascotTilt {
    private var restX = Float.NaN
    private var restY = Float.NaN
    /** Where the bird is drawn, in bird widths (x) and heights (y). */
    var x = 0f
        private set
    var y = 0f
        private set

    fun step(gravityX: Float, gravityY: Float, dt: Float) {
        if (restX.isNaN()) { restX = gravityX; restY = gravityY }
        val follow = (dt / 2.5f).coerceAtMost(1f)
        restX += (gravityX - restX) * follow
        restY += (gravityY - restY) * follow
        // Tip the right edge down and the bird slides right; tip the top away
        // and it slides up the screen.
        val wantedX = (-(gravityX - restX) * 2.2f).coerceIn(-LIMIT_X, LIMIT_X)
        val wantedY = ((gravityY - restY) * 2.2f).coerceIn(-LIMIT_Y, LIMIT_Y)
        val ease = (dt / 0.25f).coerceAtMost(1f)
        x += (wantedX - x) * ease
        y += (wantedY - y) * ease
    }

    companion object {
        const val LIMIT_X = 0.7f
        const val LIMIT_Y = 0.5f
    }
}

/** What the wearer is doing to the bird: where a finger is on the screen (in
 *  root coordinates) and how the phone is tipped. One, because there is one bird. */
internal object MascotPilot {
    var finger by mutableStateOf<Offset?>(null)
    var tilt by mutableStateOf(Offset.Zero)
}

/** Lets the bird see touches anywhere on this element without taking them:
 *  buttons, the lens and scrolling all keep working. Put it on an element
 *  that fills the window, so its touch positions are root positions. */
internal fun Modifier.mascotFollowsTouches(): Modifier = pointerInput(Unit) {
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        MascotPilot.finger = down.position
        while (true) {
            val event = awaitPointerEvent(PointerEventPass.Initial)
            val pressed = event.changes.firstOrNull { it.pressed } ?: break
            MascotPilot.finger = pressed.position
        }
        MascotPilot.finger = null
    }
}

/** Feeds the phone's tilt to the bird while this is on screen. */
@Composable
private fun MascotTiltSensor(enabled: Boolean) {
    val context = LocalContext.current
    DisposableEffect(enabled) {
        val manager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        val sensor = manager?.getDefaultSensor(Sensor.TYPE_GRAVITY)
            ?: manager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        if (!enabled || manager == null || sensor == null) {
            MascotPilot.tilt = Offset.Zero
            return@DisposableEffect onDispose { }
        }
        val filter = MascotTilt()
        var last = 0L
        val listener = object : SensorEventListener {
            override fun onSensorChanged(event: SensorEvent) {
                val dt = if (last == 0L) 1f / 30f else ((event.timestamp - last) / 1e9f).coerceIn(0.001f, 0.2f)
                last = event.timestamp
                filter.step(event.values[0] / SensorManager.GRAVITY_EARTH, event.values[1] / SensorManager.GRAVITY_EARTH, dt)
                MascotPilot.tilt = Offset(filter.x, filter.y)
            }
            override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
        }
        manager.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_GAME)
        onDispose {
            manager.unregisterListener(listener)
            MascotPilot.tilt = Offset.Zero
        }
    }
}

private data class Flight(val x: Float, val y: Float, val tilt: Float, val scale: Float)

private fun flightFor(mood: MascotMood) = when (mood) {
    MascotMood.READY -> Flight(0f, 0f, 0f, 1f)
    MascotMood.LISTENING -> Flight(-0.10f, 0.08f, 4f, 1.06f)
    MascotMood.THINKING -> Flight(0.06f, -0.10f, -5f, 1f)
    MascotMood.SPEAKING -> Flight(-0.04f, 0.02f, 0f, 1.04f)
    MascotMood.ALERT -> Flight(0.12f, -0.08f, -8f, 0.94f)
    MascotMood.ASLEEP -> Flight(0f, 0.08f, 0f, 0.96f)
}

@Composable
internal fun Mascot(
    mood: MascotMood,
    width: Dp,
    modifier: Modifier = Modifier,
    /** Off when the phone is sideways: the tilt axes are the portrait ones. */
    tiltEnabled: Boolean = true
) {
    val context = LocalContext.current
    val still = Settings.Global.getFloat(
        context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f
    ) == 0f
    val drawable = remember(still) {
        val film = if (!still && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            runCatching {
                ImageDecoder.decodeDrawable(ImageDecoder.createSource(context.resources, R.raw.hummingbird))
            }.getOrNull()
        } else null
        film ?: ContextCompat.getDrawable(context, R.drawable.hummingbird_still)
    }
    // The animated drawable asks to be redrawn through its callback.
    var frame by remember { mutableIntStateOf(0) }
    val callback = remember {
        val handler = Handler(Looper.getMainLooper())
        object : Drawable.Callback {
            override fun invalidateDrawable(who: Drawable) { frame++ }
            override fun scheduleDrawable(who: Drawable, what: Runnable, time: Long) {
                handler.postAtTime(what, who, time)
            }
            override fun unscheduleDrawable(who: Drawable, what: Runnable) {
                handler.removeCallbacks(what, who)
            }
        }
    }
    DisposableEffect(drawable) {
        drawable?.callback = callback
        (drawable as? Animatable)?.start()
        onDispose {
            (drawable as? Animatable)?.stop()
            drawable?.callback = null
        }
    }

    MascotTiltSensor(enabled = tiltEnabled && !still)
    // Where the bird's box sits when nothing has moved it, in root coordinates.
    var home by remember { mutableStateOf(Offset.Zero) }
    val finger = if (still) null else MascotPilot.finger

    val flight = flightFor(mood)
    val settle = spring<Float>(dampingRatio = 0.6f, stiffness = Spring.StiffnessLow)
    val x by animateFloatAsState(flight.x, settle, label = "mascotX")
    val y by animateFloatAsState(flight.y, settle, label = "mascotY")
    val tilt by animateFloatAsState(if (finger == null) flight.tilt else 0f, settle, label = "mascotTilt")
    val scale by animateFloatAsState(flight.scale, settle, label = "mascotScale")
    // A finger wins: the bird flies to it and hovers just above, beak towards
    // it. The pull goes from 0 (its own pose) to 1 (at the finger).
    val pull by animateFloatAsState(
        if (finger == null) 0f else 1f,
        spring(dampingRatio = 0.7f, stiffness = Spring.StiffnessMediumLow), label = "mascotPull"
    )
    var lastFinger by remember { mutableStateOf(Offset.Zero) }
    if (finger != null) lastFinger = finger
    // A slow drift, so the bird never hangs perfectly still.
    val drift = if (still) 0f else rememberInfiniteTransition(label = "mascotDrift").animateFloat(
        initialValue = 0.03f, targetValue = -0.05f,
        animationSpec = infiniteRepeatable(tween(2400), RepeatMode.Reverse), label = "mascotDriftY"
    ).value

    Canvas(
        modifier
            .size(width, width * 8 / 11)
            .clearAndSetSemantics { }
            .onGloballyPositioned { home = it.positionInRoot() }
            .graphicsLayer {
                val centre = home + Offset(size.width / 2, size.height / 2)
                val left = lastFinger.x < centre.x
                val ownX = (x + MascotPilot.tilt.x) * size.width
                val ownY = (y + drift + MascotPilot.tilt.y) * size.height
                val fingerX = lastFinger.x - centre.x + (if (left) 0.2f else -0.2f) * size.width
                val fingerY = lastFinger.y - centre.y - size.height * 0.75f
                translationX = ownX + (fingerX - ownX) * pull
                translationY = ownY + (fingerY - ownY) * pull
                rotationZ = tilt
                scaleX = if (left && pull > 0.5f) -scale else scale
                scaleY = scale
                alpha = if (mood == MascotMood.ASLEEP && finger == null) 0.6f else 1f
            }
    ) {
        frame // read, so a new frame redraws
        val bird = drawable ?: return@Canvas
        bird.setBounds(0, 0, size.width.toInt(), size.height.toInt())
        drawIntoCanvas { bird.draw(it.nativeCanvas) }
    }
}
