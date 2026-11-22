import ImageIO
import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import MaxHelmet

final class ImageInputTests: XCTestCase {

    // MARK: - session.started capabilities

    func testSessionStartedSaysWhetherTheBackendTakesPictures() {
        func capabilities(_ json: String) -> ProviderCapabilities? {
            let event = parseAgentEvent(#"{"type":"session.started","provider":"openai","mode":"live","capabilities":\#(json)}"#)
            guard case let .sessionStarted(_, _, capabilities) = event else { return nil }
            return capabilities
        }
        XCTAssertEqual(capabilities(#"{"textInput":true,"imageInput":true}"#)?.imageInput, true)
        XCTAssertEqual(capabilities(#"{"textInput":true,"imageInput":false}"#)?.imageInput, false)
        // A relay older than image input does not say, and does not take them.
        XCTAssertEqual(capabilities(#"{"textInput":true}"#)?.imageInput, false)
    }

    func testThePictureButtonIsThereWhenThePictureAndATypedTurnCouldBeSent() {
        var capabilities = ProviderCapabilities()
        capabilities.textInput = true
        XCTAssertFalse(imageInputVisible(capabilities: capabilities, connection: .ready))
        capabilities.imageInput = true
        XCTAssertTrue(imageInputVisible(capabilities: capabilities, connection: .ready))
        XCTAssertFalse(imageInputVisible(capabilities: capabilities, connection: .connecting))
        capabilities.textInput = false
        XCTAssertFalse(imageInputVisible(capabilities: capabilities, connection: .ready))
    }

    // MARK: - image.input

    private func event(_ json: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    func testTheEventCarriesAJPEGAndTheWordsThatGoWithIt() throws {
        let silent = try event(prepareImageInput(jpegBase64: "QUJD", imageInputSupported: true, ready: true).get())
        XCTAssertEqual(silent["type"] as? String, "image.input")
        XCTAssertEqual(silent["image"] as? String, "QUJD")
        XCTAssertEqual(silent["mimeType"] as? String, "image/jpeg")
        XCTAssertNil(silent["text"])
        XCTAssertEqual(silent.count, 3)
        let asked = try event(prepareImageInput(jpegBase64: "QUJD", text: "  What is this?\n", imageInputSupported: true, ready: true).get())
        XCTAssertEqual(asked["text"] as? String, "What is this?")
        // Blank words count as none, and long ones are cut like a typed turn.
        XCTAssertNil(try event(prepareImageInput(jpegBase64: "QUJD", text: "  \n", imageInputSupported: true, ready: true).get())["text"])
        let long = try event(prepareImageInput(jpegBase64: "QUJD", text: String(repeating: "x", count: 2050), imageInputSupported: true, ready: true).get())
        XCTAssertEqual((long["text"] as? String)?.utf16.count, textInputMaxUTF16Units)
    }

    func testAPictureIsNotSentWhenItCannotBeTaken() {
        XCTAssertEqual(prepareImageInput(jpegBase64: "QUJD", imageInputSupported: false, ready: true), .failure(.unsupported))
        XCTAssertEqual(prepareImageInput(jpegBase64: "QUJD", imageInputSupported: true, ready: false), .failure(.notReady))
        // Not while riding, like typing. An unknown speed does not lock it.
        XCTAssertEqual(prepareImageInput(jpegBase64: "QUJD", imageInputSupported: true, ready: true, speedKmh: 40), .failure(.moving))
        XCTAssertNotNil(try? prepareImageInput(jpegBase64: "QUJD", imageInputSupported: true, ready: true, speedKmh: nil).get())
        XCTAssertEqual(prepareImageInput(jpegBase64: "", imageInputSupported: true, ready: true), .failure(.unreadable))
        let tooLong = String(repeating: "A", count: imageInputMaxBase64Chars + 1)
        XCTAssertEqual(prepareImageInput(jpegBase64: tooLong, imageInputSupported: true, ready: true), .failure(.unreadable))
        XCTAssertNotNil(try? prepareImageInput(jpegBase64: String(tooLong.dropLast()), imageInputSupported: true, ready: true).get())
    }

    // MARK: - fitting a picture

    func testAPhotoIsScaledSoItsLongerSideIs1024AndASmallPictureIsLeftItsSize() {
        var asked: [[Int]] = []
        let encode: (Int, Int, Double) -> String? = { width, height, quality in
            asked.append([width, height, Int((quality * 100).rounded())])
            return "ok"
        }
        XCTAssertEqual(encodeImageForInput(width: 4000, height: 3000, encode: encode), "ok")
        XCTAssertEqual(asked, [[1024, 768, 85]])
        asked = []
        _ = encodeImageForInput(width: 3000, height: 4000, encode: encode)
        XCTAssertEqual(asked, [[768, 1024, 85]])
        asked = []
        _ = encodeImageForInput(width: 320, height: 200, encode: encode)
        XCTAssertEqual(asked, [[320, 200, 85]])
        asked = []
        // A panorama keeps at least one pixel of its short side.
        _ = encodeImageForInput(width: 10_000, height: 3, encode: encode)
        XCTAssertEqual(asked, [[1024, 1, 85]])
    }

    func testQualityIsLoweredBeforeSizeUntilThePictureFits() {
        var asked: [[Int]] = []
        let tooLong = String(repeating: "A", count: imageInputMaxBase64Chars + 1)
        // Fits only at 576 pixels and the lowest quality.
        let fitted = encodeImageForInput(width: 2048, height: 2048) { width, height, quality in
            asked.append([width, height, Int((quality * 100).rounded())])
            return width <= 576 && quality <= 0.55 ? "fits" : tooLong
        }
        XCTAssertEqual(fitted, "fits")
        XCTAssertEqual(asked, [
            [1024, 1024, 85], [1024, 1024, 70], [1024, 1024, 55],
            [768, 768, 85], [768, 768, 70], [768, 768, 55],
            [576, 576, 85], [576, 576, 70], [576, 576, 55]
        ])
    }

    func testAPictureThatNeverFitsHasNoPixelsOrCannotBeEncodedIsGivenUpOn() {
        var tries = 0
        let tooLong = String(repeating: "A", count: imageInputMaxBase64Chars + 1)
        XCTAssertNil(encodeImageForInput(width: 2048, height: 2048) { _, _, _ in tries += 1; return tooLong })
        // 1024, 768, 576, 432, 324, 243, 182, 136, 102, 76: ten sizes of three qualities, and no size under 64.
        XCTAssertEqual(tries, 30)
        XCTAssertNil(encodeImageForInput(width: 0, height: 100) { _, _, _ in "ok" })
        XCTAssertNil(encodeImageForInput(width: 100, height: -1) { _, _, _ in "ok" })
        XCTAssertNil(encodeImageForInput(width: 100, height: 100) { _, _, _ in nil })
        XCTAssertNil(encodeImageForInput(width: 100, height: 100) { _, _, _ in "" })
    }

    // MARK: - the relay's limits

    func testThePhoneKeepsTheRelaysLimits() {
        var limiter = ImageInputLimiter()
        XCTAssertNil(limiter.rejection(at: 10))
        limiter.didSend(at: 10)
        XCTAssertEqual(limiter.rejection(at: 10.999), .tooFast)
        XCTAssertNil(limiter.rejection(at: 11))
        for index in 1..<imageInputMaxPerConnection { limiter.didSend(at: 10 + Double(index) * 2) }
        XCTAssertEqual(limiter.rejection(at: 1_000), .tooMany)
        // A new connection starts a new count.
        limiter.reset()
        XCTAssertNil(limiter.rejection(at: 1_000))
    }

    // MARK: - a real picture

    /// A photo as a camera writes it: `width` × `height` pixels as stored, with an EXIF orientation. Red on the
    /// left half and blue on the right, or, `noisy`, a different colour in every pixel, which does not compress.
    private func photo(width: Int, height: Int, orientation: CGImagePropertyOrientation = .up, noisy: Bool = false) throws -> Data {
        var pixels = [UInt8](repeating: 255, count: width * height * 4)
        var seed: UInt64 = 42
        for y in 0..<height {
            for x in 0..<width {
                let at = (y * width + x) * 4
                if noisy {
                    seed = seed &* 6364136223846793005 &+ 1442695040888963407
                    pixels[at] = UInt8((seed >> 16) & 0xFF)
                    pixels[at + 1] = UInt8((seed >> 24) & 0xFF)
                    pixels[at + 2] = UInt8((seed >> 32) & 0xFF)
                } else {
                    pixels[at] = x < width / 2 ? 255 : 0
                    pixels[at + 1] = 0
                    pixels[at + 2] = x < width / 2 ? 0 : 255
                }
            }
        }
        let provider = try XCTUnwrap(CGDataProvider(data: Data(pixels) as CFData))
        let image = try XCTUnwrap(CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
        ))
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil))
        let properties: [CFString: Any] = [
            kCGImagePropertyOrientation: orientation.rawValue,
            kCGImageDestinationLossyCompressionQuality: 0.95
        ]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    private func decoded(_ base64: String) throws -> UIImage {
        let data = try XCTUnwrap(Data(base64Encoded: base64))
        // The relay wants the bytes of a real JPEG.
        XCTAssertEqual([UInt8](data.prefix(3)), [0xFF, 0xD8, 0xFF])
        return try XCTUnwrap(UIImage(data: data))
    }

    /// The colour in the middle of a quarter of the picture.
    private func colour(of image: UIImage, atX x: Double, y: Double) throws -> (red: CGFloat, blue: CGFloat) {
        let cgImage = try XCTUnwrap(image.cgImage)
        var pixel = [UInt8](repeating: 0, count: 4)
        let context = try XCTUnwrap(CGContext(
            data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        // Draw the picture so that the wanted point lands on the one pixel there is.
        let width = Double(cgImage.width), height = Double(cgImage.height)
        context.draw(cgImage, in: CGRect(x: -x * width, y: -(1 - y) * height, width: width, height: height))
        return (CGFloat(pixel[0]) / 255, CGFloat(pixel[2]) / 255)
    }

    func testAPhotoFromTheLibraryIsScaledDownToAJPEGThatFits() throws {
        let base64 = try XCTUnwrap(jpegBase64ForImageInput(photo(width: 3000, height: 2000)))
        XCTAssertLessThanOrEqual(base64.utf8.count, imageInputMaxBase64Chars)
        let image = try decoded(base64)
        XCTAssertEqual(try XCTUnwrap(image.cgImage).width, 1024)
        XCTAssertEqual(try XCTUnwrap(image.cgImage).height, 683)
        // A small picture is left its size.
        let small = try decoded(try XCTUnwrap(jpegBase64ForImageInput(photo(width: 300, height: 200))))
        XCTAssertEqual(try XCTUnwrap(small.cgImage).width, 300)
        XCTAssertEqual(try XCTUnwrap(small.cgImage).height, 200)
    }

    func testAPhotoTakenWithThePhoneOnItsSideIsTurnedUpright() throws {
        // Stored 2000 wide and 1000 high, red on the left: held so that "right" in the file is the top (EXIF 6).
        let image = try decoded(try XCTUnwrap(jpegBase64ForImageInput(photo(width: 2000, height: 1000, orientation: .right))))
        let cgImage = try XCTUnwrap(image.cgImage)
        XCTAssertEqual(cgImage.width, 512)
        XCTAssertEqual(cgImage.height, 1024)
        // Upright, what was the left of the file is the top of the picture.
        let top = try colour(of: image, atX: 0.5, y: 0.15)
        let bottom = try colour(of: image, atX: 0.5, y: 0.85)
        XCTAssertGreaterThan(top.red, 0.7)
        XCTAssertLessThan(top.blue, 0.3)
        XCTAssertGreaterThan(bottom.blue, 0.7)
        XCTAssertLessThan(bottom.red, 0.3)
    }

    func testAPictureThatDoesNotCompressIsMadeSmallerUntilItFits() throws {
        let base64 = try XCTUnwrap(jpegBase64ForImageInput(photo(width: 1600, height: 1600, noisy: true)))
        XCTAssertLessThanOrEqual(base64.utf8.count, imageInputMaxBase64Chars)
        // At 1024 pixels it is too long at every quality: it went smaller.
        let image = try decoded(base64)
        XCTAssertLessThan(try XCTUnwrap(image.cgImage).width, 1024)
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(image.cgImage).width, 64)
    }

    func testWhatIsSeeThroughIsWhiteNotBlack() throws {
        // A screenshot with nothing behind it: see-through but for a red square in the top left corner.
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let png = UIGraphicsImageRenderer(size: CGSize(width: 200, height: 200), format: format).pngData { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 60, height: 60))
        }
        let image = try decoded(try XCTUnwrap(jpegBase64ForImageInput(png)))
        let empty = try colour(of: image, atX: 0.75, y: 0.75)
        XCTAssertGreaterThan(empty.red, 0.9)
        XCTAssertGreaterThan(empty.blue, 0.9)
        let square = try colour(of: image, atX: 0.1, y: 0.1)
        XCTAssertGreaterThan(square.red, 0.7)
        XCTAssertLessThan(square.blue, 0.3)
    }

    func testWhatIsNoPictureIsRefused() {
        XCTAssertNil(jpegBase64ForImageInput(Data("not a picture".utf8)))
        XCTAssertNil(jpegBase64ForImageInput(Data()))
    }

    // MARK: - what the user is told

    func testTheNoteSaysWhatBecameOfThePicture() {
        XCTAssertEqual(pictureNoteText(nil, hadWords: false, assistantName: "Max"), L("picture.sent", ("name", "Max")))
        // With words the assistant answers at once: nothing more to say.
        XCTAssertNil(pictureNoteText(nil, hadWords: true, assistantName: "Max"))
        XCTAssertEqual(pictureNoteText(.tooFast, hadWords: false, assistantName: "Max"), L("picture.tooFast"))
        XCTAssertEqual(pictureNoteText(.tooMany, hadWords: true, assistantName: "Max"), L("picture.tooMany"))
        XCTAssertEqual(pictureNoteText(.moving, hadWords: false, assistantName: "Max"), L("picture.moving"))
        XCTAssertEqual(pictureNoteText(.unreadable, hadWords: false, assistantName: "Max"), L("picture.unreadable"))
        XCTAssertEqual(pictureNoteText(.notReady, hadWords: false, assistantName: "Max"), L("picture.notReady"))
        for key in ["picture.show", "picture.sending", "picture.sent", "picture.notReady", "picture.moving", "picture.tooFast", "picture.tooMany", "picture.unreadable"] {
            XCTAssertNotEqual(L(key, in: .en), key)
            XCTAssertNotEqual(L(key, in: .zh), key)
        }
    }
}
