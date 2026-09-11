// Private G1 verified local artifact. Archive/signature/catalog integration follows G1.
import CryptoKit
import Foundation

enum SpikeAdmissionError: Error, LocalizedError {
    case invalid(String)
    case incompatible(String)
    var errorDescription: String? {
        switch self { case .invalid(let message), .incompatible(let message): return message }
    }
}

private struct SpikeMetadata: Decodable {
    let schemaVersion: Int
    let bundleId: String
    let entry: String
    let platform: String
    let runtimeId: String
}

struct SpikeArtifact {
    static let runtimeId = "sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-spike-v2"
    let selection: [String: String]
    let root: URL
    let entry: String
    let files: [String: String]
    let requiredResources: Set<String>

    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func validPath(_ name: String) -> Bool {
        let parts = name.split(separator: "/", omittingEmptySubsequences: false)
        return !name.isEmpty && !name.hasPrefix("/") && !name.contains("\\") && !name.contains(":")
            && parts.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }

    static func readSelection(_ file: URL) throws -> [String: String] {
        guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: String] else {
            throw SpikeAdmissionError.invalid("Invalid native selection receipt")
        }
        return value
    }

    static func validate(_ selection: [String: String], home: URL) throws -> SpikeArtifact {
        guard let release = selection["release"], validPath(release),
              let entry = selection["entry"], validPath(entry),
              let bundleId = selection["bundleId"], UUID(uuidString: bundleId) != nil,
              let releaseId = selection["releaseId"], UUID(uuidString: releaseId) != nil,
              let manifestHash = selection["manifestFileHash"] else { throw SpikeAdmissionError.invalid("Missing native selection identity") }
        if let mode = selection["artifactStore"] {
            let installed = try ArtifactProbe.installer(mode, home: home).inspectInstalled(bundleId: bundleId, expectedManifestDigest: manifestHash)
            guard installed.entry == entry else { throw SpikeAdmissionError.invalid("Installed entry receipt mismatch") }
            let required = try JSONDecoder().decode([String].self, from: Data((selection["requiredResources"] ?? "[]").utf8))
            guard required.allSatisfy({ installed.files[$0] != nil }) else { throw SpikeAdmissionError.invalid("Installed required resource missing") }
            return SpikeArtifact(selection: selection, root: installed.directory, entry: entry, files: installed.files, requiredResources: Set(required))
        }
        let base = selection["embedded"] == "true" ? Bundle.main.resourceURL!.appendingPathComponent("Embedded") : home.appendingPathComponent("releases")
        let root = base.appendingPathComponent(release)
        let bytes = try Data(contentsOf: root.appendingPathComponent("manifest.json"))
        guard hash(bytes) == manifestHash,
              let manifest = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              manifest["bundleId"] as? String == bundleId,
              let assets = manifest["assets"] as? [String: [String: String]],
              assets["hot-updater-lynx.json"] != nil, assets[entry] != nil else { throw SpikeAdmissionError.invalid("Manifest mismatch") }
        var files: [String: String] = [:]
        for (name, item) in assets {
            guard validPath(name), let digest = item["fileHash"] else { throw SpikeAdmissionError.invalid("Invalid manifest path") }
            let file = root.appendingPathComponent(name)
            guard file.resolvingSymlinksInPath().path == file.path,
                  hash(try Data(contentsOf: file)) == digest else { throw SpikeAdmissionError.invalid("Managed file integrity mismatch: \(name)") }
            files[name] = digest
        }
        guard !(try Data(contentsOf: root.appendingPathComponent(entry))).isEmpty else { throw SpikeAdmissionError.invalid("Empty entry") }
        let metadataBytes = try Data(contentsOf: root.appendingPathComponent("hot-updater-lynx.json"))
        let metadata = try JSONDecoder().decode(SpikeMetadata.self, from: metadataBytes)
        guard metadata.schemaVersion == 1, metadata.bundleId == bundleId, metadata.entry == entry else {
            throw SpikeAdmissionError.invalid("Invalid Lynx metadata")
        }
        guard metadata.platform == "ios", metadata.runtimeId == runtimeId else {
            throw SpikeAdmissionError.incompatible("Lynx native compatibility identity mismatch")
        }
        let required = try JSONDecoder().decode([String].self, from: Data((selection["requiredResources"] ?? "[]").utf8))
        guard required.allSatisfy({ files[$0] != nil }) else { throw SpikeAdmissionError.invalid("Required startup resource is not manifest-covered") }
        return SpikeArtifact(selection: selection, root: root, entry: entry, files: files, requiredResources: Set(required))
    }
}
