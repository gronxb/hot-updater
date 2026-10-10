import CryptoKit
import Foundation

/// Copies a single script so execution holds no installed-file or controller authority.
enum LynxBackgroundScript {
    static let maximumBytes = 16 * 1024 * 1024

    static func entry(metadata: Data, files: [String: String], root: URL?) throws -> String? {
        let object = try JSONSerialization.jsonObject(with: metadata) as? [String: Any]
        guard let value = object?["backgroundEntry"] else { return nil }
        guard let entry = value as? String,
              entry.range(of: "^(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?/)*[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\\.js$", options: .regularExpression) != nil,
              ArchiveExtractionUtilities.normalizedRelativePath(from: entry) == entry,
              files[entry] != nil else {
            throw LynxArtifactError.invalid("Invalid Lynx background entry")
        }
        if let root { _ = try read(root: root, entry: entry) }
        return entry
    }

    static func read(root: URL, entry: String, expectedHash: String? = nil) throws -> String {
        let file = root.appendingPathComponent(entry)
        let values = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
        guard file.resolvingSymlinksInPath() == file,
              values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, (1...maximumBytes).contains(size) else {
            throw LynxArtifactError.invalid("Lynx background script size/type limit exceeded")
        }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        let bytes = try handle.read(upToCount: maximumBytes + 1) ?? Data()
        guard !bytes.isEmpty, bytes.count <= maximumBytes, !bytes.contains(0),
              let source = String(data: bytes, encoding: .utf8) else {
            throw LynxArtifactError.invalid("Invalid Lynx background script bytes")
        }
        if let expectedHash {
            let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            guard digest == expectedHash else {
                throw LynxArtifactError.invalid("Lynx background script changed after verification")
            }
        }
        return source
    }
}
