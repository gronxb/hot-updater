import CryptoKit
import Foundation

/// Supply these values from the native binary/host, never downloaded JavaScript.
public struct LynxControllerConfiguration {
    public let root: URL
    public let runtimeId: String
    public let binaryIdentity: String
    public let embeddedDirectory: URL
    public let embeddedBundleId: String
    public let embeddedManifestDigest: String
    public let minimumBundleId: String
    public let appVersion: String
    public let channel: String
    public let cohort: String
    public let publicKeyPEM: String?
    public let startupResourcePaths: Set<String>
    public init(root: URL, runtimeId: String, binaryIdentity: String, embeddedDirectory: URL,
                embeddedBundleId: String, embeddedManifestDigest: String, minimumBundleId: String,
                appVersion: String, channel: String, cohort: String, publicKeyPEM: String? = nil, startupResourcePaths: Set<String> = []) {
        self.root = root; self.runtimeId = runtimeId; self.binaryIdentity = binaryIdentity
        self.embeddedDirectory = embeddedDirectory; self.embeddedBundleId = embeddedBundleId
        self.embeddedManifestDigest = embeddedManifestDigest; self.minimumBundleId = minimumBundleId
        self.appVersion = appVersion; self.channel = channel; self.cohort = cohort; self.publicKeyPEM = publicKeyPEM
        self.startupResourcePaths = startupResourcePaths
    }
}

/// Native object identity is the authority; its identifier is diagnostic only.
public final class LynxLaunchContext {
    public let id = UUID().uuidString
    public let primary: Bool
    fileprivate var active = true
    fileprivate var started = false
    fileprivate let owner: UUID
    fileprivate init(primary: Bool, owner: UUID) { self.primary = primary; self.owner = owner }
}

private struct LynxSelectionPreparation {
    let guardValue: LynxPolicyGuard
    let receipt: LynxPolicyReceipt
    let artifact: LynxPreparedArtifact?
    let digest: String
    let context: LynxLaunchContext
}

/// One controller owns one process launch and one native storage/scope lease.
public final class LynxController {
    public let configuration: LynxControllerConfiguration
    public let runningArtifact: LynxInstalledArtifact
    public let runningSelection: LynxPolicyReceipt
    public let attemptId = UUID().uuidString
    private let identity = UUID()
    private let lock = NSRecursiveLock()
    private let installer: LynxArtifactInstaller
    private let journal: LynxControllerJournal
    private let builtin: LynxStoredSelection
    private let running: LynxStoredSelection
    private var state: LynxControllerState
    private var primary: LynxLaunchContext?
    private var contexts: [ObjectIdentifier: LynxLaunchContext] = [:]
    private var runningConfirmed = false
    private var loadedStartupResources: Set<String> = []
    private var contentObserved = false
    private var fatal = false
    private var preparations: [String: LynxSelectionPreparation] = [:]
    private var inFlight = 0
    private var inFlightBundles: [String: Int] = [:]
    private var readyCallbacks: [(Result<String, Error>) -> Void] = []
    private var readyRequested = false

