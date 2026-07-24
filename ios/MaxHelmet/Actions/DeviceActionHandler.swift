import Foundation

/// One capability. Kept behind a protocol so every handler is replaceable by a
/// fake in tests — none of the real ones work in the simulator.
protocol DeviceActionHandler {
    func perform(_ action: DeviceAction) async -> DeviceActionResult
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
        }
    }
}
