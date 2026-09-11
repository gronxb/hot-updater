import CryptoKit
import Darwin
import Foundation

public struct LynxArtifactConfiguration {
    public let platform = "ios"
    public let runtimeId: String
    public let publicKeyPEM: String?
    public init(runtimeId: String, publicKeyPEM: String? = nil) {
        self.runtimeId = runtimeId
        self.publicKeyPEM = publicKeyPEM
    }
}

/// An internal trusted artifact request, not a catalog authorization.
public struct LynxArtifactRequest: Codable, Equatable {
    public let bundleId: String
    public let fileUrl: URL
    public let fileHash: String
    public let manifestFileHash: String?
    public init(bundleId: String, fileUrl: URL, fileHash: String, manifestFileHash: String? = nil) {
        self.bundleId = bundleId
        self.fileUrl = fileUrl
        self.fileHash = fileHash
        self.manifestFileHash = manifestFileHash
    }
}

public enum LynxArtifactError: Error, LocalizedError {
    case invalid(String)
    case incompatible
    case storeBusy
    case stalePreparation
    case authorizationRequired
    case immutableConflict
    public var errorDescription: String? {
        switch self {
        case .invalid(let message): return message
        case .incompatible: return "INCOMPATIBLE: Lynx platform or runtime identity mismatch"
        case .storeBusy: return "An artifact installer already owns this store"
        case .stalePreparation: return "Unknown, discarded or consumed preparation"
        case .authorizationRequired: return "Native finalization did not authorize publication"
        case .immutableConflict: return "Bundle ID already has different immutable bytes"
        }
    }
}

public struct LynxInstalledArtifact {
    public let bundleId: String
    public let directory: URL
    public let entry: String
    public let manifestDigest: String
    public let files: [String: String]
}

public final class LynxPreparedArtifact {
    public let id = UUID().uuidString
    public let bundleId: String
    public let entry: String
    fileprivate let request: LynxArtifactRequest
    fileprivate let stage: URL
    let tree: VerifiedLynxTree
    fileprivate init(request: LynxArtifactRequest, stage: URL, tree: VerifiedLynxTree) {
        self.request = request; self.stage = stage; self.tree = tree
        bundleId = request.bundleId; entry = tree.entry
    }
}

private struct LynxMetadata: Decodable {
    let schemaVersion: Int
    let bundleId: String
    let platform: String
    let runtimeId: String
    let entry: String
}
private struct LynxManifest: Decodable {
    struct Asset: Decodable { let fileHash: String; let signature: String? }
    let bundleId: String
    let assets: [String: Asset]
}

struct VerifiedLynxTree {
    let entry: String
    let digest: String
    let files: [String: String]
    static func verify(at root: URL, bundleId: String, manifestToken: String?, configuration: LynxArtifactConfiguration, expectedDigest: String? = nil) throws -> Self {
        let manifestURL = root.appendingPathComponent("manifest.json")
        guard manifestURL.resolvingSymlinksInPath() == manifestURL else { throw LynxArtifactError.invalid("Manifest link rejected") }
        if let token = manifestToken {
            // A supplied token preserves configured signing policy. Null relies on the verified archive.
            try ArtifactSignatureVerifier.verifyBundle(fileURL: manifestURL, fileHash: token, publicKeyPEM: configuration.publicKeyPEM).get()
        }
        let manifestBytes = try StrictMetadataJSON.read(manifestURL, limit: 16 * 1024 * 1024)
        let digest = SHA256.hash(data: manifestBytes).map { String(format: "%02x", $0) }.joined()
        if let expectedDigest, expectedDigest != digest { throw LynxArtifactError.invalid("Manifest changed after preparation") }
        let manifest = try JSONDecoder().decode(LynxManifest.self, from: manifestBytes)
        guard manifest.bundleId == bundleId, manifest.assets["hot-updater-lynx.json"] != nil,
              manifest.assets["manifest.json"] == nil, !manifest.assets.isEmpty else { throw LynxArtifactError.invalid("Manifest identity or coverage mismatch") }
        let paths = ArchiveEntryGuard()
        var files: [String: String] = [:]
        for (name, asset) in manifest.assets {
            try paths.admit(name, size: 0, directory: false)
            let file = root.appendingPathComponent(name)
            let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true,
                  file.resolvingSymlinksInPath() == file else { throw LynxArtifactError.invalid("Managed file integrity mismatch: \(name)") }
            try ArtifactSignatureVerifier.verifyHash(fileURL: file, expectedHash: asset.fileHash).get()
            if configuration.publicKeyPEM != nil {
                guard let signature = asset.signature, !signature.isEmpty else { throw SignatureVerificationError.invalidSignatureFormat }
                try ArtifactSignatureVerifier.verifyHashSignature(fileHash: asset.fileHash, signatureBase64: signature, publicKeyPEM: configuration.publicKeyPEM).get()
            }
            guard let actualHash = HashUtils.calculateSHA256(fileURL: file) else { throw LynxArtifactError.invalid("Cannot hash managed file") }
            files[name] = actualHash
        }
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey]) else { throw LynxArtifactError.invalid("Cannot inspect extracted tree") }
        for case let file as URL in enumerator {
            let values = try file.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey])
            guard values.isSymbolicLink != true else { throw LynxArtifactError.invalid("Extracted symbolic link rejected") }
            if values.isDirectory == true { continue }
            let rootPath = root.resolvingSymlinksInPath().path
            let filePath = file.resolvingSymlinksInPath().path
            guard filePath.hasPrefix(rootPath + "/") else { throw LynxArtifactError.invalid("Extracted file outside root") }
            let name = String(filePath.dropFirst(rootPath.count + 1))
            guard values.isRegularFile == true, name == "manifest.json" || files[name] != nil else { throw LynxArtifactError.invalid("Unlisted extracted file: \(name)") }
        }
        let metadata = try JSONDecoder().decode(LynxMetadata.self, from: StrictMetadataJSON.read(root.appendingPathComponent("hot-updater-lynx.json"), limit: 16 * 1024))
        guard metadata.schemaVersion == 1, metadata.bundleId == bundleId,
              files[metadata.entry] != nil, ArchiveExtractionUtilities.normalizedRelativePath(from: metadata.entry) == metadata.entry,
              let size = try root.appendingPathComponent(metadata.entry).resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0 else { throw LynxArtifactError.invalid("Lynx metadata/entry mismatch") }
        guard metadata.platform == configuration.platform, metadata.runtimeId == configuration.runtimeId else { throw LynxArtifactError.incompatible }
        return Self(entry: metadata.entry, digest: digest, files: files)
    }
}

