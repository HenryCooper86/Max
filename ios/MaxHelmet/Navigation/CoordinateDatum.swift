import CoreLocation

/// WGS-84 ↔ GCJ-02 coordinate datum transforms.
///
/// iOS is the only platform that needs the inverse (routes arrive GCJ-02, but
/// everything inside the app speaks WGS-84; see spec §Coordinates). The forward
/// transform is a literal port of shared/geo.ts; the inverse is computed iteratively
/// (no closed form exists).
///
/// CRITICAL: The constants A and EE must never drift from shared/geo.ts.
/// If the TypeScript reference changes, this must change with it.
enum CoordinateDatum {
    /// WGS-84 → GCJ-02. Literal port of shared/geo.ts (A = 6378245,
    /// EE = 0.006693421622965943, same outOfChina bounds, same transform series).
    static func wgs84ToGcj02(_ coordinate: CLLocationCoordinate2D) -> CLLocationCoordinate2D {
        if outOfChina(coordinate.latitude, coordinate.longitude) {
            return coordinate
        }

        let dLat = transformLat(coordinate.longitude - 105, coordinate.latitude - 35)
        let dLon = transformLon(coordinate.longitude - 105, coordinate.latitude - 35)

        let radLat = (coordinate.latitude / 180) * .pi
        var magic = sin(radLat)
        magic = 1 - EE * magic * magic
        let sqrtMagic = sqrt(magic)

        let adjustedLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * .pi)
        let adjustedLon = (dLon * 180) / ((A / sqrtMagic) * cos(radLat) * .pi)

        return CLLocationCoordinate2D(
            latitude: coordinate.latitude + adjustedLat,
            longitude: coordinate.longitude + adjustedLon
        )
    }

    /// GCJ-02 → WGS-84. Iterative inverse (5 rounds of cur -= forward(cur) - target);
    /// no closed form exists. Round-trips to < 1 m. iOS is the only platform that
    /// needs the inverse (routes arrive GCJ-02, everything inside speaks WGS-84).
    static func gcj02ToWgs84(_ coordinate: CLLocationCoordinate2D) -> CLLocationCoordinate2D {
        var current = coordinate

        for _ in 0..<5 {
            let forward = wgs84ToGcj02(current)
            let delta = CLLocationCoordinate2D(
                latitude: current.latitude - (forward.latitude - coordinate.latitude),
                longitude: current.longitude - (forward.longitude - coordinate.longitude)
            )
            current = delta
        }

        return current
    }

    // MARK: - Private Helpers

    private static let A = 6378245.0
    private static let EE = 0.006693421622965943

    private static func outOfChina(_ lat: Double, _ lon: Double) -> Bool {
        return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271
    }

    private static func transformLat(_ x: Double, _ y: Double) -> Double {
        var ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * sqrt(abs(x))
        ret += ((20 * sin(6 * x * .pi) + 20 * sin(2 * x * .pi)) * 2) / 3
        ret += ((20 * sin(y * .pi) + 40 * sin((y / 3) * .pi)) * 2) / 3
        ret += ((160 * sin((y / 12) * .pi) + 320 * sin((y * .pi) / 30)) * 2) / 3
        return ret
    }

    private static func transformLon(_ x: Double, _ y: Double) -> Double {
        var ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * sqrt(abs(x))
        ret += ((20 * sin(6 * x * .pi) + 20 * sin(2 * x * .pi)) * 2) / 3
        ret += ((20 * sin(x * .pi) + 40 * sin((x / 3) * .pi)) * 2) / 3
        ret += ((150 * sin((x / 12) * .pi) + 300 * sin((x / 30) * .pi)) * 2) / 3
        return ret
    }
}
