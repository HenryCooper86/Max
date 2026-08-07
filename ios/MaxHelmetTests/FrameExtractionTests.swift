import AVFoundation
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

    /// Writes a ~2 s solid-color .mov via AVAssetWriter; returns its URL.
    private func syntheticMov() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("synthetic-\(UUID().uuidString).mov")

        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let outputSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: 320,
            AVVideoHeightKey: 240,
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: outputSettings)
        input.expectsMediaDataInRealTime = false

        let pixelBufferAttributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
            kCVPixelBufferWidthKey as String: 320,
            kCVPixelBufferHeightKey as String: 240,
        ]
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: pixelBufferAttributes
        )

        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)

        let frameCount = 20
        let fps: Int32 = 10

        let queue = DispatchQueue(label: "synthetic-mov-writer")
        let expectation = XCTestExpectation(description: "finishWriting")

        // Declared outside the closure: `requestMediaDataWhenReady`'s block can
        // fire more than once as the input drains, and resetting this per-call
        // would resubmit frames with non-monotonic presentation times (the
        // writer then fails silently and `finishWriting` never completes).
        var frame = 0
        input.requestMediaDataWhenReady(on: queue) {
            while input.isReadyForMoreMediaData && frame < frameCount {
                guard let pool = adaptor.pixelBufferPool else { break }
                var pixelBufferOut: CVPixelBuffer?
                CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixelBufferOut)
                guard let pixelBuffer = pixelBufferOut else { break }

                CVPixelBufferLockBaseAddress(pixelBuffer, [])
                if let base = CVPixelBufferGetBaseAddress(pixelBuffer) {
                    let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
                    let height = CVPixelBufferGetHeight(pixelBuffer)
                    // Fill with a solid opaque color (ARGB).
                    memset(base, 0xFF, bytesPerRow * height)
                }
                CVPixelBufferUnlockBaseAddress(pixelBuffer, [])

                let presentationTime = CMTime(value: CMTimeValue(frame), timescale: fps)
                adaptor.append(pixelBuffer, withPresentationTime: presentationTime)
                frame += 1
            }

            if frame >= frameCount {
                input.markAsFinished()
                writer.finishWriting {
                    expectation.fulfill()
                }
            }
        }

        wait(for: [expectation], timeout: 10)
        return url
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

    func testVideoFramesCountAndCap() throws {
        let url = try syntheticMov()
        defer { try? FileManager.default.removeItem(at: url) }
        let frames = FrameExtraction.videoFramesBase64(from: url)
        XCTAssertEqual(frames?.count, FrameExtraction.videoFrameCount)
        for frame in frames ?? [] {
            XCTAssertLessThanOrEqual(frame.count, FrameExtraction.maxBase64Chars)
            XCTAssertNotNil(Data(base64Encoded: frame))
        }
    }

    func testVideoFramesFailHonestlyOnMissingFile() {
        XCTAssertNil(FrameExtraction.videoFramesBase64(from: URL(fileURLWithPath: "/nonexistent.mov")))
    }
}
