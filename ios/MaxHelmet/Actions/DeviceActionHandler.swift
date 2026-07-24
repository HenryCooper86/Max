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
    case destination
    case camera
    case navigation

    init(_ action: DeviceAction) {
        switch action {
        case .torchSet: self = .torch
        case .volumeSet: self = .volume
        case .musicControl: self = .music
        case .smsCompose: self = .sms
        case .callDial: self = .call
        case .destinationShow: self = .destination
        case .cameraPhoto, .cameraRecord, .galleryOpen: self = .camera
        case .navigationStart, .navigationStop: self = .navigation
        }
    }
}
