import AVFoundation
import XCTest
@testable import MaxHelmet

final class MusicAudioRoutingTests: XCTestCase {
    func testVoiceAllowsMusicWithoutGivingUpHeadsetInput() {
        XCTAssertTrue(AudioRouter.voiceOptions.contains(.mixWithOthers),
                      "Music must not interrupt the full-duplex voice session")
        XCTAssertTrue(AudioRouter.voiceOptions.contains(.allowBluetooth),
                      "HFP input remains available when built with older iOS SDKs")
        XCTAssertTrue(AudioRouter.voiceOptions.contains(.allowBluetoothA2DP))
        XCTAssertTrue(AudioRouter.voiceOptions.contains(.defaultToSpeaker))
    }
}
