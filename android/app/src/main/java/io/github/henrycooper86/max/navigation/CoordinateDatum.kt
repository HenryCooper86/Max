package io.github.henrycooper86.max.navigation

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/** A latitude/longitude pair. Inside the Android app every LatLon is GCJ-02
 *  by convention (spec §Coordinates "Android: GCJ-02 inside"); raw WGS-84
 *  exists only in the instant between a GPS fix and wgs84ToGcj02 at the
 *  controller's fix boundary. */
data class LatLon(val lat: Double, val lon: Double)

/**
 * WGS-84 → GCJ-02, the standard published transform. One conversion, at the location source:
 * everything downstream of this call — guidance math, nav.* events, map
 * rendering on GCJ-02 surfaces — speaks GCJ-02. Literal port of shared/geo.ts
 * (A = 6378245.0, EE = 0.006693421622965943, same outOfChina bounds, same series).
 * Android needs no inverse: routes arrive GCJ-02 and stay GCJ-02.
 *
 * CRITICAL: The constants A and EE must never drift from shared/geo.ts.
 * If the TypeScript reference changes, this must change with it.
 */
object CoordinateDatum {
    /** WGS-84 → GCJ-02. Literal port of shared/geo.ts. */
    fun wgs84ToGcj02(coordinate: LatLon): LatLon {
        if (outOfChina(coordinate.lat, coordinate.lon)) {
            return coordinate
        }

        val dLat = transformLat(coordinate.lon - 105, coordinate.lat - 35)
        val dLon = transformLon(coordinate.lon - 105, coordinate.lat - 35)

        val radLat = (coordinate.lat / 180) * PI
        var magic = sin(radLat)
        magic = 1 - EE * magic * magic
        val sqrtMagic = sqrt(magic)

        val adjustedLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI)
        val adjustedLon = (dLon * 180) / ((A / sqrtMagic) * cos(radLat) * PI)

        return LatLon(coordinate.lat + adjustedLat, coordinate.lon + adjustedLon)
    }

    // MARK: - Private Helpers

    private const val A = 6378245.0
    private const val EE = 0.006693421622965943

    private fun outOfChina(lat: Double, lon: Double): Boolean {
        return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271
    }

    private fun transformLat(x: Double, y: Double): Double {
        var ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * sqrt(abs(x))
        ret += ((20 * sin(6 * x * PI) + 20 * sin(2 * x * PI)) * 2) / 3
        ret += ((20 * sin(y * PI) + 40 * sin((y / 3) * PI)) * 2) / 3
        ret += ((160 * sin((y / 12) * PI) + 320 * sin((y * PI) / 30)) * 2) / 3
        return ret
    }

    private fun transformLon(x: Double, y: Double): Double {
        var ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * sqrt(abs(x))
        ret += ((20 * sin(6 * x * PI) + 20 * sin(2 * x * PI)) * 2) / 3
        ret += ((20 * sin(x * PI) + 40 * sin((x / 3) * PI)) * 2) / 3
        ret += ((150 * sin((x / 12) * PI) + 300 * sin((x / 30) * PI)) * 2) / 3
        return ret
    }
}
