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
        listener = newListener
        runCatching {
            manager?.requestLocationUpdates(
                LocationManager.GPS_PROVIDER,
                1_000L,
                0f,
                newListener,
                Looper.getMainLooper()
            )
        }
    }

    override fun stop() {
        val current = listener ?: return
        listener = null
        manager?.removeUpdates(current)
    }

    private fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /** A named class (rather than a SAM lambda) so `stop()` can hand the
     *  exact same listener instance back to `removeUpdates`. */
    private class LocationListenerAdapter(private val onFix: (LatLon) -> Unit) : android.location.LocationListener {
        override fun onLocationChanged(location: Location) {
            onFix(LatLon(location.latitude, location.longitude))
        }
    }
}
