import Foundation

/// One capability. Kept behind a protocol so every handler is replaceable by a
/// fake in tests — none of the real ones work in the simulator.
protocol DeviceActionHandler {
    func perform(_ action: DeviceAction) async -> DeviceActionResult
}

/// A handler whose result depends on the command's identity, not just its
/// action — currently only gallery.describe, which streams chunked
/// vision.frames events that each must carry the commandId so the relay can
/// reassemble them. `perform(_:)` never receives that id, and retrofitting it
/// onto the base protocol would force a signature change on all seven
/// existing handlers for a need only one of them has; this seam adds it
/// without touching them.
protocol IdentifiedDeviceActionHandler: DeviceActionHandler {
    func perform(_ action: DeviceAction, commandId: String) async -> DeviceActionResult
}

/// Routing key. One handler owns one route; the router never inspects args.
enum DeviceActionRoute: Hashable {
    case torch
    case volume
    case music
    case sms
    case call
    case camera
    case navigation
    case galleryDescribe

    init(_ action: DeviceAction) {
        switch action {
        case .torchSet: self = .torch
        case .volumeSet: self = .volume
        case .musicControl: self = .music
        case .smsCompose: self = .sms
        case .callDial: self = .call
        // Legacy destination.show and the new navigation actions all route to
        // the guidance handler, so a still-Spec-1 relay's "导航去X" also guides.
        case .destinationShow, .navigationStart, .navigationStop: self = .navigation
        case .cameraPhoto, .cameraRecord, .galleryOpen: self = .camera
        case .galleryDescribe: self = .galleryDescribe
        }
    }
}
