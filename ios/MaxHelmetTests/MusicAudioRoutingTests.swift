import AVFoundation
import XCTest
@testable import MaxHelmet

final class MusicAudioRoutingTests: XCTestCase {
    func testVoiceAllowsMusicWithoutGivingUpHeadsetInput() {
        XCTAssertTrue(AudioRouter.voiceOptions.contains(.mixWithOthers),
                      "Music must not interrupt the full-duplex voice session")
        XCTAssertTrue(AudioRouter.voiceOptions.contains(.allowBluetoothHFP))
        XCTAssertTrue(AudioRouter.voiceOptions.contains(.defaultToSpeaker))
    }
}
