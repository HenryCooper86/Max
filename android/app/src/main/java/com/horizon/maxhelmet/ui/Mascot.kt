package com.horizon.maxhelmet.ui

import android.graphics.ImageDecoder
import android.graphics.drawable.Animatable
import android.graphics.drawable.Drawable
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
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
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
 * starts back at a hazard. The footage is an animated image with transparency.
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
internal fun Mascot(mood: MascotMood, width: Dp, modifier: Modifier = Modifier) {
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

    val flight = flightFor(mood)
    val settle = spring<Float>(dampingRatio = 0.6f, stiffness = Spring.StiffnessLow)
    val x by animateFloatAsState(flight.x, settle, label = "mascotX")
    val y by animateFloatAsState(flight.y, settle, label = "mascotY")
    val tilt by animateFloatAsState(flight.tilt, settle, label = "mascotTilt")
    val scale by animateFloatAsState(flight.scale, settle, label = "mascotScale")
    // A slow drift, so the bird never hangs perfectly still.
    val drift = if (still) 0f else rememberInfiniteTransition(label = "mascotDrift").animateFloat(
        initialValue = 0.03f, targetValue = -0.05f,
        animationSpec = infiniteRepeatable(tween(2400), RepeatMode.Reverse), label = "mascotDriftY"
    ).value

    Canvas(
        modifier
            .size(width, width * 8 / 11)
            .clearAndSetSemantics { }
            .graphicsLayer {
                translationX = x * size.width
                translationY = (y + drift) * size.height
                rotationZ = tilt
                scaleX = scale
                scaleY = scale
                alpha = if (mood == MascotMood.ASLEEP) 0.6f else 1f
            }
    ) {
        frame // read, so a new frame redraws
        val bird = drawable ?: return@Canvas
        bird.setBounds(0, 0, size.width.toInt(), size.height.toInt())
        drawIntoCanvas { bird.draw(it.nativeCanvas) }
    }
}
