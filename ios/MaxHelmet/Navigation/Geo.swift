import CoreLocation
import Foundation

/// Pure geodesy for the guidance engine. Small distances only (a route), so a
/// local equirectangular projection is accurate enough and much cheaper than
/// full spherical trig for the cross-track case.
enum Geo {
    private static let earthRadius = 6_371_000.0

    static func haversineMeters(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        let dLat = (b.latitude - a.latitude) * .pi / 180
        let dLon = (b.longitude - a.longitude) * .pi / 180
        let lat1 = a.latitude * .pi / 180
        let lat2 = b.latitude * .pi / 180
        let h = sin(dLat / 2) * sin(dLat / 2) + cos(lat1) * cos(lat2) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * earthRadius * asin(min(1, sqrt(h)))
    }

    /// Shortest distance from `point` to the segment [segStart, segEnd], clamped
    /// to the endpoints (so a point beyond the segment measures to the endpoint).
    static func crossTrackMeters(
        point p: CLLocationCoordinate2D,
        segStart a: CLLocationCoordinate2D,
        segEnd b: CLLocationCoordinate2D
    ) -> Double {
        let latRef = a.latitude * .pi / 180
        func xy(_ c: CLLocationCoordinate2D) -> (Double, Double) {
            let x = (c.longitude - a.longitude) * .pi / 180 * cos(latRef) * earthRadius
            let y = (c.latitude - a.latitude) * .pi / 180 * earthRadius
            return (x, y)
        }
        let (px, py) = xy(p)
        let (bx, by) = xy(b) // a is the origin
        let segLenSq = bx * bx + by * by
        if segLenSq == 0 { return sqrt(px * px + py * py) }
        var t = (px * bx + py * by) / segLenSq
        t = max(0, min(1, t))
        let dx = px - t * bx
        let dy = py - t * by
        return sqrt(dx * dx + dy * dy)
    }

    /// Nearest distance from `point` to any segment of the polyline.
    static func nearestSegmentDistance(_ point: CLLocationCoordinate2D, _ polyline: [CLLocationCoordinate2D]) -> Double {
        guard polyline.count >= 2 else {
            return polyline.first.map { haversineMeters(point, $0) } ?? .infinity
        }
        var best = Double.infinity
        for i in 0..<(polyline.count - 1) {
            best = min(best, crossTrackMeters(point: point, segStart: polyline[i], segEnd: polyline[i + 1]))
        }
        return best
    }
}
