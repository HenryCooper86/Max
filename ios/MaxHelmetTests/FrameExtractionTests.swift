import UIKit
import XCTest
@testable import MaxHelmet

final class FrameExtractionTests: XCTestCase {
    private func syntheticJpeg(side: CGFloat) -> Data {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side))
        let image = renderer.image { context in
            UIColor.systemRed.setFill()
            context.fill(CGRect(x: 0, y: 0, width: side, height: side))
        }
        return image.jpegData(compressionQuality: 0.9)!
    }

    /// A 2 s, 320x240 H.264 clip checked in beside the tests. The test used to
    /// encode one at run time, and on CI simulators the encoder's first start
    /// sometimes took longer than the test would wait.
    private func fixtureMov() throws -> URL {
        try XCTUnwrap(
            Bundle(for: FrameExtractionTests.self).url(forResource: "two-second-clip", withExtension: "mov"),
            "two-second-clip.mov is missing from the test bundle"
        )
    }

    func testPhotoBase64UnderCap() {
        let base64 = FrameExtraction.photoBase64(from: syntheticJpeg(side: 3000))
        XCTAssertNotNil(base64)
        XCTAssertLessThanOrEqual(base64!.count, FrameExtraction.maxBase64Chars)
        XCTAssertNotNil(Data(base64Encoded: base64!))
    }

    func testPhotoBase64FailsHonestlyOnGarbage() {
        XCTAssertNil(FrameExtraction.photoBase64(from: Data([0x00, 0x01])))
    }

    func testVideoFramesCountAndCap() async throws {
        let frames = await FrameExtraction.videoFramesBase64(from: try fixtureMov())
        XCTAssertEqual(frames?.count, FrameExtraction.videoFrameCount)
        for frame in frames ?? [] {
            XCTAssertLessThanOrEqual(frame.count, FrameExtraction.maxBase64Chars)
            XCTAssertNotNil(Data(base64Encoded: frame))
        }
    }

    func testVideoFramesFailHonestlyOnMissingFile() async {
        let frames = await FrameExtraction.videoFramesBase64(from: URL(fileURLWithPath: "/nonexistent.mov"))
        XCTAssertNil(frames)
    }
}
