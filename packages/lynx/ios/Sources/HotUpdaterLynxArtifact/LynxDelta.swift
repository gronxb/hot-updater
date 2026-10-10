import Foundation

@_silgen_name("HotUpdaterLynxApplyBsdiffPatch")
private func applyBsdiff(_ patch: NSString, _ base: NSString, _ output: NSString, _ maximumOutputBytes: UInt64) -> ObjCBool

enum LynxBsdiffPatch {
    static func apply(patch: URL, base: URL, output: URL,
                      maximumOutputBytes: UInt64) -> Bool {
        applyBsdiff(
            patch.path as NSString,
            base.path as NSString,
            output.path as NSString,
            maximumOutputBytes
        ).boolValue
    }
}

public struct LynxChangedAsset: Codable, Equatable {
    public struct File: Codable, Equatable {
        public let url: URL
        public let compression: String?
        public init(url: URL, compression: String? = nil) { self.url = url; self.compression = compression }

        private enum CodingKeys: String, CodingKey { case url, compression }
        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            url = try values.decode(URL.self, forKey: .url)
            compression = try values.decodeIfPresent(String.self, forKey: .compression)
        }
        public func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(url, forKey: .url)
            if let compression { try values.encode(compression, forKey: .compression) }
            else { try values.encodeNil(forKey: .compression) }
        }
    }
    public struct Patch: Codable, Equatable {
        public let algorithm: String
        public let baseBundleId: String
        public let baseFileHash: String
        public let patchFileHash: String
        public let patchUrl: URL
        public let byteSize: UInt64?
        public init(algorithm: String = "bsdiff", baseBundleId: String, baseFileHash: String, patchFileHash: String, patchUrl: URL, byteSize: UInt64? = nil) {
            self.algorithm = algorithm; self.baseBundleId = baseBundleId; self.baseFileHash = baseFileHash
            self.patchFileHash = patchFileHash; self.patchUrl = patchUrl; self.byteSize = byteSize
        }
    }
    public let fileHash: String
    public let file: File?
    public let patch: Patch?
    public init(fileHash: String, file: File? = nil, patch: Patch? = nil) {
        self.fileHash = fileHash; self.file = file; self.patch = patch
    }

    private enum CodingKeys: String, CodingKey { case fileHash, file, patch }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        fileHash = try values.decode(String.self, forKey: .fileHash)
        file = try values.decodeIfPresent(File.self, forKey: .file)
        patch = try values.decodeIfPresent(Patch.self, forKey: .patch)
    }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(fileHash, forKey: .fileHash)
        if let file { try values.encode(file, forKey: .file) }
        else { try values.encodeNil(forKey: .file) }
        if let patch { try values.encode(patch, forKey: .patch) }
        else { try values.encodeNil(forKey: .patch) }
    }
}

/// Verified metadata bytes are bounded and confer no selection authority.
struct LynxArtifactMetadata {
    let bundleId: String
    let manifestFileHash: String?
    let manifest: Data
    let sidecar: Data
    let paths: Set<String>

    func matches(_ request: LynxArtifactRequest) -> Bool {
        request.bundleId == bundleId && request.manifestFileHash == manifestFileHash
    }
}

enum LynxDelta {
    struct PatchedAsset: Equatable {
        let path: String
        let patchFileHash: String
        let reconstructedFileHash: String
    }

    struct Result {
        let tree: VerifiedLynxTree
        let patchedAssets: [PatchedAsset]
        let usedArchive: Bool
        let patchFallback: Bool
    }