    public init(configuration config: LynxControllerConfiguration) throws {
        guard !config.runtimeId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !config.binaryIdentity.isEmpty, !config.channel.isEmpty, config.channel == config.channel.trimmingCharacters(in: .whitespacesAndNewlines),
              config.channel.utf8.elementsEqual(config.channel.precomposedStringWithCanonicalMapping.utf8),
              config.appVersion.range(of: "^[0-9]+\\.[0-9]+\\.[0-9]+([+-][0-9A-Za-z.-]+)?$", options: .regularExpression) != nil,
              UUID(uuidString: config.embeddedBundleId) != nil, UUID(uuidString: config.minimumBundleId) != nil else {
            throw LynxArtifactError.invalid("Invalid native Lynx controller configuration")
        }
        configuration = config
        let profile = LynxArtifactConfiguration(runtimeId: config.runtimeId, publicKeyPEM: config.publicKeyPEM)
        // The binary's embedded digest is its trust anchor; downloaded signatures are a separate policy.
        let embeddedRoot = config.embeddedDirectory.standardizedFileURL.resolvingSymlinksInPath()
        let embedded = try VerifiedLynxTree.verify(at: embeddedRoot, bundleId: config.embeddedBundleId, manifestToken: nil,
            configuration: .init(runtimeId: config.runtimeId), expectedDigest: config.embeddedManifestDigest)
        guard config.startupResourcePaths.isSubset(of: Set(embedded.files.keys)) else { throw LynxArtifactError.invalid("Native required startup resource is missing from embedded artifact") }
        let builtinPolicy = LynxPolicyReceipt(kind: "BUILTIN", releaseId: nil, bundleId: config.embeddedBundleId,
            catalogId: nil, scopeKey: nil, generation: nil, catalogHash: nil, channel: config.channel, selectionContextHash: nil)
        builtin = try LynxStoredSelection(builtinPolicy, manifestDigest: embedded.digest)
        let scope = Self.hash(try JSONSerialization.data(withJSONObject: [config.binaryIdentity, config.runtimeId,
            config.embeddedBundleId, embedded.digest, config.appVersion, config.channel,
            config.minimumBundleId, Self.hash(Data((config.publicKeyPEM ?? "unsigned").utf8))]))
        let home = config.root.appendingPathComponent(scope)
        installer = try LynxArtifactInstaller(root: home, configuration: profile)
        journal = LynxControllerJournal(file: home.appendingPathComponent("state.json"))
        var recovered = try journal.load()
        if let pending = recovered.pending {
            let receipt = try pending.selection.policy
            if let releaseId = receipt.releaseId, !recovered.unconfirmedReleaseIds.contains(releaseId) {
                guard recovered.unconfirmedReleaseIds.count < 128 else { throw LynxArtifactError.invalid("Missing reserved startup recovery capacity") }
                recovered.unconfirmedReleaseIds.append(releaseId)
            }
            recovered.pending = nil
            recovered.revision = UUID().uuidString
            try journal.save(recovered)
        }
        if recovered.selectionCohort != config.cohort {
            recovered.selectionCohort = config.cohort
            recovered.revision = UUID().uuidString
            try journal.save(recovered)
        }
        let nativeSnapshot = { (base: LynxPolicyReceipt) in
            LynxPolicySnapshot(revision: recovered.revision, platform: "ios", appVersion: config.appVersion,
                channel: config.channel, embeddedBundleId: config.embeddedBundleId, minimumBundleId: config.minimumBundleId,
                cohort: config.cohort, runningSelection: base, nextSelection: nil,
                crashedBundleIds: recovered.crashedBundleIds, unconfirmedReleaseIds: recovered.unconfirmedReleaseIds)
        }
        var selected: (LynxStoredSelection, LynxInstalledArtifact)?
        for candidate in [recovered.next, recovered.confirmed].compactMap({ $0 }) {
            guard let receipt = try? candidate.policy else { continue }
            let snapshot = nativeSnapshot(receipt)
            guard Self.storedEligible(candidate, state: recovered, snapshot: snapshot),
                  try (recovered.unconfirmedReleaseIds.count < 128 || Self.sameIdentity(receipt, recovered.confirmed?.policy)) else { continue }
            let tree: LynxInstalledArtifact?
            if receipt.bundleId == config.embeddedBundleId {
                tree = .init(bundleId: config.embeddedBundleId, directory: embeddedRoot, entry: embedded.entry, manifestDigest: embedded.digest, files: embedded.files)
            } else {
                tree = try? installer.inspectInstalled(bundleId: receipt.bundleId, expectedManifestDigest: candidate.manifestDigest)
            }
            if let tree, config.startupResourcePaths.isSubset(of: Set(tree.files.keys)) { selected = (candidate, tree); break }
        }
        if let selected {
            running = selected.0; runningArtifact = selected.1; runningSelection = try selected.0.policy
        } else {
            running = builtin; runningSelection = builtinPolicy
            runningArtifact = .init(bundleId: config.embeddedBundleId, directory: embeddedRoot, entry: embedded.entry, manifestDigest: embedded.digest, files: embedded.files)
        }
        // A rejected staged selection is not retained as the policy base. Preserve only an eligible selected receipt.
        if recovered.next != nil, !Self.sameIdentity(try recovered.next?.policy, runningSelection) {
            recovered.next = nil; recovered.revision = UUID().uuidString
            try journal.save(recovered)
        }
        state = recovered
        runningConfirmed = Self.sameIdentity(runningSelection, try recovered.confirmed?.policy)
        try? cleanupUnusedArtifacts()
    }

