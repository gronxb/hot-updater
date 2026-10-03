import CryptoKit
import Darwin
import Foundation
import os.log

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
    public let artifactProtocolVersion: Int
    public let bundleId: String
    public let manifestUrl: URL?
    public let manifestFileHash: String?
    public let archiveUrl: URL?
    public let assets: [String: LynxChangedAsset]?
    public init(bundleId: String, manifestUrl: URL? = nil, manifestFileHash: String? = nil,
                assets: [String: LynxChangedAsset]? = nil, archiveUrl: URL? = nil,
                artifactProtocolVersion: Int = 1) {
        self.bundleId = bundleId
        self.manifestFileHash = manifestFileHash
        self.manifestUrl = manifestUrl
        self.assets = assets
        self.archiveUrl = archiveUrl
        self.artifactProtocolVersion = artifactProtocolVersion
    }

    func validate() throws {
        guard artifactProtocolVersion == 1,
              bundleId.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil,
              let manifestUrl, let manifestFileHash, Self.isIntegrityToken(manifestFileHash),
              let assets, !assets.isEmpty else {
            throw LynxArtifactError.invalid("Incomplete manifest-v1 artifact request")
        }
        try Self.validateRemoteURL(manifestUrl)
        if let archiveUrl { try Self.validateRemoteURL(archiveUrl) }
        let paths = ArchiveEntryGuard(reservingManifest: true)
        for (path, asset) in assets {
            try paths.admit(path, size: 0, directory: false)
            guard path != "manifest.json", Self.isHash(asset.fileHash),
                  asset.file != nil else {
                throw LynxArtifactError.invalid("Invalid changed asset descriptor")
            }
            if let file = asset.file {
                try Self.validateRemoteURL(file.url)
                guard file.compression == nil || file.compression == "br" else {
                    throw LynxArtifactError.invalid("Unsupported changed asset compression")
                }
            }
            if let patch = asset.patch {
                try Self.validateRemoteURL(patch.patchUrl)
                guard patch.algorithm == "bsdiff", UUID(uuidString: patch.baseBundleId) != nil,
                      patch.baseBundleId == patch.baseBundleId.lowercased(),
                      Self.isHash(patch.baseFileHash), Self.isHash(patch.patchFileHash),
                      patch.byteSize.map({ $0 > 0 && $0 <= ArchiveLimits.file }) ?? true else {
                    throw LynxArtifactError.invalid("Invalid patch descriptor")
                }
            }
        }
    }

    private static func validateRemoteURL(_ url: URL) throws {
        guard ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
              url.host?.isEmpty == false, url.user == nil, url.password == nil,
              url.port.map({ (1...65_535).contains($0) }) ?? true else {
            throw LynxArtifactError.invalid("Unsupported artifact URL")
        }
    }

    static func isHash(_ value: String) -> Bool {
        value.range(of: "^[0-9a-fA-F]{64}$", options: .regularExpression) != nil
    }

    private static func isIntegrityToken(_ value: String) -> Bool {
        if isHash(value) { return true }
        guard value.hasPrefix("sig:"), value.count > 4 else { return false }
        let encoded = String(value.dropFirst(4))
        return encoded.count.isMultiple(of: 4) && Data(base64Encoded: encoded) != nil
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

public struct LynxPageEssentialResources: Equatable {
    public let entry: String
    public let resources: [String]

    public init(entry: String, resources: [String]) {
        self.entry = entry
        self.resources = resources
    }
}

public struct LynxInstalledArtifact {
    public let bundleId: String
    public let directory: URL
    public let entry: String
    public let hasManagedPageMetadata: Bool
    public let pageEntries: [String]
    public let pageEssentialResources: [LynxPageEssentialResources]
    public let manifestDigest: String
    public let files: [String: String]

    public init(
        bundleId: String,
        directory: URL,
        entry: String,
        hasManagedPageMetadata: Bool = false,
        pageEntries: [String]? = nil,
        pageEssentialResources: [LynxPageEssentialResources]? = nil,
        manifestDigest: String,
        files: [String: String]
    ) {
        self.bundleId = bundleId
        self.directory = directory
        self.entry = entry
        self.hasManagedPageMetadata = hasManagedPageMetadata
        self.pageEntries = pageEntries ?? [entry]
        self.pageEssentialResources = pageEssentialResources ?? [
            .init(entry: entry, resources: [entry]),
        ]
        self.manifestDigest = manifestDigest
        self.files = files
    }

    public func essentialResources(for pageEntry: String) -> [String]? {
        pageEssentialResources.first { $0.entry == pageEntry }?.resources
    }
}

public final class LynxPreparedArtifact {
    public let id = UUID().uuidString
    public let bundleId: String
    public let entry: String
    fileprivate let request: LynxArtifactRequest
    fileprivate let stage: URL
    let tree: VerifiedLynxTree
    let delivery: LynxArtifactDelivery
    private let leaseLock = NSLock()
    private var stageLease: Int32
    fileprivate init(request: LynxArtifactRequest, stage: URL, tree: VerifiedLynxTree,
                     delivery: LynxArtifactDelivery, stageLease: Int32) {
        self.request = request; self.stage = stage; self.tree = tree
        self.delivery = delivery
        self.stageLease = stageLease
        bundleId = request.bundleId; entry = tree.entry
    }

    fileprivate func closeStageLease() {
        leaseLock.lock(); defer { leaseLock.unlock() }
        guard stageLease >= 0 else { return }
        flock(stageLease, LOCK_UN)
        Darwin.close(stageLease)
        stageLease = -1
    }

    deinit { closeStageLease() }
}

enum LynxArtifactDelivery {
    case archive(baseBundleId: String?, releaseId: String?)
    case manifest(
        baseBundleId: String,
        releaseId: String?,
        patchedAssets: [LynxDelta.PatchedAsset]
    )
}

enum LynxInstallEvent {
    static func json(
        event: String,
        transactionId: String,
        bundleId: String,
        releaseId: String?,
        baseBundleId: String,
        patchedAsset: LynxDelta.PatchedAsset? = nil
    ) -> String {
        var object: [String: Any] = [
            "schemaVersion": 1,
            "event": event,
            "transactionId": transactionId,
            "bundleId": bundleId,
            "releaseId": releaseId ?? NSNull(),
            "baseBundleId": baseBundleId,
        ]
        if let patchedAsset {
            object["asset"] = patchedAsset.path
            object["patchFileHash"] = patchedAsset.patchFileHash
            object["reconstructedFileHash"] = patchedAsset.reconstructedFileHash
        }
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let value = String(data: data, encoding: .utf8) else {
            preconditionFailure("Install event contains non-JSON values")
        }
        return value
    }
}

typealias LynxArtifactFetch = @Sendable (
    _ source: URL,
    _ destination: URL,
    _ maximumBytes: UInt64,
    _ allowEmpty: Bool
) async throws -> Void

private struct LynxMetadata: Decodable {
    let schemaVersion: Int
    let bundleId: String
    let platform: String
    let runtimeId: String
    let entry: String
}
struct LynxManifest: Decodable {
    struct Asset: Decodable {
        let fileHash: String
        let signature: String?
        let byteSize: UInt64?
        let downloadByteSize: UInt64?
        let downloadFileHash: String?
        let downloadCompression: String?
    }
    struct Archive: Decodable {
        let downloadFileHash: String
        let downloadByteSize: UInt64
        let tarByteSize: UInt64
    }
    let bundleId: String
    let assets: [String: Asset]
    let archive: Archive?
}

struct VerifiedLynxTree {
    let entry: String
    let hasManagedPageMetadata: Bool
    let pageEntries: [String]
    let pageEssentialResources: [LynxPageEssentialResources]
    let digest: String
    let files: [String: String]
    static func verify(at root: URL, bundleId: String, manifestToken: String?, configuration: LynxArtifactConfiguration, expectedDigest: String? = nil) throws -> Self {
        let manifestURL = root.appendingPathComponent("manifest.json")
        guard manifestURL.resolvingSymlinksInPath() == manifestURL else { throw LynxArtifactError.invalid("Manifest link rejected") }
        let manifestBytes = try StrictMetadataJSON.read(manifestURL, limit: ArchiveLimits.manifest)
        if let token = manifestToken {
            // A supplied token preserves configured signing policy. Null relies on the verified archive.
            try ArtifactSignatureVerifier.verifyBundle(fileURL: manifestURL, fileHash: token, publicKeyPEM: configuration.publicKeyPEM).get()
        }
        let digest = SHA256.hash(data: manifestBytes).map { String(format: "%02x", $0) }.joined()
        if let expectedDigest, expectedDigest != digest { throw LynxArtifactError.invalid("Manifest changed after preparation") }
        let manifest = try JSONDecoder().decode(LynxManifest.self, from: manifestBytes)
        guard manifest.bundleId == bundleId, manifest.assets["hot-updater-lynx.json"] != nil,
              manifest.assets["manifest.json"] == nil, !manifest.assets.isEmpty else { throw LynxArtifactError.invalid("Manifest identity or coverage mismatch") }
        let paths = ArchiveEntryGuard(
            reservingManifest: true,
            manifestSize: UInt64(manifestBytes.count)
        )
        var files: [String: String] = [:]
        for (name, asset) in manifest.assets {
            let file = root.appendingPathComponent(name)
            let values = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true,
                  let fileSize = values.fileSize, fileSize >= 0,
                  file.resolvingSymlinksInPath() == file else { throw LynxArtifactError.invalid("Managed file integrity mismatch: \(name)") }
            try paths.admit(name, size: UInt64(fileSize), directory: false)
            guard asset.byteSize == nil || asset.byteSize == UInt64(fileSize) else { throw LynxArtifactError.invalid("Managed asset size mismatch") }
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
        let metadata = try validateMetadata(at: root, bundleId: bundleId, files: files,
                                            configuration: configuration, verifyPageFiles: true)
        let pages = metadata.pages
        return Self(
            entry: metadata.entry,
            hasManagedPageMetadata: pages.isPresent,
            pageEntries: pages.entries,
            pageEssentialResources: pages.essentialResources,
            digest: digest,
            files: files
        )
    }

    static func validateMetadata(at root: URL, bundleId: String, files: [String: String],
                                 configuration: LynxArtifactConfiguration,
                                 verifyPageFiles: Bool) throws -> (entry: String, pages: LynxPageMetadata.Parsed) {
        let metadataBytes = try StrictMetadataJSON.read(
            root.appendingPathComponent("hot-updater-lynx.json"),
            limit: 16 * 1024
        )
        let metadata = try JSONDecoder().decode(
            LynxMetadata.self,
            from: metadataBytes
        )
        guard metadata.schemaVersion == 1, metadata.bundleId == bundleId,
              files[metadata.entry] != nil, ArchiveExtractionUtilities.normalizedRelativePath(from: metadata.entry) == metadata.entry else { throw LynxArtifactError.invalid("Lynx metadata/entry mismatch") }
        guard metadata.platform == configuration.platform, metadata.runtimeId == configuration.runtimeId else { throw LynxArtifactError.incompatible }
        let pages = try LynxPageMetadata.parse(
            metadataBytes,
            mainEntry: metadata.entry,
            files: files,
            root: verifyPageFiles ? root : nil
        )
        return (metadata.entry, pages)
    }

}

enum LynxPageMetadata {
    struct Parsed {
        let isPresent: Bool
        let entries: [String]
        let essentialResources: [LynxPageEssentialResources]
    }

    private static let pageEntryPattern =
        "^(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?/)*" +
        "[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\\.lynx\\.bundle$"

    static func parse(
        _ bytes: Data,
        mainEntry: String,
        files: [String: String],
        root: URL?
    ) throws -> Parsed {
        guard let object = try JSONSerialization.jsonObject(with: bytes)
            as? [String: Any] else {
            throw LynxArtifactError.invalid("Invalid Lynx metadata object")
        }
        let hasEntries = object.keys.contains("pageEntries")
        let hasResources = object.keys.contains("pageEssentialResources")
        guard hasEntries == hasResources else {
            throw LynxArtifactError.invalid(
                "pageEntries and pageEssentialResources must appear together"
            )
        }
        guard hasEntries else {
            try validatePageEntry(mainEntry, files: files, root: root)
            return Parsed(
                isPresent: false,
                entries: [mainEntry],
                essentialResources: [
                    .init(entry: mainEntry, resources: [mainEntry]),
                ]
            )
        }
        guard let rawEntries = object["pageEntries"] as? [Any],
              !rawEntries.isEmpty,
              rawEntries.allSatisfy({ $0 is String }) else {
            throw LynxArtifactError.invalid("Invalid pageEntries metadata")
        }
        let entries = rawEntries.map { $0 as! String }
        guard !entries.contains(where: \.isEmpty),
              Set(entries).count == entries.count,
              entries.filter({ $0 == mainEntry }).count == 1 else {
            throw LynxArtifactError.invalid("Invalid pageEntries membership")
        }
        var collisionKeys = Set<String>()
        for entry in entries {
            try validatePageEntry(entry, files: files, root: root)
            guard collisionKeys.insert(ArchiveEntryGuard.portableKey(entry))
                .inserted else {
                throw LynxArtifactError.invalid("Colliding pageEntries metadata")
            }
        }
        guard entries == entries.sorted(by: utf16Precedes) else {
            throw LynxArtifactError.invalid("pageEntries metadata is not sorted")
        }

        guard let rawDescriptors = object["pageEssentialResources"] as? [Any],
              rawDescriptors.count == entries.count,
              !rawDescriptors.isEmpty else {
            throw LynxArtifactError.invalid(
                "Invalid pageEssentialResources metadata"
            )
        }
        var descriptors: [LynxPageEssentialResources] = []
        for (index, rawDescriptor) in rawDescriptors.enumerated() {
            guard let descriptor = rawDescriptor as? [String: Any],
                  Set(descriptor.keys) == Set(["entry", "resources"]),
                  let entry = descriptor["entry"] as? String,
                  entry == entries[index],
                  let rawResources = descriptor["resources"] as? [Any],
                  !rawResources.isEmpty,
                  rawResources.allSatisfy({ $0 is String }) else {
                throw LynxArtifactError.invalid(
                    "Invalid pageEssentialResources descriptor"
                )
            }
            let resources = rawResources.map { $0 as! String }
            guard !resources.contains(where: \.isEmpty),
                  Set(resources).count == resources.count,
                  resources.contains(entry),
                  resources == resources.sorted(by: utf16Precedes) else {
                throw LynxArtifactError.invalid(
                    "Invalid page essential resource list"
                )
            }
            var resourceCollisionKeys = Set<String>()
            for resource in resources {
                guard ArchiveExtractionUtilities.normalizedRelativePath(
                    from: resource
                ) == resource,
                files[resource] != nil,
                resourceCollisionKeys.insert(
                    ArchiveEntryGuard.portableKey(resource)
                ).inserted else {
                    throw LynxArtifactError.invalid(
                        "Unsafe, colliding or unverified page resource"
                    )
                }
            }
            descriptors.append(.init(entry: entry, resources: resources))
        }
        return Parsed(
            isPresent: true,
            entries: entries,
            essentialResources: descriptors
        )
    }

    private static func validatePageEntry(
        _ entry: String,
        files: [String: String],
        root: URL?
    ) throws {
        guard ArchiveExtractionUtilities.normalizedRelativePath(from: entry)
                == entry,
              entry.range(of: pageEntryPattern, options: .regularExpression)
                != nil,
              files[entry] != nil else {
            throw LynxArtifactError.invalid("Invalid managed page entry")
        }
        if let root {
            guard let size = try root.appendingPathComponent(entry)
                .resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0 else {
                throw LynxArtifactError.invalid("Invalid managed page entry")
            }
        }
    }

    private static func utf16Precedes(_ lhs: String, _ rhs: String) -> Bool {
        lhs.utf16.lexicographicallyPrecedes(rhs.utf16)
    }
}

/// Own one instance per native store. Concurrent preparations have isolated staging directories.
public final class LynxArtifactInstaller {
    public let root: URL
    private let configuration: LynxArtifactConfiguration
    private var ownerLock: Int32
    private let fetch: LynxArtifactFetch
    private let mutex = NSLock()
    private var prepared: [String: LynxPreparedArtifact] = [:]
    private var metadataCache: LynxArtifactMetadata?

    public convenience init(root: URL, configuration: LynxArtifactConfiguration) throws {
        try self.init(root: root, configuration: configuration) { source, destination, maximumBytes, allowEmpty in
            try await ArtifactDownload.fetch(
                source,
                to: destination,
                maximumBytes: maximumBytes,
                allowEmpty: allowEmpty
            )
        }
    }

    init(root: URL, configuration: LynxArtifactConfiguration,
         fetch: @escaping LynxArtifactFetch) throws {
        guard !configuration.runtimeId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw LynxArtifactError.invalid("Native runtime identity must not be blank") }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        self.root = root.standardizedFileURL.resolvingSymlinksInPath()
        self.configuration = configuration
        self.fetch = fetch
        ownerLock = Darwin.open(self.root.appendingPathComponent(".owner.lock").path, O_CREAT | O_RDWR, 0o600)
        guard ownerLock >= 0 else { throw LynxArtifactError.invalid("Cannot open artifact store lock") }
        guard flock(ownerLock, LOCK_EX | LOCK_NB) == 0 else { Darwin.close(ownerLock); throw LynxArtifactError.storeBusy }
        // The store lease serializes live owners. Per-preparation leases keep work
        // started by a retiring generation safe while its replacement opens the store.
        do {
            let staging = self.root.appendingPathComponent(".staging")
            try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
            try reclaimAbandonedPreparations(in: staging)
            try FileManager.default.createDirectory(at: self.root.appendingPathComponent("bundles"), withIntermediateDirectories: true)
            try syncDirectory(self.root)
            try syncDirectory(self.root.deletingLastPathComponent())
        } catch { flock(ownerLock, LOCK_UN); Darwin.close(ownerLock); throw error }
    }
    deinit { close() }

    func close() {
        mutex.lock(); defer { mutex.unlock() }
        guard ownerLock >= 0 else { return }
        flock(ownerLock, LOCK_UN)
        Darwin.close(ownerLock)
        ownerLock = -1
        metadataCache = nil
    }

    public func prepare(_ request: LynxArtifactRequest, base: LynxInstalledArtifact? = nil) async throws -> LynxPreparedArtifact {
        try await prepare(request, base: base, releaseId: nil)
    }

    func prepare(_ request: LynxArtifactRequest, base: LynxInstalledArtifact?,
                 releaseId: String?) async throws -> LynxPreparedArtifact {
        try request.validate()
        let (stage, stageLease) = try createStage()
        var retained = false
        defer {
            if !retained {
                try? FileManager.default.removeItem(at: stage)
                flock(stageLease, LOCK_UN)
                Darwin.close(stageLease)
            }
        }
        let result = try await LynxDelta.prepare(request, base: base, stage: stage,
                                                 configuration: configuration, fetch: fetch, metadata: cachedMetadata())
        let assembled = result.tree
        let delivery: LynxArtifactDelivery = result.usedArchive
            ? .archive(baseBundleId: base?.bundleId, releaseId: releaseId)
            : .manifest(baseBundleId: base?.bundleId ?? "none", releaseId: releaseId, patchedAssets: result.patchedAssets)
        try Task.checkCancellation()
        let token = LynxPreparedArtifact(
            request: request,
            stage: stage,
            tree: assembled,
            delivery: delivery,
            stageLease: stageLease
        )
        retain(token)
        retained = true
        return token
    }

    /// Authenticates bounded metadata without retaining a preparation or installing files.
    func validateMetadata(_ request: LynxArtifactRequest) async throws -> Set<String> {
        try request.validate()
        let (stage, lease) = try createStage()
        defer {
            try? FileManager.default.removeItem(at: stage)
            flock(lease, LOCK_UN)
            Darwin.close(lease)
        }
        let metadata = try await LynxDelta.validateMetadata(
            request, stage: stage, configuration: configuration, fetch: fetch,
            metadata: cachedMetadata()
        )
        try Task.checkCancellation()
        try cacheMetadata(metadata)
        return metadata.paths
    }

    private func cachedMetadata() -> LynxArtifactMetadata? {
        mutex.lock(); defer { mutex.unlock() }
        return metadataCache
    }

    private func cacheMetadata(_ metadata: LynxArtifactMetadata) throws {
        mutex.lock(); defer { mutex.unlock() }
        guard ownerLock >= 0 else { throw LynxArtifactError.stalePreparation }
        metadataCache = metadata
    }

    private func createStage() throws -> (URL, Int32) {
        mutex.lock(); defer { mutex.unlock() }
        guard ownerLock >= 0 else { throw LynxArtifactError.stalePreparation }
        let stage = root.appendingPathComponent(".staging/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: false)
        let lease = Darwin.open(stage.appendingPathComponent(".lease").path, O_CREAT | O_EXCL | O_RDWR, 0o600)
        guard lease >= 0, flock(lease, LOCK_EX | LOCK_NB) == 0 else {
            if lease >= 0 { Darwin.close(lease) }
            try? FileManager.default.removeItem(at: stage)
            throw LynxArtifactError.invalid("Cannot acquire preparation lease")
        }
        return (stage, lease)
    }

    private func retain(_ token: LynxPreparedArtifact) {
        mutex.lock(); defer { mutex.unlock() }; prepared[token.id] = token
    }

    /// The digest must come from the native receipt committed with this artifact, not from JavaScript.
    public func inspectInstalled(bundleId: String, expectedManifestDigest: String) throws -> LynxInstalledArtifact {
        guard UUID(uuidString: bundleId) != nil else { throw LynxArtifactError.invalid("Invalid Bundle ID") }
        let directory = root.appendingPathComponent("bundles/\(bundleId)")
        let tree = try VerifiedLynxTree.verify(at: directory, bundleId: bundleId, manifestToken: nil, configuration: configuration, expectedDigest: expectedManifestDigest)
        return LynxInstalledArtifact(
            bundleId: bundleId,
            directory: directory,
            entry: tree.entry,
            hasManagedPageMetadata: tree.hasManagedPageMetadata,
            pageEntries: tree.pageEntries,
            pageEssentialResources: tree.pageEssentialResources,
            manifestDigest: tree.digest,
            files: tree.files
        )
    }

    public func discard(_ token: LynxPreparedArtifact) throws {
        mutex.lock(); defer { mutex.unlock() }
        guard prepared[token.id] === token else { throw LynxArtifactError.stalePreparation }
        prepared.removeValue(forKey: token.id)
        defer { token.closeStageLease() }
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
        logPublished(token)
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
        token.closeStageLease()
        return LynxInstalledArtifact(
            bundleId: token.bundleId,
            directory: destination,
            entry: tree.entry,
            hasManagedPageMetadata: tree.hasManagedPageMetadata,
            pageEntries: tree.pageEntries,
            pageEssentialResources: tree.pageEssentialResources,
            manifestDigest: tree.digest,
            files: tree.files
        )
    }

    private func logPublished(_ token: LynxPreparedArtifact) {
        switch token.delivery {
        case .archive(let baseBundleId, let releaseId):
            let event = LynxInstallEvent.json(event: "HotUpdaterArchiveInstalled",
                transactionId: token.id, bundleId: token.bundleId, releaseId: releaseId,
                baseBundleId: baseBundleId ?? "none")
            os_log("%{public}@", "HotUpdaterArchiveInstalled bundleId=\(token.bundleId) HotUpdaterLynxEvent=\(event)")
        case .manifest(let baseBundleId, let releaseId, let patchedAssets):
            for asset in patchedAssets {
                let event = LynxInstallEvent.json(
                    event: "HotUpdaterBsdiffPatchApplied",
                    transactionId: token.id,
                    bundleId: token.bundleId,
                    releaseId: releaseId,
                    baseBundleId: baseBundleId,
                    patchedAsset: asset
                )
                os_log(
                    "%{public}@",
                    "HotUpdaterBsdiffPatchApplied asset=\(asset.path) baseBundleId=\(baseBundleId) bundleId=\(token.bundleId) HotUpdaterLynxEvent=\(event)"
                )
            }
            let event = LynxInstallEvent.json(
                event: "HotUpdaterManifestDiffApplied",
                transactionId: token.id,
                bundleId: token.bundleId,
                releaseId: releaseId,
                baseBundleId: baseBundleId
            )
            os_log(
                "%{public}@",
                "HotUpdaterManifestDiffApplied bundleId=\(token.bundleId) baseBundleId=\(baseBundleId) HotUpdaterLynxEvent=\(event)"
            )
        }
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

    private func reclaimAbandonedPreparations(in staging: URL) throws {
        for entry in try FileManager.default.contentsOfDirectory(
            at: staging,
            includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]
        ) {
            let values = try entry.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else {
                try FileManager.default.removeItem(at: entry)
                continue
            }
            let lease = Darwin.open(entry.appendingPathComponent(".lease").path, O_RDWR)
            guard lease >= 0 else {
                try FileManager.default.removeItem(at: entry)
                continue
            }
            if flock(lease, LOCK_EX | LOCK_NB) == 0 {
                defer {
                    flock(lease, LOCK_UN)
                    Darwin.close(lease)
                }
                try FileManager.default.removeItem(at: entry)
            } else if errno == EWOULDBLOCK {
                Darwin.close(lease)
            } else {
                let error = POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                Darwin.close(lease)
                throw error
            }
        }
    }
}
