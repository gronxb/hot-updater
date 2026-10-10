import CryptoKit
import Foundation

/// The same binary trust anchor and namespace serve foreground and background work.
struct LynxNativeScope {
    let home: URL
    let embeddedArtifact: LynxInstalledArtifact
    let builtin: LynxStoredSelection

    init(configuration config: LynxControllerConfiguration) throws {
        guard !config.runtimeId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !config.binaryIdentity.isEmpty, !config.channel.isEmpty, config.channel == config.channel.trimmingCharacters(in: .whitespacesAndNewlines),
              config.channel.utf8.elementsEqual(config.channel.precomposedStringWithCanonicalMapping.utf8),
              config.appVersion.range(of: "^[0-9]+\\.[0-9]+\\.[0-9]+([+-][0-9A-Za-z.-]+)?$", options: .regularExpression) != nil,
              UUID(uuidString: config.embeddedBundleId) != nil, UUID(uuidString: config.minimumBundleId) != nil else {
            throw LynxArtifactError.invalid("Invalid native Lynx controller configuration")
        }
        _ = try LynxCatalogPolicy.normalizedCohort(config.cohort)
        // The binary's embedded digest is its trust anchor; downloaded signatures are a separate policy.
        let embeddedRoot = config.embeddedDirectory.standardizedFileURL.resolvingSymlinksInPath()
        let embedded = try VerifiedLynxTree.verify(at: embeddedRoot, bundleId: config.embeddedBundleId, manifestToken: nil,
            configuration: .init(runtimeId: config.runtimeId), expectedDigest: config.embeddedManifestDigest)
        let embeddedArtifactValue = LynxInstalledArtifact(
            bundleId: config.embeddedBundleId,
            directory: embeddedRoot,
            entry: embedded.entry,
            backgroundEntry: embedded.backgroundEntry,
            hasManagedPageMetadata: embedded.hasManagedPageMetadata,
            pageEntries: embedded.pageEntries,
            pageEssentialResources: embedded.pageEssentialResources,
            manifestDigest: embedded.digest,
            files: embedded.files
        )
        embeddedArtifact = embeddedArtifactValue
        guard let embeddedMainResources = embeddedArtifactValue.essentialResources(
            for: embedded.entry
        ),
        config.startupResourcePaths.isEmpty || config.startupResourcePaths
            .isSubset(of: Set(embedded.hasManagedPageMetadata
                ? embeddedMainResources
                : Array(embedded.files.keys))) else {
            throw LynxArtifactError.invalid(
                "Native startup resources must be declared by the embedded page"
            )
        }
        let builtinPolicy = LynxPolicyReceipt(kind: "BUILTIN", releaseId: nil, bundleId: config.embeddedBundleId,
            catalogId: nil, scopeKey: nil, generation: nil, catalogHash: nil, channel: config.channel, selectionContextHash: nil)
        builtin = try LynxStoredSelection(builtinPolicy, manifestDigest: embedded.digest)
        let scope = Self.hash(try JSONSerialization.data(withJSONObject: [config.binaryIdentity, config.runtimeId,
            config.embeddedBundleId, embedded.digest, config.appVersion, config.channel,
            config.minimumBundleId, Self.hash(Data((config.publicKeyPEM ?? "unsigned").utf8))]))
        home = config.root.appendingPathComponent(scope).standardizedFileURL.resolvingSymlinksInPath()
    }

    private static func hash(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
}
