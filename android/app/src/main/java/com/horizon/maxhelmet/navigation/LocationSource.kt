package com.horizon.maxhelmet.navigation

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Looper
import androidx.core.content.ContextCompat

/** Delivers raw WGS-84 device fixes. start() is idempotent. */
interface LocationSource {
    fun start(onFix: (LatLon) -> Unit)
    fun stop()
}

/**
 * Thin `LocationManager.GPS_PROVIDER` glue behind [LocationSource] — the seam
 * that keeps [NavigationController] (and everything it touches) pure JVM and
 * unit-testable without Robolectric. Untested by design: this class is
 * exercised by [NavigationController]'s fakes, never directly.
 *
 * No datum conversion happens here: fixes are delivered exactly as
 * `android.location.Location` reports them, raw WGS-84.
 * `NavigationController.onFix` is the app's one `wgs84ToGcj02` call site —
 * adding a second one here would be a defect.
 */
class LocationManagerSource(private val context: Context) : LocationSource {
    private val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager

    private var listener: LocationListenerAdapter? = null

    @SuppressLint("MissingPermission")
    override fun start(onFix: (LatLon) -> Unit) {
        if (listener != null) return // idempotent: already streaming
        if (!hasPermission()) return
        val newListener = LocationListenerAdapter(onFix)
        val service = manager ?: return
        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .filter { runCatching { service.isProviderEnabled(it) }.getOrDefault(false) }
        var registered = false
        for (provider in providers) {
            if (runCatching { service.requestLocationUpdates(provider, 1_000L, 0f, newListener, Looper.getMainLooper()) }.isSuccess) {
                registered = true
            }
        }
        if (registered) {
            listener = newListener
            providers.mapNotNull { runCatching { service.getLastKnownLocation(it) }.getOrNull() }
                .filter { validNavigationFix(it) }
                .minByOrNull { it.accuracy }
                ?.let { newListener.onLocationChanged(it) }
        }
    }

    override fun stop() {
        val current = listener ?: return
        listener = null
        current.active = false
        runCatching { manager?.removeUpdates(current) }
    }

    private fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /** A named class (rather than a SAM lambda) so `stop()` can hand the
     *  exact same listener instance back to `removeUpdates`. */
    private class LocationListenerAdapter(private val onFix: (LatLon) -> Unit) : android.location.LocationListener {
        var active = true
        override fun onLocationChanged(location: Location) {
            if (active && validNavigationFix(location)) onFix(LatLon(location.latitude, location.longitude))
        }
    }
}

private fun validNavigationFix(location: Location): Boolean {
    val age = (android.os.SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos) / 1_000_000_000.0
    return age in 0.0..15.0 && location.hasAccuracy() && location.accuracy.isFinite() && location.accuracy in 0f..100f
        && location.latitude.isFinite() && location.latitude in -90.0..90.0
        && location.longitude.isFinite() && location.longitude in -180.0..180.0
}
