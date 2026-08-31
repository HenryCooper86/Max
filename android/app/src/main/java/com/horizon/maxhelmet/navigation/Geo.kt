package com.horizon.maxhelmet.navigation

import kotlin.math.PI
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/** Pure geodesy for the guidance engine. Small distances only (a route), so a
 *  local equirectangular projection is accurate enough and much cheaper than
 *  full spherical trig for the cross-track case. Literal port of
 *  shared/guidance.ts's snap math (lines 40-125); ios/MaxHelmet/Navigation/Geo.swift
 *  is the tie-breaker on any reading doubt. Sub-meter divergence here is
 *  exactly the failure mode the six-rule port contract (GuidanceEngine.kt)
 *  calls out: it can shift which threshold fires at a boundary fix. */
object Geo {
    /** WGS-84 mean radius, meters — identical to shared/guidance.ts's
     *  EARTH_RADIUS_METERS. Every distance/projection helper below shares
     *  this one constant so no platform reports a different number for the
     *  same fix. */
    private const val EARTH_RADIUS_METERS = 6_371_008.8

    private fun toRad(deg: Double): Double = deg * PI / 180.0

    /** Standard great-circle distance, R = 6371008.8 m (WGS-84 mean radius). */
    fun haversineMeters(a: LatLon, b: LatLon): Double {
        val dLat = toRad(b.lat - a.lat)
        val dLon = toRad(b.lon - a.lon)
        val lat1 = toRad(a.lat)
        val lat2 = toRad(b.lat)
        val sinDLat = sin(dLat / 2)
        val sinDLon = sin(dLon / 2)
        val h = sinDLat * sinDLat + cos(lat1) * cos(lat2) * sinDLon * sinDLon
        return 2 * EARTH_RADIUS_METERS * asin(min(1.0, sqrt(h)))
    }

    private data class LocalPoint(val x: Double, val y: Double)

    /** Equirectangular projection of `point` in a frame centered on `origin`.
     *  Literal port of shared/guidance.ts's `toLocal`. */
    private fun localXY(origin: LatLon, point: LatLon): LocalPoint {
        val originLatRad = toRad(origin.lat)
        return LocalPoint(
            x = toRad(point.lon - origin.lon) * EARTH_RADIUS_METERS * cos(originLatRad),
            y = toRad(point.lat - origin.lat) * EARTH_RADIUS_METERS
        )
    }

    private data class SegmentSnap(
        val crossTrackMeters: Double,
        val alongSegmentMeters: Double,
        val segmentLengthMeters: Double
    )

    /** Point-to-segment projection: clamps to the segment endpoints (no
     *  extrapolation past a-b) and returns both the cross-track distance and
     *  how far along the segment the projection landed. Literal port of
     *  shared/guidance.ts's `nearestOnSegment`. */
    private fun nearestOnSegment(p: LatLon, a: LatLon, b: LatLon): SegmentSnap {
        val pB = localXY(a, b)
        val pP = localXY(a, p)
        val segLenSq = pB.x * pB.x + pB.y * pB.y
        val segmentLengthMeters = sqrt(segLenSq)
        val t = if (segLenSq == 0.0) 0.0 else max(0.0, min(1.0, (pP.x * pB.x + pP.y * pB.y) / segLenSq))
        val projX = t * pB.x
        val projY = t * pB.y
        val crossTrackMeters = hypot(pP.x - projX, pP.y - projY)
        return SegmentSnap(
            crossTrackMeters = crossTrackMeters,
            alongSegmentMeters = t * segmentLengthMeters,
            segmentLengthMeters = segmentLengthMeters
        )
    }

    data class Snap(val alongRouteMeters: Double, val crossTrackMeters: Double)

    /** Snaps `position` to the nearest point on the polyline, tracking both
     *  cross-track distance (for off-route) and cumulative along-route
     *  distance (for maneuver/arrival math) from the best-matching segment.
     *  Literal port of shared/guidance.ts's `snapToRoute`, including its
     *  tie-break: only a STRICTLY smaller cross-track distance replaces the
     *  best match, so on a tie the first segment in array order (lowest
     *  index) wins. */
    fun snapToRoute(position: LatLon, polyline: List<LatLon>): Snap {
        val first = polyline.firstOrNull()
            ?: return Snap(alongRouteMeters = 0.0, crossTrackMeters = Double.POSITIVE_INFINITY)
        if (polyline.size == 1) {
            return Snap(alongRouteMeters = 0.0, crossTrackMeters = haversineMeters(position, first))
        }

        var cumulativeMeters = 0.0
        var best = Snap(alongRouteMeters = 0.0, crossTrackMeters = Double.POSITIVE_INFINITY)
        for (i in 0 until polyline.size - 1) {
            val a = polyline[i]
            val b = polyline[i + 1]
            val snap = nearestOnSegment(position, a, b)
            if (snap.crossTrackMeters < best.crossTrackMeters) {
                best = Snap(
                    alongRouteMeters = cumulativeMeters + snap.alongSegmentMeters,
                    crossTrackMeters = snap.crossTrackMeters
                )
            }
            cumulativeMeters += snap.segmentLengthMeters
        }
        return best
    }
}
