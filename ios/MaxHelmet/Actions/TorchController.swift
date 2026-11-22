import AVFoundation

/// The torch surface the handler needs. AVCaptureDevice is not constructible in
/// tests and absent in the simulator, so the handler talks to this instead.
protocol TorchCapableDevice {
    var hasTorch: Bool { get }
    func setTorch(on: Bool) throws
}

/// Torch via AVCaptureDevice. Setting torchMode needs no camera permission —
/// only capture does — so this handler never prompts.
struct SystemTorchDevice: TorchCapableDevice {
    private let device = AVCaptureDevice.default(for: .video)

    var hasTorch: Bool { device?.hasTorch ?? false }

    func setTorch(on: Bool) throws {
        guard let device, device.torchMode != (on ? .on : .off) else { return }
        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }
        device.torchMode = on ? .on : .off
    }
}

struct TorchController: DeviceActionHandler {
    private let device: TorchCapableDevice

    init(device: TorchCapableDevice = SystemTorchDevice()) {
        self.device = device
    }

    func perform(_ action: DeviceAction) async -> DeviceActionResult {
        guard case let .torchSet(on) = action else { return .unsupported("action.mismatch") }
        guard device.hasTorch else { return .unsupported("torch.unavailable") }
        do {
            try device.setTorch(on: on)
            return .ok
        } catch {
            return .failed("torch.unavailable")
        }
    }
}
