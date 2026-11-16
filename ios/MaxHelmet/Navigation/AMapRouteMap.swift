import CoreLocation
import SwiftUI

#if !targetEnvironment(simulator)
import UIKit

private final class RouteMapAnnotation: MAPointAnnotation {
    var kind = "rider"
}

struct AMapRouteMap: UIViewRepresentable {
    let model: AMapRouteDisplayModel
    let consent: AMapAcceptedConsent
    let apiKey: String
    @Binding var loadFailed: Bool
    var interactive = false
    var followsRider = false
    var bootstrapper = AMapSDKBootstrapper.shared

    func makeCoordinator() -> Coordinator {
        Coordinator(loadFailed: $loadFailed)
    }

    func makeUIView(context: Context) -> MAMapView {
        precondition(
            bootstrapper.prepare(
                consent: consent,
                apiKey: apiKey,
                configuration: liveAMapSDKPrivacyConfiguration()
            ),
            "AMapRouteMap requires accepted consent and a configured key"
        )

        let mapView = MAMapView(frame: .zero)
        mapView.delegate = context.coordinator
        mapView.isUserInteractionEnabled = interactive
        mapView.isZoomEnabled = interactive
        mapView.isScrollEnabled = interactive
        mapView.isRotateEnabled = false
        mapView.isRotateCameraEnabled = false
        mapView.touchPOIEnabled = false
        mapView.showsUserLocation = false
        mapView.isShowsLabels = true
        mapView.showsScale = interactive
        context.coordinator.configure(interactive: interactive, followsRider: followsRider)
        context.coordinator.render(model, on: mapView)
        return mapView
    }

    func updateUIView(_ mapView: MAMapView, context: Context) {
        context.coordinator.loadFailed = $loadFailed
        context.coordinator.configure(interactive: interactive, followsRider: followsRider)
        context.coordinator.render(model, on: mapView)
    }

    static func dismantleUIView(_ mapView: MAMapView, coordinator: Coordinator) {
        coordinator.clear(on: mapView)
        mapView.delegate = nil
    }

    final class Coordinator: NSObject, MAMapViewDelegate {
        var loadFailed: Binding<Bool>
        private var routeOverlay: MAPolyline?
        private var riderAnnotation: MAPointAnnotation?
        private var destinationAnnotation: MAPointAnnotation?
        private var turnAnnotation: MAPointAnnotation?
        private var interactive = false
        private var followsRider = false

        func configure(interactive: Bool, followsRider: Bool) {
            if self.followsRider != followsRider { lastAppliedBounds = nil }
            self.interactive = interactive
            self.followsRider = followsRider
        }
        private var lastPolyline: [CLLocationCoordinate2D] = []
        private var lastRider: CLLocationCoordinate2D?
        /// Only ever set when a region was applied to a map view that had real
        /// bounds. The first render runs at `.zero`, where `setRegion` cannot
        /// take, so recording that pass would strand the camera on the SDK's
        /// default city.
        private var lastAppliedBounds: AMapCoordinateBounds?
        private var latestModel: AMapRouteDisplayModel?

        init(loadFailed: Binding<Bool>) {
            self.loadFailed = loadFailed
        }

        func render(_ model: AMapRouteDisplayModel, on mapView: MAMapView) {
            latestModel = model
            guard UIApplication.shared.applicationState == .active else { return }
            if !sameCoordinates(lastPolyline, model.polyline) {
                if let routeOverlay { mapView.remove(routeOverlay) }

                var coordinates = model.polyline
                let overlay = MAPolyline(coordinates: &coordinates, count: UInt(coordinates.count))!
                mapView.add(overlay)
                routeOverlay = overlay
                lastPolyline = model.polyline
                lastAppliedBounds = nil
            }

            // Deliberately not folded into the branch above: the overlay only
            // has to be added once, but the camera has to wait for real bounds.
            if (lastAppliedBounds == nil || !interactive || followsRider), shouldApplyAMapCamera(
                lastApplied: lastAppliedBounds,
                bounds: model.bounds,
                viewportSize: mapView.bounds.size
            ) {
                mapView.setRegion(
                    MACoordinateRegion(
                        center: model.bounds.center,
                        span: MACoordinateSpan(
                            latitudeDelta: model.bounds.latitudeSpan * 1.25,
                            longitudeDelta: model.bounds.longitudeSpan * 1.25
                        )
                    ),
                    animated: false
                )
                lastAppliedBounds = model.bounds
            }

            if !sameOptionalCoordinate(lastRider, model.currentLocation) {
                if let riderAnnotation { mapView.removeAnnotation(riderAnnotation) }
                riderAnnotation = model.currentLocation.map { coordinate in
                    let annotation = MAPointAnnotation()
                    annotation.coordinate = coordinate
                    annotation.title = L("nav.currentLocation")
                    mapView.addAnnotation(annotation)
                    return annotation
                }
                lastRider = model.currentLocation
            }
            destinationAnnotation = updateMarker(destinationAnnotation, coordinate: model.polyline.last, title: model.destinationName, kind: "destination", on: mapView)
            turnAnnotation = updateMarker(turnAnnotation, coordinate: model.nextTurn, title: model.nextTurnInstruction ?? L("nav.nextTurn"), kind: "turn", on: mapView)
        }

