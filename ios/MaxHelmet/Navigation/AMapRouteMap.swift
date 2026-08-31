import CoreLocation
import SwiftUI

#if !targetEnvironment(simulator)
import UIKit

struct AMapRouteMap: UIViewRepresentable {
    let model: AMapRouteDisplayModel
    let consent: AMapAcceptedConsent
    let apiKey: String
    @Binding var loadFailed: Bool
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
        mapView.isUserInteractionEnabled = false
        mapView.isZoomEnabled = false
        mapView.isScrollEnabled = false
        mapView.isRotateEnabled = false
        mapView.isRotateCameraEnabled = false
        mapView.touchPOIEnabled = false
        mapView.showsUserLocation = false
        context.coordinator.render(model, on: mapView)
        return mapView
    }

    func updateUIView(_ mapView: MAMapView, context: Context) {
        context.coordinator.loadFailed = $loadFailed
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
            if !sameCoordinates(lastPolyline, model.polyline) {
                if let routeOverlay { mapView.remove(routeOverlay) }

                var coordinates = model.polyline
                let overlay = MAPolyline(coordinates: &coordinates, count: UInt(coordinates.count))!
                mapView.add(overlay)
                routeOverlay = overlay
                lastPolyline = model.polyline
            }

            // Deliberately not folded into the branch above: the overlay only
            // has to be added once, but the camera has to wait for real bounds.
            if shouldApplyAMapCamera(
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
                    mapView.addAnnotation(annotation)
                    return annotation
                }
                lastRider = model.currentLocation
            }
        }

        func clear(on mapView: MAMapView) {
            if let routeOverlay { mapView.remove(routeOverlay) }
            if let riderAnnotation { mapView.removeAnnotation(riderAnnotation) }
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
            guard annotation is MAPointAnnotation else { return nil }

            let identifier = "max-rider"
            let view = mapView.dequeueReusableAnnotationView(withIdentifier: identifier)
                ?? MAAnnotationView(annotation: annotation, reuseIdentifier: identifier)
            view?.annotation = annotation
            view?.image = UIImage(systemName: "location.fill")?.withTintColor(
                UIColor(red: 1, green: 106 / 255, blue: 61 / 255, alpha: 1),
                renderingMode: .alwaysOriginal
            )
            view?.canShowCallout = false
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

    var body: some View {
        Text("AMap requires a real device")
            .multilineTextAlignment(.center)
            .accessibilityLabel("AMap requires a real device")
    }
}
#endif
