#if DEBUG
import CoreLocation
import Foundation

struct AMapDeviceValidationRequest: Equatable {
    let routeEnabled: Bool
    let resetConsent: Bool

    init(routeEnabled: Bool, resetConsent: Bool) {
        self.routeEnabled = routeEnabled
        self.resetConsent = resetConsent
    }

    init(arguments: [String]) {
        routeEnabled = arguments.contains("--debug-amap-route")
        resetConsent = arguments.contains("--debug-reset-amap-consent")
    }
}

enum AMapDeviceValidationHarness {
    static let guidanceFixture = GuidanceState(
        destinationName: "上海外滩验证路线",
        polyline: [
            CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737),
            CLLocationCoordinate2D(latitude: 31.2311, longitude: 121.4744),
            CLLocationCoordinate2D(latitude: 31.2320, longitude: 121.4753),
        ],
        currentLocation: CLLocationCoordinate2D(latitude: 31.2304, longitude: 121.4737),
        maneuverInstruction: "沿中山东一路向北",
        distanceToManeuverMeters: 180,
        remainingDistanceMeters: 1_400,
        remainingSeconds: 360,
        offRoute: false
    )

    @MainActor
    static func apply(
        arguments: [String],
        defaults: UserDefaults,
        installGuidance: (GuidanceState) -> Void
    ) {
        let request = AMapDeviceValidationRequest(arguments: arguments)
        if request.resetConsent {
            defaults.removeObject(forKey: AMapConsentStore.defaultsKey)
        }
        if request.routeEnabled {
            installGuidance(guidanceFixture)
        }
    }
}
#endif