        private func updateMarker(_ marker: MAPointAnnotation?, coordinate: CLLocationCoordinate2D?, title: String, kind: String, on map: MAMapView) -> MAPointAnnotation? {
            guard let coordinate else {
                if let marker { map.removeAnnotation(marker) }
                return nil
            }
            if let marker, marker.title == title {
                marker.coordinate = coordinate
                return marker
            }
            if let marker { map.removeAnnotation(marker) }
            let point = RouteMapAnnotation()
            point.kind = kind
            point.coordinate = coordinate
            point.title = title
            map.addAnnotation(point)
            return point
        }

        func clear(on mapView: MAMapView) {
            if let routeOverlay { mapView.remove(routeOverlay) }
            if let riderAnnotation { mapView.removeAnnotation(riderAnnotation) }
            if let destinationAnnotation { mapView.removeAnnotation(destinationAnnotation) }
            if let turnAnnotation { mapView.removeAnnotation(turnAnnotation) }
            destinationAnnotation = nil
            turnAnnotation = nil
            routeOverlay = nil
            riderAnnotation = nil
            lastPolyline = []
            lastRider = nil
            lastAppliedBounds = nil
            latestModel = nil
        }

        func mapView(
            _ mapView: MAMapView!,
            rendererFor overlay: MAOverlay!
        ) -> MAOverlayRenderer! {
            guard let polyline = overlay as? MAPolyline else { return nil }
            let renderer = MAPolylineRenderer(polyline: polyline)
            renderer?.lineWidth = 5
            renderer?.strokeColor = UIColor(
                red: 71 / 255,
                green: 227 / 255,
                blue: 155 / 255,
                alpha: 1
            )
            renderer?.lineJoinType = kMALineJoinRound
            renderer?.lineCapType = kMALineCapRound
            return renderer
        }

        func mapView(
            _ mapView: MAMapView!,
            viewFor annotation: MAAnnotation!
        ) -> MAAnnotationView! {
            guard let point = annotation as? MAPointAnnotation else { return nil }
            let isDestination = (point as? RouteMapAnnotation)?.kind == "destination"
            let isTurn = (point as? RouteMapAnnotation)?.kind == "turn"
            let identifier = isDestination ? "max-destination" : isTurn ? "max-turn" : "max-rider"
            let view = mapView.dequeueReusableAnnotationView(withIdentifier: identifier)
                ?? MAAnnotationView(annotation: annotation, reuseIdentifier: identifier)
            view?.annotation = annotation
            view?.image = UIImage(systemName: isDestination ? "flag.checkered.circle.fill" : isTurn ? navigationManeuverSymbol(point.title ?? "") : "location.circle.fill")?.withConfiguration(UIImage.SymbolConfiguration(pointSize: 28, weight: .bold)).withTintColor(
                UIColor(red: 1, green: 106 / 255, blue: 61 / 255, alpha: 1),
                renderingMode: .alwaysOriginal
            )
            view?.canShowCallout = interactive
            return view
        }

        func mapViewDidFinishLoadingMap(_ mapView: MAMapView!) {
            DispatchQueue.main.async { self.loadFailed.wrappedValue = false }
            // By now the view is laid out, so a camera withheld during the
            // zero-frame pass can finally be applied. SwiftUI does not promise
            // an updateUIView after layout, so this is the reliable hook.
            if let latestModel, let mapView {
                render(latestModel, on: mapView)
            }
        }

        func mapViewDidFailLoadingMap(_ mapView: MAMapView!, withError error: Error!) {
            DispatchQueue.main.async { self.loadFailed.wrappedValue = true }
        }
    }
}

private func sameCoordinates(
    _ lhs: [CLLocationCoordinate2D],
    _ rhs: [CLLocationCoordinate2D]
) -> Bool {
    lhs.count == rhs.count && zip(lhs, rhs).allSatisfy(coordinatesEqual)
}

private func sameOptionalCoordinate(
    _ lhs: CLLocationCoordinate2D?,
    _ rhs: CLLocationCoordinate2D?
) -> Bool {
    switch (lhs, rhs) {
    case (nil, nil): return true
    case let (left?, right?): return coordinatesEqual(left, right)
    default: return false
    }
}
#else
struct AMapRouteMap: View {
    let model: AMapRouteDisplayModel
    let consent: AMapAcceptedConsent
    let apiKey: String
    @Binding var loadFailed: Bool
    var interactive = false
    var followsRider = false

    var body: some View {
        Text("AMap requires a real device")
            .multilineTextAlignment(.center)
            .accessibilityLabel("AMap requires a real device")
    }
}
#endif