/// Own one instance per native store. Concurrent preparations have isolated staging directories.
public final class LynxArtifactInstaller {
    public let root: URL
    private let configuration: LynxArtifactConfiguration
    private let ownerLock: Int32
    private let mutex = NSLock()
    private var prepared: [String: LynxPreparedArtifact] = [:]

    public init(root: URL, configuration: LynxArtifactConfiguration) throws {
        guard !configuration.runtimeId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw LynxArtifactError.invalid("Native runtime identity must not be blank") }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        self.root = root.standardizedFileURL.resolvingSymlinksInPath()
        self.configuration = configuration
        ownerLock = Darwin.open(self.root.appendingPathComponent(".owner.lock").path, O_CREAT | O_RDWR, 0o600)
        guard ownerLock >= 0 else { throw LynxArtifactError.invalid("Cannot open artifact store lock") }
        guard flock(ownerLock, LOCK_EX | LOCK_NB) == 0 else { Darwin.close(ownerLock); throw LynxArtifactError.storeBusy }
        // The process lease excludes other live owners. A crash releases it, making orphan cleanup safe.
        do {
            let staging = self.root.appendingPathComponent(".staging")
            if FileManager.default.fileExists(atPath: staging.path) { try FileManager.default.removeItem(at: staging) }
            try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: self.root.appendingPathComponent("bundles"), withIntermediateDirectories: true)
            try syncDirectory(self.root)
            try syncDirectory(self.root.deletingLastPathComponent())
        } catch { flock(ownerLock, LOCK_UN); Darwin.close(ownerLock); throw error }
    }
    deinit { flock(ownerLock, LOCK_UN); Darwin.close(ownerLock) }

    public func prepare(_ request: LynxArtifactRequest) async throws -> LynxPreparedArtifact {
        guard UUID(uuidString: request.bundleId) != nil,
              request.bundleId == request.bundleId.lowercased(),
              ["https", "http"].contains(request.fileUrl.scheme ?? ""), request.fileUrl.host != nil,
              !request.fileHash.isEmpty else { throw LynxArtifactError.invalid("Invalid artifact request") }
        let stage = root.appendingPathComponent(".staging/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: false)
        var retained = false
        defer { if !retained { try? FileManager.default.removeItem(at: stage) } }
        let archive = stage.appendingPathComponent("archive")
        try await ArtifactDownload.fetch(request.fileUrl, to: archive)
        try Task.checkCancellation()
        try ArtifactSignatureVerifier.verifyBundle(fileURL: archive, fileHash: request.fileHash, publicKeyPEM: configuration.publicKeyPEM).get()
        let contents = stage.appendingPathComponent("contents")
        try StrictArchive.extract(archive, to: contents)
        let tree = try VerifiedLynxTree.verify(at: contents, bundleId: request.bundleId, manifestToken: request.manifestFileHash, configuration: configuration)
        try Task.checkCancellation()
        let token = LynxPreparedArtifact(request: request, stage: stage, tree: tree)
        retain(token)
        retained = true
        return token
    }

    private func retain(_ token: LynxPreparedArtifact) {
        mutex.lock(); defer { mutex.unlock() }; prepared[token.id] = token
    }

    /// The digest must come from the native receipt committed with this artifact, not from JavaScript.
    public func inspectInstalled(bundleId: String, expectedManifestDigest: String) throws -> LynxInstalledArtifact {
        guard UUID(uuidString: bundleId) != nil else { throw LynxArtifactError.invalid("Invalid Bundle ID") }
        let directory = root.appendingPathComponent("bundles/\(bundleId)")
        let tree = try VerifiedLynxTree.verify(at: directory, bundleId: bundleId, manifestToken: nil, configuration: configuration, expectedDigest: expectedManifestDigest)
        return LynxInstalledArtifact(bundleId: bundleId, directory: directory, entry: tree.entry, manifestDigest: tree.digest, files: tree.files)
    }

    public func discard(_ token: LynxPreparedArtifact) throws {
        mutex.lock(); defer { mutex.unlock() }
        guard prepared[token.id] === token else { throw LynxArtifactError.stalePreparation }
        prepared.removeValue(forKey: token.id)
        try FileManager.default.removeItem(at: token.stage)
    }

    /// The trusted host must hold its authorization/state lock while invoking publish and recording next selection.
    /// This seam does not itself authenticate a catalog or mutate active/next selection.
    public func commit(_ token: LynxPreparedArtifact, finalize: (_ publish: () throws -> LynxInstalledArtifact) throws -> Void) throws -> LynxInstalledArtifact {
        var result: LynxInstalledArtifact?
        try finalize {
            guard result == nil else { throw LynxArtifactError.stalePreparation }
            let installed = try self.publish(token)
            result = installed
            return installed
        }
        guard let result else { throw LynxArtifactError.authorizationRequired }
        return result
    }

    private func publish(_ token: LynxPreparedArtifact) throws -> LynxInstalledArtifact {
        mutex.lock(); defer { mutex.unlock() }
        guard prepared[token.id] === token else { throw LynxArtifactError.stalePreparation }
        let contents = token.stage.appendingPathComponent("contents")
        let tree = try VerifiedLynxTree.verify(at: contents, bundleId: token.bundleId, manifestToken: token.request.manifestFileHash, configuration: configuration, expectedDigest: token.tree.digest)
        let destination = root.appendingPathComponent("bundles/\(token.bundleId)")
        if FileManager.default.fileExists(atPath: destination.path) {
            guard let current = try? VerifiedLynxTree.verify(at: destination, bundleId: token.bundleId, manifestToken: token.request.manifestFileHash, configuration: configuration, expectedDigest: tree.digest), current.files == tree.files else { throw LynxArtifactError.immutableConflict }
        } else {
            for name in Array(tree.files.keys) + ["manifest.json"] {
                let handle = try FileHandle(forWritingTo: contents.appendingPathComponent(name))
                try handle.synchronize(); try handle.close()
            }
            if let directories = FileManager.default.enumerator(at: contents, includingPropertiesForKeys: [.isDirectoryKey]) {
                var pending: [URL] = []
                for case let file as URL in directories where try file.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true { pending.append(file) }
                for directory in pending.sorted(by: { $0.path.count > $1.path.count }) { try syncDirectory(directory) }
            }
            try syncDirectory(contents)
            // No overwrite even if an unexpected writer creates the destination during publication.
            guard renamex_np(contents.path, destination.path, UInt32(RENAME_EXCL)) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            try syncDirectory(destination.deletingLastPathComponent())
        }
        prepared.removeValue(forKey: token.id)
        try? FileManager.default.removeItem(at: token.stage)
        return LynxInstalledArtifact(bundleId: token.bundleId, directory: destination, entry: tree.entry, manifestDigest: tree.digest, files: tree.files)
    }
    // Called under the controller authority lock. Active preparation tokens add their own leases.
    func pruneInstalled(keeping protected: Set<String>) throws -> Set<String> {
        mutex.lock(); defer { mutex.unlock() }
        let retained = protected.union(prepared.values.map(\.bundleId))
        let directory = root.appendingPathComponent("bundles")
        var removed: Set<String> = []
        for entry in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]) {
            guard UUID(uuidString: entry.lastPathComponent) != nil else { throw LynxArtifactError.invalid("Unexpected artifact store entry") }
            if retained.contains(entry.lastPathComponent) { continue }
            try FileManager.default.removeItem(at: entry)
            removed.insert(entry.lastPathComponent)
        }
        if !removed.isEmpty { try syncDirectory(directory) }
        return removed
    }

    private func syncDirectory(_ directory: URL) throws {
        let descriptor = Darwin.open(directory.path, O_RDONLY)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { Darwin.close(descriptor) }
        guard fsync(descriptor) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }
}
