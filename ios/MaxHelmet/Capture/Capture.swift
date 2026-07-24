import Foundation

/// One stored capture. Codable so the whole gallery index round-trips through a
/// single JSON file. `filename`/`thumbnailName` are relative to the Captures
/// folder, so the index survives the container path changing between launches.
struct Capture: Identifiable, Equatable, Codable {
    enum Kind: String, Codable {
        case photo
        case video
    }

    let id: String
    let type: Kind
    let filename: String
    let createdAt: Double
    var durationSec: Double?
    var exported: Bool
    let thumbnailName: String
}
