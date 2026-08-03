import XCTest
@testable import MaxHelmet

final class SirenSourceTests: XCTestCase {

    func testPcmHasTheRightShapeAndIsLoud() {
        let pcm = SirenSource.makePcm(durationS: 2.0)
        XCTAssertEqual(pcm.count, Int(2.0 * 24_000) * 2, "24 kHz PCM16 mono: 2 bytes per sample")

        let samples: [Int16] = pcm.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        let rms = (samples.map { Double($0) * Double($0) }.reduce(0, +) / Double(samples.count)).squareRoot()
        XCTAssertGreaterThan(rms, 10_000, "the siren must be near full scale, not polite")
    }

    func testSirenPlayerLoopsUntilStopped() {
        var played = 0
        var stopped = 0
        let player = SirenPlayer(play: { _ in played += 1 }, stop: { stopped += 1 })
        player.start()
        XCTAssertEqual(played, 1, "first blast plays immediately")
        XCTAssertTrue(player.running)
        player.start()
        XCTAssertEqual(played, 1, "start is idempotent while running")
        player.stop()
        XCTAssertEqual(stopped, 1)
        XCTAssertFalse(player.running)
        player.stop()
        XCTAssertEqual(stopped, 1, "stop is idempotent")
    }
}
