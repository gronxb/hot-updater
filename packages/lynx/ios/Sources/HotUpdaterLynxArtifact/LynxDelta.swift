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
            guard values.contains(.url), values.contains(.compression) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .compression,
                    in: values,
                    debugDescription: "Changed file requires explicit url and compression"
                )
            }
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
        public init(algorithm: String = "bsdiff", baseBundleId: String, baseFileHash: String, patchFileHash: String, patchUrl: URL) {
            self.algorithm = algorithm; self.baseBundleId = baseBundleId; self.baseFileHash = baseFileHash
            self.patchFileHash = patchFileHash; self.patchUrl = patchUrl
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
        guard values.contains(.fileHash), values.contains(.file), values.contains(.patch) else {
            throw DecodingError.dataCorruptedError(
                forKey: .fileHash,
                in: values,
                debugDescription: "Changed asset requires explicit file and patch descriptors"
            )
        }
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

enum LynxDelta {
    struct PatchedAsset: Equatable {
        let path: String
        let patchFileHash: String
        let reconstructedFileHash: String
    }

    struct Result {
        let tree: VerifiedLynxTree
        let patchedAssets: [PatchedAsset]
    }

    static func prepare(_ request: LynxArtifactRequest, base: LynxInstalledArtifact, stage: URL,
                        configuration: LynxArtifactConfiguration,
                        fetch: LynxArtifactFetch) async throws -> Result {
        guard let manifestURL = request.manifestUrl, let token = request.manifestFileHash, !token.isEmpty,
              let changes = request.changedAssets else { throw LynxArtifactError.invalid("Incomplete manifest transfer") }
        // Base authority comes from the generation-pinned native selection. Reverify its bytes before reuse.
        let source = try VerifiedLynxTree.verify(at: base.directory, bundleId: base.bundleId, manifestToken: nil,
                                                configuration: .init(runtimeId: configuration.runtimeId),
                                                expectedDigest: base.manifestDigest)
        let contents = stage.appendingPathComponent("contents")
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: false)
        let manifestFile = contents.appendingPathComponent("manifest.json")
        try await fetch(manifestURL, manifestFile, UInt64(ArchiveLimits.manifest), false)
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
            try paths.admit(name, size: 0, directory: false)
            guard LynxArtifactRequest.isHash(asset.fileHash),
                  asset.signature == nil || asset.signature?.isEmpty == false else {
                throw LynxArtifactError.invalid("Invalid target manifest asset")
            }
        }
        let requiredChanges = Set(manifest.assets.compactMap { name, asset in
            source.files[name]?.caseInsensitiveCompare(asset.fileHash) == .orderedSame ? nil : name
        })
        guard Set(changes.keys) == requiredChanges else {
            throw LynxArtifactError.invalid("Changed assets do not exactly cover the target manifest")
        }
        var total = try size(manifestFile)
        var patchedAssets: [PatchedAsset] = []
        for name in manifest.assets.keys.sorted() {
            try Task.checkCancellation()
            let expected = manifest.assets[name]!.fileHash
            let output = contents.appendingPathComponent(name)
            try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
            let sourceFile = base.directory.appendingPathComponent(name)
            let remaining = ArchiveLimits.expanded - total
            let outputLimit = min(remaining, ArchiveLimits.file)
            if source.files[name]?.caseInsensitiveCompare(expected) == .orderedSame,
               HashUtils.verifyHash(fileURL: sourceFile, expectedHash: expected) {
                try copy(sourceFile, to: output, maximumBytes: outputLimit)
            } else {
                guard let change = changes[name], change.fileHash == expected, change.file != nil || change.patch != nil else {
                    throw LynxArtifactError.invalid("Missing or mismatched changed asset: \(name)")
                }
                var patched = false
                var patchEvidence: PatchedAsset?
                if let patch = change.patch, patch.algorithm == "bsdiff", patch.baseBundleId == base.bundleId,
                   source.files[name]?.caseInsensitiveCompare(patch.baseFileHash) == .orderedSame,
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
                }
                if !patched {
                    try? FileManager.default.removeItem(at: output)
                    guard let file = change.file, file.compression == nil || file.compression == "br" else {
                        throw LynxArtifactError.invalid("No usable changed asset fallback: \(name)")
                    }
                    if file.compression == "br" {
                        let compressed = stage.appendingPathComponent("asset-\(UUID().uuidString).br")
                        defer { try? FileManager.default.removeItem(at: compressed) }
                        try await fetch(file.url, compressed, ArchiveLimits.archive, false)
                        try StreamingTarArchiveExtractor.decompressBrotliFile(
                            from: compressed.path,
                            to: output.path,
                            maximumOutputBytes: outputLimit
                        )
                    } else {
                        try await fetch(file.url, output, outputLimit, true)
                    }
                    try ArtifactSignatureVerifier.verifyHash(fileURL: output, expectedHash: expected).get()
                }
                if patched, let patchEvidence { patchedAssets.append(patchEvidence) }
            }
            let bytes = try size(output)
            guard bytes <= outputLimit else { throw LynxArtifactError.invalid("Manifest transfer expansion limit exceeded") }
            total += bytes
        }
        let tree = try VerifiedLynxTree.verify(at: contents, bundleId: request.bundleId, manifestToken: token, configuration: configuration)
        return Result(tree: tree, patchedAssets: patchedAssets.sorted { $0.path < $1.path })
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