    private static func hash(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    private static func key(_ catalogId: String, _ scope: String) -> String { hash(Data((catalogId + "\u{0}" + scope).utf8)) }
    private static func sameIdentity(_ a: LynxPolicyReceipt?, _ b: LynxPolicyReceipt?) -> Bool {
        guard let a, let b else { return false }
        return a.kind == b.kind && a.bundleId == b.bundleId && a.releaseId == b.releaseId && a.channel == b.channel
    }
    private static func storedEligible(_ stored: LynxStoredSelection, state: LynxControllerState, snapshot: LynxPolicySnapshot) -> Bool {
        guard let receipt = try? stored.policy else { return false }
        if receipt.kind == "BUILTIN", receipt.catalogId == nil { return receipt.bundleId == snapshot.embeddedBundleId && receipt.channel == snapshot.channel }
        guard let catalogId = receipt.catalogId, let scope = receipt.scopeKey else { return false }
        let key = key(catalogId, scope)
        guard let bytes = state.catalogs[key], let catalog = try? LynxCatalogPolicy.parseCatalog(json: bytes, snapshot: snapshot) else { return false }
        return (try? LynxCatalogPolicy.isEligibleStored(receipt: receipt, catalog: catalog, snapshot: snapshot, highestSeen: state.highWater[key]?.policy, rollbackAuthorization: stored.rollback)) == true
    }
    private func snapshot() throws -> LynxPolicySnapshot {
        .init(revision: state.revision, platform: "ios", appVersion: configuration.appVersion, channel: configuration.channel,
              embeddedBundleId: configuration.embeddedBundleId, minimumBundleId: configuration.minimumBundleId,
              cohort: configuration.cohort, runningSelection: runningSelection, nextSelection: try state.next?.policy,
              crashedBundleIds: state.crashedBundleIds, unconfirmedReleaseIds: state.unconfirmedReleaseIds)
    }
    private func save(_ next: LynxControllerState) throws { try journal.save(next); state = next }
    private func validate(_ context: LynxLaunchContext, primaryRequired: Bool = false) throws {
        guard context.owner == identity, contexts[ObjectIdentifier(context)] === context, context.active, context.started, !fatal,
              !primaryRequired || primary === context else { throw LynxArtifactError.invalid("STALE_CONTEXT: Native launch context has no authority") }
    }
    public func createContext(primary: Bool) -> LynxLaunchContext {
        lock.lock(); defer { lock.unlock() }
        let context = LynxLaunchContext(primary: primary, owner: identity)
        contexts[ObjectIdentifier(context)] = context
        return context
    }
    /// Call before loading the first template byte. A second primary cannot replace the process attempt.
    public func begin(_ context: LynxLaunchContext) throws -> LynxInstalledArtifact {
        lock.lock(); defer { lock.unlock() }
        guard context.owner == identity, contexts[ObjectIdentifier(context)] === context, context.active, !context.started, !fatal else { throw LynxArtifactError.invalid("Invalid launch context") }
        if context.primary {
            guard primary == nil else { throw LynxArtifactError.invalid("A native primary already owns this process") }
            var next = state
            if runningSelection.kind != "BUILTIN", !Self.sameIdentity(runningSelection, try state.confirmed?.policy) {
                guard next.pending == nil, next.unconfirmedReleaseIds.count < 128 else { throw LynxArtifactError.invalid("Startup trial capacity exhausted") }
                next.pending = .init(selection: running, attemptId: attemptId, contextId: context.id)
                try save(next)
            }
            primary = context
        } else if primary?.started != true { throw LynxArtifactError.invalid("Secondary context must wait for the primary") }
        context.started = true
        return runningArtifact
    }
    public func destroy(_ context: LynxLaunchContext) {
        lock.lock(); defer { lock.unlock() }
        context.active = false
        let discarded = preparations.filter { $0.value.context === context }
        for (id, value) in discarded {
            if let artifact = value.artifact { try? installer.discard(artifact) }
            preparations.removeValue(forKey: id)
        }
        contexts.removeValue(forKey: ObjectIdentifier(context))
        if primary === context {
            let callbacks = readyCallbacks; readyCallbacks = []
            callbacks.forEach { $0(.failure(LynxArtifactError.invalid("STALE_CONTEXT: Primary was destroyed"))) }
        }
    }
    public func getState(_ context: LynxLaunchContext) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }; try validate(context)
        return ["revision": state.revision, "platform": "ios", "appVersion": configuration.appVersion,
                "channel": configuration.channel, "channelKey": Data(configuration.channel.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: ""), "runtimeId": configuration.runtimeId,
                "embeddedBundleId": configuration.embeddedBundleId, "minimumBundleId": configuration.minimumBundleId,
                "cohort": configuration.cohort, "runningSelection": runningSelection.dictionary,
                "runningConfirmed": runningConfirmed,
                "confirmedSelection": try state.confirmed?.policy.dictionary as Any? ?? NSNull(),
                "nextSelection": try state.next?.policy.dictionary as Any? ?? NSNull(),
                "crashedBundleIds": state.crashedBundleIds, "unconfirmedReleaseIds": state.unconfirmedReleaseIds]
    }
    public func acceptCatalog(_ json: Data, expectedRevision: String, contextHash: String, context: LynxLaunchContext) throws -> LynxPolicyGuard {
        lock.lock(); defer { lock.unlock() }; try validate(context, primaryRequired: true)
        let current = try snapshot()
        let catalog = try LynxCatalogPolicy.parseCatalog(json: json, snapshot: current)
        let key = Self.key(catalog.catalogId, catalog.scopeKey)
        let prior = try state.catalogs[key].map { try LynxCatalogPolicy.parseCatalog(json: $0, snapshot: current) }
        let accepted = try LynxCatalogPolicy.accept(catalog: catalog, snapshot: current, expectedRevision: expectedRevision,
            claimedContextHash: contextHash, highestSeen: state.highWater[key]?.policy, previouslyAcceptedCatalog: prior)
        guard state.highWater[key] != nil || state.highWater.count < 32 else { throw LynxArtifactError.invalid("Catalog identity capacity exhausted") }
        var next = state
        next.highWater[key] = .init(generation: catalog.generation, hash: catalog.catalogHash)
        next.catalogs[key] = json
        try save(next)
        return accepted.selectionGuard
    }
    @discardableResult private func authorize(_ guardValue: LynxPolicyGuard, _ receipt: LynxPolicyReceipt) throws -> LynxPolicyAuthorization {
        let current = try snapshot()
        let key = Self.key(guardValue.catalogId, guardValue.scopeKey)
        guard let bytes = state.catalogs[key] else { throw LynxArtifactError.authorizationRequired }
        let catalog = try LynxCatalogPolicy.parseCatalog(json: bytes, snapshot: current)
        let authorization = try LynxCatalogPolicy.authorize(catalog: catalog, snapshot: current, selectionGuard: guardValue, requestedReceipt: receipt)
        guard !state.unconfirmedReleaseIds.contains(receipt.releaseId ?? ""), !state.crashedBundleIds.contains(receipt.bundleId) else { throw LynxArtifactError.authorizationRequired }
        return authorization
    }
    public func prepareSelection(guard guardValue: LynxPolicyGuard, receipt: LynxPolicyReceipt, artifact: LynxArtifactRequest?, context: LynxLaunchContext) async throws -> String {
        let cacheKey = try reservePreparation(guardValue, receipt, artifact, context)
        defer { finishPreparation(receipt.bundleId) }
        var prepared: LynxPreparedArtifact?
        do {
            if let artifact { prepared = try await installer.prepare(artifact) }
            return try retainPreparation(guardValue, receipt, prepared, context)
        } catch {
            if let prepared { try? installer.discard(prepared) }
            if case LynxArtifactError.incompatible = error { try rememberIncompatible(cacheKey) }
            throw error
        }
    }
    private func reservePreparation(_ guardValue: LynxPolicyGuard, _ receipt: LynxPolicyReceipt, _ artifact: LynxArtifactRequest?, _ context: LynxLaunchContext) throws -> String {
        lock.lock(); defer { lock.unlock() }; try validate(context, primaryRequired: true); try authorize(guardValue, receipt)
        try cleanupUnusedArtifacts() // A failed prune blocks additional downloads, while existing launches remain usable.
        guard preparations.count + inFlight < 16 else { throw LynxArtifactError.invalid("Preparation capacity exhausted") }
        if let artifact {
            guard receipt.kind == "BUNDLE", artifact.bundleId == receipt.bundleId else { throw LynxArtifactError.invalid("Artifact does not belong to selected Bundle") }
        }
        let key = Self.hash(try JSONSerialization.data(withJSONObject: [guardValue.scopeKey, receipt.bundleId, artifact?.fileHash ?? "cached", artifact?.manifestFileHash ?? "archive-anchor"]))
        guard !state.incompatibleArtifacts.contains(key) else { throw LynxArtifactError.incompatible }
        guard state.incompatibleArtifacts.count < 128 else { throw LynxArtifactError.invalid("Compatibility admission capacity exhausted") }
        inFlight += 1
        inFlightBundles[receipt.bundleId, default: 0] += 1
        return key
    }
    private func finishPreparation(_ bundleId: String) {
        lock.lock(); defer { lock.unlock() }; inFlight -= 1
        if inFlightBundles[bundleId] == 1 { inFlightBundles.removeValue(forKey: bundleId) }
        else { inFlightBundles[bundleId, default: 0] -= 1 }
    }
    private func rememberIncompatible(_ key: String) throws {
        lock.lock(); defer { lock.unlock() }
        guard state.incompatibleArtifacts.count < 128 || state.incompatibleArtifacts.contains(key) else { throw LynxArtifactError.invalid("Compatibility admission capacity exhausted") }
        var next = state; next.incompatibleArtifacts.insert(key); try save(next)
    }
    private func retainPreparation(_ guardValue: LynxPolicyGuard, _ receipt: LynxPolicyReceipt, _ prepared: LynxPreparedArtifact?, _ context: LynxLaunchContext) throws -> String {
        lock.lock(); defer { lock.unlock() }; try validate(context, primaryRequired: true); try authorize(guardValue, receipt)
        let digest: String
        if let prepared {
            guard configuration.startupResourcePaths.isSubset(of: Set(prepared.tree.files.keys)) else { throw LynxArtifactError.invalid("Selected artifact lacks native required startup resources") }
            digest = prepared.tree.digest
        }
        else if receipt.bundleId == configuration.embeddedBundleId { digest = builtin.manifestDigest }
        else if let cached = state.installedDigests[receipt.bundleId] {
            digest = try installer.inspectInstalled(bundleId: receipt.bundleId, expectedManifestDigest: cached).manifestDigest
        } else { throw LynxArtifactError.invalid("Missing selected artifact") }
        let id = UUID().uuidString
        preparations[id] = .init(guardValue: guardValue, receipt: receipt, artifact: prepared, digest: digest, context: context)
        return id
    }
    public func stageSelection(_ preparedId: String, context: LynxLaunchContext) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }; try validate(context, primaryRequired: true)
        guard let value = preparations[preparedId], value.context === context else { throw LynxArtifactError.stalePreparation }
        let authorization = try authorize(value.guardValue, value.receipt)
        let adopt = value.receipt.bundleId == runningSelection.bundleId && runningConfirmed
        func publishState() throws {
            var next = state
            let selection = try LynxStoredSelection(value.receipt, manifestDigest: value.digest, rollback: authorization.rollback)
            next.next = selection
            next.installedDigests[value.receipt.bundleId] = value.digest
            // Running bytes/receipt remain immutable. A same-byte new Release still requires its own trial unless running is already confirmed.
            if adopt { next.confirmed = selection }
            next.revision = UUID().uuidString
            try save(next)
        }
        if let artifact = value.artifact {
            _ = try installer.commit(artifact) { publish in
                _ = try publish()
                try publishState()
            }
        } else {
            if value.receipt.bundleId != configuration.embeddedBundleId { _ = try installer.inspectInstalled(bundleId: value.receipt.bundleId, expectedManifestDigest: value.digest) }
            try publishState()
        }
        preparations.removeValue(forKey: preparedId)
        try? cleanupUnusedArtifacts()
        return ["status": adopt ? "ADOPTED" : "STAGED", "requiresRestart": !adopt]
    }
    private func cleanupUnusedArtifacts() throws {
        var retained = Set([runningSelection.bundleId] + preparations.values.map { $0.receipt.bundleId } + Array(inFlightBundles.keys))
        if let confirmed = try state.confirmed?.policy { retained.insert(confirmed.bundleId) }
        if let next = try state.next?.policy { retained.insert(next.bundleId) }
        _ = try installer.pruneInstalled(keeping: retained)
        let digests = state.installedDigests.filter { retained.contains($0.key) }
        if digests != state.installedDigests {
            var next = state; next.installedDigests = digests; try save(next)
        }
    }

    /// The host calls this only after its native media/font/script loader succeeds.
    public func observedResource(_ path: String, context: LynxLaunchContext) throws {
        lock.lock(); defer { lock.unlock() }; try validate(context, primaryRequired: true)
        guard runningArtifact.files[path] != nil else { throw LynxArtifactError.invalid("Unlisted startup resource") }
        loadedStartupResources.insert(path)
        try confirmIfReady()
    }
    public func observedContent(_ context: LynxLaunchContext) throws {
        lock.lock(); defer { lock.unlock() }; try validate(context, primaryRequired: true)
        contentObserved = true
        try confirmIfReady()
    }
    public func notifyAppReady(_ context: LynxLaunchContext, completion: @escaping (Result<String, Error>) -> Void) {
        lock.lock(); defer { lock.unlock() }
        do { try validate(context, primaryRequired: true) }
        catch { completion(.failure(error)); return }
        if runningConfirmed { completion(.success("ALREADY_CONFIRMED")); return }
        readyCallbacks.append(completion); readyRequested = true
        do { try confirmIfReady() }
        catch {
            let callbacks = readyCallbacks; readyCallbacks = []
            callbacks.forEach { $0(.failure(error)) }
        }
    }
    private func confirmIfReady() throws {
        guard !runningConfirmed, contentObserved, readyRequested, configuration.startupResourcePaths.isSubset(of: loadedStartupResources), let primary else { return }
        do {
        try validate(primary, primaryRequired: true)
        var next = state
        if let pending = next.pending {
            guard pending.contextId == primary.id, pending.attemptId == attemptId,
                  Self.sameIdentity(try pending.selection.policy, runningSelection) else { throw LynxArtifactError.invalid("Startup attempt changed") }
        } else if runningSelection.kind != "BUILTIN", !Self.sameIdentity(runningSelection, try state.confirmed?.policy) {
            throw LynxArtifactError.invalid("No pending startup attempt")
        }
        next.confirmed = running; next.pending = nil
        next.revision = UUID().uuidString
        try save(next)
        runningConfirmed = true
        let callbacks = readyCallbacks; readyCallbacks = []
        callbacks.enumerated().forEach { $0.element(.success($0.offset == 0 ? "CONFIRMED" : "ALREADY_CONFIRMED")) }
        } catch {
            readyRequested = false
            let callbacks = readyCallbacks; readyCallbacks = []
            callbacks.forEach { $0(.failure(error)) }
            throw error
        }
    }
    public func reportFailure(_ context: LynxLaunchContext, fatal knownFatal: Bool) throws {
        lock.lock(); defer { lock.unlock() }; try validate(context, primaryRequired: true)
        guard knownFatal else { return } // Unknown/nonfatal errors leave the attempt for next-process recovery.
        fatal = true // A storage failure cannot restore a context already observed to fail.
        let callbacks = readyCallbacks; readyCallbacks = []
        defer { callbacks.forEach { $0(.failure(LynxArtifactError.invalid("Native startup failed"))) } }
        var next = state
        if runningSelection.kind == "BUNDLE" {
            next.crashedBundleIds.removeAll { $0 == runningSelection.bundleId }
            next.crashedBundleIds.append(runningSelection.bundleId)
            if next.crashedBundleIds.count > 10 { next.crashedBundleIds.removeFirst(next.crashedBundleIds.count - 10) }
        } else if let releaseId = runningSelection.releaseId, !next.unconfirmedReleaseIds.contains(releaseId) {
            // Explicit EMBEDDED is a Release trial. Its failure must not blacklist native builtin bytes.
            guard next.unconfirmedReleaseIds.count < 128 else { throw LynxArtifactError.invalid("Startup suppression capacity exhausted") }
            next.unconfirmedReleaseIds.append(releaseId)
        }
        if next.pending?.attemptId == attemptId { next.pending = nil }
        next.revision = UUID().uuidString
        try save(next)
    }
    /// All contexts retain the same process-pinned immutable tree; no resource uses next selection.
    public func resource(_ rawURL: String, context: LynxLaunchContext) throws -> Data {
        lock.lock(); defer { lock.unlock() }; try validate(context)
        guard let url = URL(string: rawURL), url.scheme == "hot-updater", url.host == nil || url.host == "",
              url.query == nil, url.fragment == nil, let decoded = url.path.removingPercentEncoding else { throw LynxArtifactError.invalid("Unsupported managed resource URL") }
        let name = String(decoded.drop(while: { $0 == "/" }))
        guard ArchiveExtractionUtilities.normalizedRelativePath(from: name) == name,
              let digest = runningArtifact.files[name] else { throw LynxArtifactError.invalid("Unlisted managed resource") }
        let file = runningArtifact.directory.appendingPathComponent(name)
        guard file.resolvingSymlinksInPath() == file else { throw LynxArtifactError.invalid("Managed resource link rejected") }
        let data = try Data(contentsOf: file)
        guard Self.hash(data) == digest else { throw LynxArtifactError.invalid("Managed resource integrity mismatch") }
        return data
    }
}