    static func prepare(_ request: LynxArtifactRequest, base: LynxInstalledArtifact?, stage: URL,
                        configuration: LynxArtifactConfiguration,
                        fetch: LynxArtifactFetch, metadata: LynxArtifactMetadata? = nil) async throws -> Result {
        guard let token = request.manifestFileHash, !token.isEmpty,
              let changes = request.assets else { throw LynxArtifactError.invalid("Incomplete manifest transfer") }
        // Base authority comes from native state; corrupt local bytes use authenticated originals.
        let source = base.flatMap { base in
            try? VerifiedLynxTree.verify(at: base.directory, bundleId: base.bundleId, manifestToken: nil,
                                        configuration: .init(runtimeId: configuration.runtimeId),
                                        expectedDigest: base.manifestDigest)
        }
        try Task.checkCancellation()
        let contents = stage.appendingPathComponent("contents")
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: false)
        let cached = metadata.flatMap { $0.matches(request) ? $0 : nil }
        let manifestFile = contents.appendingPathComponent("manifest.json")
        let manifest = try await readManifest(request, contents: contents, configuration: configuration,
                                              fetch: fetch, metadata: cached)
        let missing = manifest.assets.keys.filter { !(cached != nil && $0 == "hot-updater-lynx.json") && source?.files[$0]?.caseInsensitiveCompare(manifest.assets[$0]!.fileHash) != .orderedSame }
        let costs: [UInt64?] = missing.map { name in
            let original = manifest.assets[name]!.downloadByteSize
            guard let patch = changes[name]?.patch, patch.baseBundleId == base?.bundleId,
                  source?.files[name]?.caseInsensitiveCompare(patch.baseFileHash) == .orderedSame else { return original }
            return patch.byteSize.map { min($0, original ?? $0) }
        }
        if let archive = manifest.archive, let url = request.archiveUrl, missing.count >= 2,
           manifest.assets.values.allSatisfy({ $0.byteSize != nil }),
           costs.allSatisfy({ $0 != nil }), archive.downloadByteSize > 0,
           archive.downloadByteSize <= ArchiveLimits.archive, archive.tarByteSize > 0,
           archive.tarByteSize <= ArchiveLimits.tarStream, LynxArtifactRequest.isHash(archive.downloadFileHash),
           archive.downloadByteSize <= costs.compactMap({ $0 }).reduce(0, +) {
            let archiveFile = stage.appendingPathComponent("bundle.tar.br")
            let archiveContents = stage.appendingPathComponent("archive-contents")
            defer { try? FileManager.default.removeItem(at: archiveFile); try? FileManager.default.removeItem(at: archiveContents) }
            do {
                try await fetch(url, archiveFile, archive.downloadByteSize, false)
                guard try size(archiveFile) == archive.downloadByteSize else { throw LynxArtifactError.invalid("Archive transfer size mismatch") }
                try ArtifactSignatureVerifier.verifyHash(fileURL: archiveFile, expectedHash: archive.downloadFileHash).get()
                try StrictArchive.extract(archiveFile, to: archiveContents, expectedTarBytes: archive.tarByteSize,
                    expectedFiles: manifest.assets.mapValues { $0.byteSize! })
                guard !FileManager.default.fileExists(atPath: archiveContents.appendingPathComponent("manifest.json").path) else { throw LynxArtifactError.invalid("Bulk archive contains a manifest") }
                try FileManager.default.copyItem(at: manifestFile, to: archiveContents.appendingPathComponent("manifest.json"))
                _ = try VerifiedLynxTree.verify(at: archiveContents, bundleId: request.bundleId, manifestToken: token, configuration: configuration)
                for name in manifest.assets.keys {
                    try Task.checkCancellation()
                    let target = contents.appendingPathComponent(name)
                    try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try FileManager.default.moveItem(at: archiveContents.appendingPathComponent(name), to: target)
                }
                let tree = try VerifiedLynxTree.verify(at: contents, bundleId: request.bundleId, manifestToken: token, configuration: configuration)
                return Result(tree: tree, patchedAssets: [], usedArchive: true, patchFallback: false)
            } catch {
                try Task.checkCancellation()
                for name in manifest.assets.keys { try? FileManager.default.removeItem(at: contents.appendingPathComponent(name)) }
                NSLog("HotUpdaterArchiveDownloadFallback bundleId=%@", request.bundleId)
            }
        }
        var total = try size(manifestFile)
        var patchedAssets: [PatchedAsset] = []
        var patchFallback = false
        for name in manifest.assets.keys.sorted() {
            try Task.checkCancellation()
            let expected = manifest.assets[name]!.fileHash
            let output = contents.appendingPathComponent(name)
            try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
            let sourceFile = base?.directory.appendingPathComponent(name)
            let remaining = ArchiveLimits.expanded - total
            let outputLimit = min(remaining, ArchiveLimits.file)
            if let cached, name == "hot-updater-lynx.json" {
                try cached.sidecar.write(to: output)
            } else if let sourceFile, source?.files[name]?.caseInsensitiveCompare(expected) == .orderedSame,
               HashUtils.verifyHash(fileURL: sourceFile, expectedHash: expected) {
                try copy(sourceFile, to: output, maximumBytes: outputLimit)
            } else {
                guard let change = changes[name], change.fileHash == expected, change.file != nil || change.patch != nil else {
                    throw LynxArtifactError.invalid("Missing or mismatched changed asset: \(name)")
                }
                var patched = false
                var patchEvidence: PatchedAsset?
                if let sourceFile, let patch = change.patch, patch.algorithm == "bsdiff", patch.baseBundleId == base?.bundleId,
                   source?.files[name]?.caseInsensitiveCompare(patch.baseFileHash) == .orderedSame,
                   HashUtils.verifyHash(fileURL: sourceFile, expectedHash: patch.baseFileHash) {
                    let patchFile = stage.appendingPathComponent("patch-\(UUID().uuidString)")
                    defer { try? FileManager.default.removeItem(at: patchFile) }
                    do {
                        try await fetch(patch.patchUrl, patchFile, ArchiveLimits.archive, false)
                        try ArtifactSignatureVerifier.verifyHash(fileURL: patchFile, expectedHash: patch.patchFileHash).get()
                        guard let observedPatchHash = HashUtils.calculateSHA256(fileURL: patchFile) else {
                            throw LynxArtifactError.invalid("Cannot hash downloaded patch")
                        }
                        try Task.checkCancellation()
                        if LynxBsdiffPatch.apply(
                            patch: patchFile,
                            base: sourceFile,
                            output: output,
                            maximumOutputBytes: outputLimit
                        ), let reconstructedHash = HashUtils.calculateSHA256(fileURL: output),
                           reconstructedHash.caseInsensitiveCompare(expected) == .orderedSame {
                            patched = true
                            patchEvidence = .init(
                                path: name,
                                patchFileHash: observedPatchHash,
                                reconstructedFileHash: reconstructedHash
                            )
                        }
                        try Task.checkCancellation()
                    } catch { try Task.checkCancellation() }
                    if !patched { patchFallback = true }
                }
                if !patched {
                    try? FileManager.default.removeItem(at: output)
                    guard let file = change.file, file.compression == nil || file.compression == "br" else {
                        throw LynxArtifactError.invalid("No usable changed asset fallback: \(name)")
                    }
                    if file.compression == "br" {
                        let compressed = stage.appendingPathComponent("asset-\(UUID().uuidString).br")
                        defer { try? FileManager.default.removeItem(at: compressed) }
                        try await fetch(file.url, compressed, ArchiveLimits.file, false)
                        try verifyTransfer(compressed, asset: manifest.assets[name]!)
                        try StreamingTarArchiveExtractor.decompressBrotliFile(
                            from: compressed.path,
                            to: output.path,
                            maximumOutputBytes: outputLimit
                        )
                    } else {
                        try await fetch(file.url, output, outputLimit, true)
                        try verifyTransfer(output, asset: manifest.assets[name]!)
                    }
                    try ArtifactSignatureVerifier.verifyHash(fileURL: output, expectedHash: expected).get()
                }
                if patched, let patchEvidence { patchedAssets.append(patchEvidence) }
            }
            let bytes = try size(output)
            guard bytes <= outputLimit, manifest.assets[name]!.byteSize.map({ $0 == bytes }) ?? true else { throw LynxArtifactError.invalid("Manifest transfer expansion limit exceeded") }
            total += bytes
        }
        let tree = try VerifiedLynxTree.verify(at: contents, bundleId: request.bundleId, manifestToken: token, configuration: configuration)
        return Result(tree: tree, patchedAssets: patchedAssets.sorted { $0.path < $1.path }, usedArchive: false, patchFallback: patchFallback)
    }

    private static func readManifest(_ request: LynxArtifactRequest, contents: URL,
                                     configuration: LynxArtifactConfiguration,
                                     fetch: LynxArtifactFetch, metadata: LynxArtifactMetadata?) async throws -> LynxManifest {
        guard let manifestURL = request.manifestUrl, let token = request.manifestFileHash, !token.isEmpty,
              let changes = request.assets else { throw LynxArtifactError.invalid("Incomplete manifest transfer") }
        let manifestFile = contents.appendingPathComponent("manifest.json")
        if let metadata, metadata.matches(request) {
            try metadata.manifest.write(to: manifestFile)
        } else {
            try await fetch(manifestURL, manifestFile, UInt64(ArchiveLimits.manifest), false)
        }
        try ArtifactSignatureVerifier.verifyBundle(fileURL: manifestFile, fileHash: token, publicKeyPEM: configuration.publicKeyPEM).get()
        let manifest = try JSONDecoder().decode(
            LynxManifest.self,
            from: StrictMetadataJSON.read(manifestFile, limit: ArchiveLimits.manifest)
        )
        guard manifest.bundleId == request.bundleId, manifest.assets["hot-updater-lynx.json"] != nil,
              manifest.assets["manifest.json"] == nil, !manifest.assets.isEmpty else {
            throw LynxArtifactError.invalid("Manifest transfer identity or coverage mismatch")
        }
        let paths = ArchiveEntryGuard(reservingManifest: true)
        for (name, asset) in manifest.assets {
            try paths.admit(name, size: asset.byteSize ?? 0, directory: false)
            guard LynxArtifactRequest.isHash(asset.fileHash),
                  asset.signature == nil || asset.signature?.isEmpty == false else {
                throw LynxArtifactError.invalid("Invalid target manifest asset")
            }
        }
        guard Set(changes.keys) == Set(manifest.assets.keys) else {
            throw LynxArtifactError.invalid("Target descriptors do not exactly cover the manifest")
        }
        for (name, asset) in manifest.assets {
            guard changes[name]?.fileHash.caseInsensitiveCompare(asset.fileHash) == .orderedSame,
                  changes[name]?.file?.compression == asset.downloadCompression,
                  asset.downloadCompression == nil || asset.downloadCompression == "br",
                  asset.byteSize.map({ $0 <= ArchiveLimits.file }) ?? true,
                  asset.downloadByteSize.map({ $0 <= ArchiveLimits.file }) ?? true,
                  asset.downloadFileHash.map(LynxArtifactRequest.isHash) ?? true else {
                throw LynxArtifactError.invalid("Target descriptor or transfer metadata differs from manifest")
            }
        }
        return manifest
    }

    static func validateMetadata(_ request: LynxArtifactRequest, stage: URL,
                                 configuration: LynxArtifactConfiguration,
                                 fetch: LynxArtifactFetch, metadata: LynxArtifactMetadata?) async throws -> LynxArtifactMetadata {
        let contents = stage.appendingPathComponent("contents")
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: false)
        let cached = metadata.flatMap { $0.matches(request) ? $0 : nil }
        let manifest = try await readManifest(request, contents: contents, configuration: configuration,
                                              fetch: fetch, metadata: cached)
        let name = "hot-updater-lynx.json"
        let output = contents.appendingPathComponent(name)
        let asset = manifest.assets[name]!
        if let cached {
            try cached.sidecar.write(to: output)
        } else {
            guard let descriptor = request.assets?[name]?.file else { throw LynxArtifactError.invalid("Missing Lynx metadata descriptor") }
            if descriptor.compression == "br" {
                let compressed = stage.appendingPathComponent("metadata.br")
                try await fetch(descriptor.url, compressed, UInt64(ArchiveLimits.manifest), false)
                try verifyTransfer(compressed, asset: asset)
                try StreamingTarArchiveExtractor.decompressBrotliFile(from: compressed.path, to: output.path,
                                                                     maximumOutputBytes: 16 * 1024)
            } else {
                try await fetch(descriptor.url, output, 16 * 1024, false)
                try verifyTransfer(output, asset: asset)
            }
        }
        let bytes = try size(output)
        guard bytes <= 16 * 1024, asset.byteSize.map({ $0 == bytes }) ?? true else { throw LynxArtifactError.invalid("Lynx metadata size mismatch") }
        try ArtifactSignatureVerifier.verifyHash(fileURL: output, expectedHash: asset.fileHash).get()
        if configuration.publicKeyPEM != nil {
            guard let signature = asset.signature, !signature.isEmpty else { throw SignatureVerificationError.invalidSignatureFormat }
            try ArtifactSignatureVerifier.verifyHashSignature(fileHash: asset.fileHash, signatureBase64: signature,
                                                            publicKeyPEM: configuration.publicKeyPEM).get()
        }
        _ = try VerifiedLynxTree.validateMetadata(at: contents, bundleId: request.bundleId,
                                                 files: manifest.assets.mapValues(\.fileHash),
                                                 configuration: configuration, verifyPageFiles: false)
        return LynxArtifactMetadata(bundleId: request.bundleId, manifestFileHash: request.manifestFileHash,
                                    manifest: try Data(contentsOf: contents.appendingPathComponent("manifest.json")),
                                    sidecar: try Data(contentsOf: output), paths: Set(manifest.assets.keys))
    }

    private static func verifyTransfer(_ file: URL, asset: LynxManifest.Asset) throws {
        if let expected = asset.downloadByteSize, try size(file) != expected { throw LynxArtifactError.invalid("Asset transfer size mismatch") }
        if let hash = asset.downloadFileHash { try ArtifactSignatureVerifier.verifyHash(fileURL: file, expectedHash: hash).get() }
    }

    private static func size(_ file: URL) throws -> UInt64 {
        UInt64(try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
    }

    private static func copy(_ source: URL, to destination: URL, maximumBytes: UInt64) throws {
        guard try size(source) <= maximumBytes else { throw LynxArtifactError.invalid("Reused file exceeds manifest transfer limit") }
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        guard FileManager.default.createFile(atPath: destination.path, contents: nil) else { throw LynxArtifactError.invalid("Cannot create reused asset") }
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }
        while let data = try input.read(upToCount: 64 * 1024), !data.isEmpty {
            try ArchiveLimits.checkOutput(output, adding: data.count, maximumBytes: maximumBytes)
            try output.write(contentsOf: data)
        }
    }
}
