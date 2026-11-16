package com.horizon.maxhelmet.ui

import android.graphics.Bitmap
import androidx.annotation.DrawableRes
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.horizon.maxhelmet.R

/** The eight device profiles the relay's device presets know, each with a bundled mark. */
val DEVICE_PROFILES: List<String> = listOf(
    "motorcycle-helmet", "bicycle-helmet", "sunglasses", "smart-glasses",
    "assistive-glasses", "ar-headset", "vr-headset", "wearable"
)

/**
 * The mark to show: the relay's `deviceProfile` when it is one we ship, otherwise by the coarse
 * `device` family (helmet -> motorcycle-helmet, glasses -> smart-glasses, other -> wearable).
 */
fun deviceMarkProfile(profile: String?, kind: DeviceKind?): String {
    val id = profile?.trim()?.lowercase()
    if (id != null && id in DEVICE_PROFILES) return id
    return when (kind) {
        DeviceKind.HELMET -> "motorcycle-helmet"
        DeviceKind.GLASSES -> "smart-glasses"
        else -> "wearable"
    }
}

@DrawableRes
internal fun deviceMarkRes(profile: String): Int = when (profile) {
    "motorcycle-helmet" -> R.drawable.ic_device_motorcycle_helmet
    "bicycle-helmet" -> R.drawable.ic_device_bicycle_helmet
    "sunglasses" -> R.drawable.ic_device_sunglasses
    "smart-glasses" -> R.drawable.ic_device_smart_glasses
    "assistive-glasses" -> R.drawable.ic_device_assistive_glasses
    "ar-headset" -> R.drawable.ic_device_ar_headset
    "vr-headset" -> R.drawable.ic_device_vr_headset
    else -> R.drawable.ic_device_wearable
}

/**
 * The assistant's mark: the owner's PNG logo when the relay serves one (already decoded in
 * [logo]), otherwise the bundled mark for the device. A custom SVG logo cannot be drawn without
 * an extra dependency, so it falls back to the device mark too.
 */
@Composable
fun DeviceLogo(
    profile: String?,
    kind: DeviceKind?,
    logo: Bitmap? = null,
    size: Dp = 28.dp,
    contentDescription: String? = null,
    modifier: Modifier = Modifier
) {
    val mod = modifier.size(size).clip(RoundedCornerShape(size * 0.22f))
        .let { if (contentDescription != null) it.semantics { this.contentDescription = contentDescription } else it }
    if (logo != null) {
        Image(logo.asImageBitmap(), contentDescription = null, modifier = mod, contentScale = ContentScale.Crop)
    } else {
        Image(painterResource(deviceMarkRes(deviceMarkProfile(profile, kind))), contentDescription = null, modifier = mod)
    }
}
