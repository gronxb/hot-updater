import Foundation

/// The native bootstrap preflight must accept the same sidecar versions as the artifact reader.
struct SparklingEmbeddedMetadata: Decodable {
    let schemaVersion: Int
    let bundleId: String
    let platform: String
    let runtimeId: String

    func isCompatible(runtimeId: String, bundleId: String) -> Bool {
        (schemaVersion == 1 || schemaVersion == 2) && self.runtimeId == runtimeId
            && platform == "ios" && self.bundleId == bundleId
    }
}
