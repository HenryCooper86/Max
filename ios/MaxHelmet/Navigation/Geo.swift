import CoreLocation
import Foundation

/// Pure geodesy for the guidance engine. Small distances only (a route), so a
/// local equirectangular projection is accurate enough and much cheaper than
/// full spherical trig for the cross-track case.
enum Geo {
    /// WGS-84 mean radius, meters — identical to shared/guidance.ts's
    /// EARTH_RADIUS_METERS. Every distance/projection helper below shares
    /// this one constant so no platform reports a different number for the
    /// same fix.
    static let earthRadiusMeters = 6_371_008.8

    static func haversineMeters(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        let dLat = (b.latitude - a.latitude) * .pi / 180
        let dLon = (b.longitude - a.longitude) * .pi / 180
        let lat1 = a.latitude * .pi / 180
        let lat2 = b.latitude * .pi / 180
        let h = sin(dLat / 2) * sin(dLat / 2) + cos(lat1) * cos(lat2) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * earthRadiusMeters * asin(min(1, sqrt(h)))
    }

    /// Shortest distance from `point` to the segment [segStart, segEnd], clamped
    /// to the endpoints (so a point beyond the segment measures to the endpoint).
    static func crossTrackMeters(
        point p: CLLocationCoordinate2D,
        segStart a: CLLocationCoordinate2D,
        segEnd b: CLLocationCoordinate2D
    ) -> Double {
        nearestOnSegment(p, a, b).crossTrackMeters
    }

    /// Nearest distance from `point` to any segment of the polyline.
    static func nearestSegmentDistance(_ point: CLLocationCoordinate2D, _ polyline: [CLLocationCoordinate2D]) -> Double {
        snapToRoute(point, polyline).crossTrackMeters
    }

    // MARK: - Equirectangular snap primitives
    //
    // Literal duplicates of shared/guidance.ts's `toLocal` / `nearestOnSegment`
    // / snap loop — this is the math the six-rule port contract (see
    // GuidanceEngine.swift) depends on being bit-for-bit the same shape across
    // platforms. Sub-meter divergence here is exactly the failure mode the
    // contract calls out: it can shift which threshold fires at a boundary fix.

    /// Local x/y (meters) of `point` in an equirectangular projection centered
    /// on `origin`. Literal port of shared/guidance.ts's `toLocal`.
    static func localXY(of point: CLLocationCoordinate2D, around origin: CLLocationCoordinate2D) -> (x: Double, y: Double) {
        let originLatRad = origin.latitude * .pi / 180
        let x = (point.longitude - origin.longitude) * .pi / 180 * earthRadiusMeters * cos(originLatRad)
        let y = (point.latitude - origin.latitude) * .pi / 180 * earthRadiusMeters
        return (x, y)
    }

    struct SegmentSnap {
        let crossTrackMeters: Double
        let alongSegmentMeters: Double
        let segmentLengthMeters: Double
    }

    /// Point-to-segment projection: clamps to the segment endpoints (no
    /// extrapolation past a→b) and returns both the cross-track distance and
    /// how far along the segment the projection landed. Literal port of
    /// shared/guidance.ts's `nearestOnSegment`.
    static func nearestOnSegment(_ p: CLLocationCoordinate2D, _ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> SegmentSnap {
        let pB = localXY(of: b, around: a)
        let pP = localXY(of: p, around: a)
        let segLenSq = pB.x * pB.x + pB.y * pB.y
        let segmentLengthMeters = sqrt(segLenSq)
        let t = segLenSq == 0 ? 0 : max(0, min(1, (pP.x * pB.x + pP.y * pB.y) / segLenSq))
        let projX = t * pB.x
        let projY = t * pB.y
        let crossTrackMeters = hypot(pP.x - projX, pP.y - projY)
        return SegmentSnap(crossTrackMeters: crossTrackMeters, alongSegmentMeters: t * segmentLengthMeters, segmentLengthMeters: segmentLengthMeters)
    }

    struct RouteSnap {
        let crossTrackMeters: Double
        let alongRouteMeters: Double
    }

    /// Snaps `position` to the nearest point on the polyline, tracking both
    /// cross-track distance (for off-route) and cumulative along-route
    /// distance (for maneuver/arrival math) from the best-matching segment.
    /// Literal port of shared/guidance.ts's `snapToRoute`, including its tie-
    /// break: only a STRICTLY smaller cross-track distance replaces the best
    /// match, so on a tie the first segment in array order (lowest index) wins.
    static func snapToRoute(_ position: CLLocationCoordinate2D, _ polyline: [CLLocationCoordinate2D]) -> RouteSnap {
        guard let first = polyline.first else {
            return RouteSnap(crossTrackMeters: .infinity, alongRouteMeters: 0)
        }
        if polyline.count == 1 {
            return RouteSnap(crossTrackMeters: haversineMeters(position, first), alongRouteMeters: 0)
        }

        var cumulativeMeters = 0.0
        var best = RouteSnap(crossTrackMeters: .infinity, alongRouteMeters: 0)
        for i in 0..<(polyline.count - 1) {
            let a = polyline[i]
            let b = polyline[i + 1]
            let snap = nearestOnSegment(position, a, b)
            if snap.crossTrackMeters < best.crossTrackMeters {
                best = RouteSnap(crossTrackMeters: snap.crossTrackMeters, alongRouteMeters: cumulativeMeters + snap.alongSegmentMeters)
            }
            cumulativeMeters += snap.segmentLengthMeters
        }
        return best
    }
}
