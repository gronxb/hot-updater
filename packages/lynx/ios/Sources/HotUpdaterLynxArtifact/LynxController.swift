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
    public let fingerprintHash: String
    public init(root: URL, runtimeId: String, binaryIdentity: String, embeddedDirectory: URL,
                embeddedBundleId: String, embeddedManifestDigest: String, minimumBundleId: String,
                appVersion: String, channel: String, cohort: String, publicKeyPEM: String? = nil, startupResourcePaths: Set<String> = [],
                fingerprintHash: String? = nil) {
        self.root = root; self.runtimeId = runtimeId; self.binaryIdentity = binaryIdentity
        self.embeddedDirectory = embeddedDirectory; self.embeddedBundleId = embeddedBundleId
        self.embeddedManifestDigest = embeddedManifestDigest; self.minimumBundleId = minimumBundleId
        self.appVersion = appVersion; self.channel = channel; self.cohort = cohort; self.publicKeyPEM = publicKeyPEM
        self.startupResourcePaths = startupResourcePaths
        self.fingerprintHash = fingerprintHash.flatMap { $0.isEmpty ? nil : $0 } ?? binaryIdentity
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

public struct LynxLaunchTransition {
    public let kind: String
    public let from: LynxPolicyReceipt
    public let to: LynxPolicyReceipt
    var dictionary: [String: Any] {
        ["kind": kind, "from": Self.summary(from), "to": Self.summary(to)]
    }
    private static func summary(_ receipt: LynxPolicyReceipt) -> [String: Any] {
        ["kind": receipt.kind, "releaseId": receipt.releaseId as Any? ?? NSNull(),
         "bundleId": receipt.bundleId, "channel": receipt.channel]
    }
}

public struct LynxConfirmationResult {
    public let status: String
    public let transition: LynxLaunchTransition?
    public var dictionary: [String: Any] {
        ["status": status, "transition": transition?.dictionary as Any? ?? NSNull()]
    }
}

/// One controller owns one managed runtime generation and one native storage/scope lease.
public final class LynxController {
    public let configuration: LynxControllerConfiguration
    public let runningArtifact: LynxInstalledArtifact
    public private(set) var runningSelection: LynxPolicyReceipt
    public let attemptId = UUID().uuidString
    private let identity = UUID()
    private let lock = NSRecursiveLock()
    private let installer: LynxArtifactInstaller
    private let journal: LynxControllerJournal
    private let builtin: LynxStoredSelection
    private var running: LynxStoredSelection
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
    private var readyCallbacks: [(Result<LynxConfirmationResult, Error>) -> Void] = []
    private var readyRequested = false
    private var closed = false
    private var runtimeCohort: String
    private var runtimeChannel: String

    public convenience init(configuration config: LynxControllerConfiguration) throws {
        try self.init(
            configuration: config,
            artifactFetch: nil,
            journalDirectorySync: nil
        )
    }

    init(configuration config: LynxControllerConfiguration,
         artifactFetch: LynxArtifactFetch?,
         journalDirectorySync: ((URL) throws -> Void)? = nil) throws {
        guard !config.runtimeId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !config.binaryIdentity.isEmpty, !config.channel.isEmpty, config.channel == config.channel.trimmingCharacters(in: .whitespacesAndNewlines),
              config.channel.utf8.elementsEqual(config.channel.precomposedStringWithCanonicalMapping.utf8),
              config.appVersion.range(of: "^[0-9]+\\.[0-9]+\\.[0-9]+([+-][0-9A-Za-z.-]+)?$", options: .regularExpression) != nil,
              UUID(uuidString: config.embeddedBundleId) != nil, UUID(uuidString: config.minimumBundleId) != nil else {
            throw LynxArtifactError.invalid("Invalid native Lynx controller configuration")
        }
        configuration = config
        runtimeCohort = try LynxCatalogPolicy.normalizedCohort(config.cohort)
        runtimeChannel = config.channel
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
        if let artifactFetch {
            installer = try LynxArtifactInstaller(
                root: home,
                configuration: profile,
                fetch: artifactFetch
            )
        } else {
            installer = try LynxArtifactInstaller(root: home, configuration: profile)
        }
        let journalFile = home.appendingPathComponent("state.json")
        if let journalDirectorySync {
            journal = LynxControllerJournal(
                file: journalFile,
                synchronizeDirectory: journalDirectorySync
            )
        } else {
            journal = LynxControllerJournal(file: journalFile)
        }
        var recovered = try journal.load()
        var recoveredChanged = false
        if let cohort = recovered.selectionCohort, !cohort.isEmpty {
            let normalized = try LynxCatalogPolicy.normalizedCohort(cohort)
            runtimeCohort = normalized
            if normalized != cohort {
                recovered.selectionCohort = normalized
                recoveredChanged = true
            }
        }
        var failedPendingSelection: LynxStoredSelection?
        if let pending = recovered.pending {
            failedPendingSelection = pending.selection
            let receipt = try pending.selection.policy
            if let releaseId = receipt.releaseId, !recovered.unconfirmedReleaseIds.contains(releaseId) {
                guard recovered.unconfirmedReleaseIds.count < 128 else { throw LynxArtifactError.invalid("Missing reserved startup recovery capacity") }
                recovered.unconfirmedReleaseIds.append(releaseId)
            }
            recovered.pending = nil
            recoveredChanged = true
        }
        if recovered.selectionChannel == nil || recovered.selectionChannel?.isEmpty == true {
            recovered.selectionChannel = config.channel
            recoveredChanged = true
        }
        if let channel = recovered.selectionChannel, !channel.isEmpty {
            runtimeChannel = channel
        }
        let snapshotCohort = runtimeCohort
        let nativeSnapshot = { (base: LynxPolicyReceipt) in
            LynxPolicySnapshot(revision: recovered.revision, platform: "ios", appVersion: config.appVersion,
                channel: base.channel, embeddedBundleId: config.embeddedBundleId, minimumBundleId: config.minimumBundleId,
                cohort: snapshotCohort, runningSelection: base, nextSelection: nil,
                crashedBundleIds: recovered.crashedBundleIds, unconfirmedReleaseIds: recovered.unconfirmedReleaseIds,
                fingerprintHash: config.fingerprintHash)
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
            recovered.next = nil
            recoveredChanged = true
        }
        let selectedChannel = selected != nil ? runningSelection.channel
            : (failedPendingSelection != nil ? config.channel : (recovered.selectionChannel ?? config.channel))
        if recovered.selectionChannel != selectedChannel {
            recovered.selectionChannel = selectedChannel
            recoveredChanged = true
        }
        runtimeChannel = selectedChannel
        let transition: LynxLaunchTransition?
        if let failed = try failedPendingSelection?.policy {
            transition = Self.launchTransition(from: failed, to: runningSelection, recovery: true)
        } else {
            let stable = try recovered.confirmed?.policy ?? builtinPolicy
            transition = Self.launchTransition(from: stable, to: runningSelection)
        }
        if let transition {
            recovered.launchTransition = try LynxStoredLaunchTransition(transition)
            recoveredChanged = true
        } else if let storedTransition = recovered.launchTransition {
            if (try? Self.sameIdentity(storedTransition.policy.to, runningSelection)) != true {
                recovered.launchTransition = nil
                recoveredChanged = true
            }
        }
        if recoveredChanged {
            recovered.revision = UUID().uuidString
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
    private static func sameReleaseIdentity(_ a: LynxPolicyReceipt, _ b: LynxPolicyReceipt) -> Bool {
        a.bundleId == b.bundleId && a.releaseId == b.releaseId
    }
    private static func launchTransition(from: LynxPolicyReceipt, to: LynxPolicyReceipt,
                                         recovery: Bool = false) -> LynxLaunchTransition? {
        guard !sameReleaseIdentity(from, to) else { return nil }
        if recovery { return .init(kind: "RECOVERED", from: from, to: to) }
        if from.bundleId != to.bundleId {
            return .init(kind: "UPDATE_APPLIED", from: from, to: to)
        }
        guard let fromRelease = from.releaseId, let toRelease = to.releaseId,
              fromRelease != toRelease else { return nil }
        return .init(kind: "UNCHANGED", from: from, to: to)
    }
    private static func storedEligible(_ stored: LynxStoredSelection, state: LynxControllerState, snapshot: LynxPolicySnapshot) -> Bool {
        guard let receipt = try? stored.policy else { return false }
        if receipt.kind == "BUILTIN", receipt.catalogId == nil { return receipt.bundleId == snapshot.embeddedBundleId }
        guard let catalogId = receipt.catalogId, let scope = receipt.scopeKey else { return false }
        let key = key(catalogId, scope)
        guard let bytes = state.catalogs[key], let catalog = try? LynxCatalogPolicy.parseCatalog(json: bytes, snapshot: snapshot) else { return false }
        return (try? LynxCatalogPolicy.isEligibleStored(receipt: receipt, catalog: catalog, snapshot: snapshot, highestSeen: state.highWater[key]?.policy, rollbackAuthorization: stored.rollback)) == true
    }
    private func snapshot() throws -> LynxPolicySnapshot {
        .init(revision: state.revision, platform: "ios", appVersion: configuration.appVersion, channel: runtimeChannel,
              embeddedBundleId: configuration.embeddedBundleId, minimumBundleId: configuration.minimumBundleId,
              cohort: runtimeCohort, runningSelection: runningSelection, nextSelection: try state.next?.policy,
              crashedBundleIds: state.crashedBundleIds, unconfirmedReleaseIds: state.unconfirmedReleaseIds,
              fingerprintHash: configuration.fingerprintHash)
    }
    private func selectionSnapshot(targetChannel: String, explicitScopeSwitch: Bool,
                                   accepting: Bool = false) throws -> LynxPolicySnapshot {
        guard explicitScopeSwitch == (targetChannel != runtimeChannel) else {
            throw LynxPolicyError(
                code: accepting ? "INVALID_SCOPE_SWITCH" : "STALE_SELECTION",
                message: "Catalog channel-switch intent no longer matches native state"
            )
        }
        if explicitScopeSwitch {
            guard runtimeChannel == configuration.channel else {
                throw LynxPolicyError(
                    code: accepting ? "CHANNEL_ALREADY_SWITCHED" : "STALE_SELECTION",
                    message: "Reset the current native channel before switching again"
                )
            }
            let minimumBase = LynxPolicyReceipt(
                kind: "BUILTIN", releaseId: nil, bundleId: configuration.minimumBundleId,
                catalogId: nil, scopeKey: nil, generation: nil, catalogHash: nil,
                channel: targetChannel, selectionContextHash: nil
            )
            return .init(
                revision: state.revision, platform: "ios", appVersion: configuration.appVersion,
                channel: targetChannel, embeddedBundleId: configuration.embeddedBundleId,
                minimumBundleId: configuration.minimumBundleId, cohort: runtimeCohort,
                runningSelection: minimumBase, nextSelection: nil,
                crashedBundleIds: state.crashedBundleIds,
                unconfirmedReleaseIds: state.unconfirmedReleaseIds,
                fingerprintHash: configuration.fingerprintHash
            )
        }
        return try snapshot()
    }
    private func save(_ next: LynxControllerState) throws { try journal.save(next); state = next }
    private func validate(_ context: LynxLaunchContext, primaryRequired: Bool = false) throws {
        guard context.owner == identity, contexts[ObjectIdentifier(context)] === context, context.active, context.started, !fatal,
              !closed, !primaryRequired || primary === context else { throw LynxArtifactError.invalid("STALE_CONTEXT: Native launch context has no authority") }
    }
    public func createContext(primary: Bool) -> LynxLaunchContext {
        lock.lock(); defer { lock.unlock() }
        precondition(!closed, "The native Lynx controller is closed")
        let context = LynxLaunchContext(primary: primary, owner: identity)
        contexts[ObjectIdentifier(context)] = context
        return context
    }
    /// Call before loading the first template byte. A second primary cannot replace this generation.
    public func begin(_ context: LynxLaunchContext) throws -> LynxInstalledArtifact {
        lock.lock(); defer { lock.unlock() }
        guard context.owner == identity, contexts[ObjectIdentifier(context)] === context, context.active, !context.started, !fatal else { throw LynxArtifactError.invalid("Invalid launch context") }
        if context.primary {
            guard primary == nil else { throw LynxArtifactError.invalid("A native primary already owns this generation") }
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

    /// Invalidates every context before releasing this generation's store lease.
    public func close() throws {
        lock.lock()
        guard !closed else { lock.unlock(); return }
        closed = true
        fatal = true
        contexts.values.forEach { $0.active = false }
        contexts.removeAll()
        primary = nil
        let discarded = preparations.values.compactMap(\.artifact)
        preparations.removeAll()
        inFlightBundles.removeAll()
        let callbacks = readyCallbacks
        readyCallbacks.removeAll()
        lock.unlock()
        discarded.forEach { try? installer.discard($0) }
        installer.close()
        callbacks.forEach {
            $0(.failure(LynxArtifactError.invalid("STALE_CONTEXT: Generation closed")))
        }
    }
    public func setCohort(_ cohort: String, context: LynxLaunchContext) throws {
        lock.lock(); defer { lock.unlock() }; try validate(context)
        let normalized = try LynxCatalogPolicy.normalizedCohort(cohort)
        var next = state
        next.selectionCohort = normalized
        next.revision = UUID().uuidString
        try save(next)
        runtimeCohort = normalized
    }
    public func resetChannel(_ context: LynxLaunchContext) throws -> Bool {
        lock.lock(); defer { lock.unlock() }; try validate(context)
        var next = state
        next.selectionChannel = configuration.channel
        next.confirmed = nil
        next.next = nil
        next.pending = nil
        next.launchTransition = nil
        next.catalogAcceptances = nil
        next.revision = UUID().uuidString
        try save(next)
        runtimeChannel = configuration.channel
        return true
    }
    public func clearCrashHistory(_ context: LynxLaunchContext) throws {
        lock.lock(); defer { lock.unlock() }; try validate(context)
        var next = state
        next.crashedBundleIds = []
        try save(next)
    }
    public func getState(_ context: LynxLaunchContext) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }; try validate(context)
        return ["revision": state.revision, "platform": "ios", "appVersion": configuration.appVersion,
                "channel": runtimeChannel, "defaultChannel": configuration.channel,
                "channelKey": Data(runtimeChannel.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: ""), "runtimeId": configuration.runtimeId,
                "embeddedBundleId": configuration.embeddedBundleId, "minimumBundleId": configuration.minimumBundleId,
                "cohort": runtimeCohort, "runningSelection": runningSelection.dictionary,
                "runningConfirmed": runningConfirmed,
                "confirmedSelection": try state.confirmed?.policy.dictionary as Any? ?? NSNull(),
                "nextSelection": try state.next?.policy.dictionary as Any? ?? NSNull(),
                "crashedBundleIds": state.crashedBundleIds, "unconfirmedReleaseIds": state.unconfirmedReleaseIds,
                "fingerprintHash": configuration.fingerprintHash]
    }
    public func acceptCatalog(_ json: Data, expectedRevision: String, contextHash: String,
                              targetChannel: String? = nil, explicitScopeSwitch: Bool = false,
                              context: LynxLaunchContext) throws -> LynxPolicyGuard {
        lock.lock(); defer { lock.unlock() }; try validate(context, primaryRequired: true)
        let current = try selectionSnapshot(
            targetChannel: targetChannel ?? runtimeChannel,
            explicitScopeSwitch: explicitScopeSwitch,
            accepting: true
        )
        let catalog = try LynxCatalogPolicy.parseCatalog(json: json, snapshot: current)
        let key = Self.key(catalog.catalogId, catalog.scopeKey)
        let prior = try state.catalogs[key].map { try LynxCatalogPolicy.parseCatalog(json: $0, snapshot: current) }
        let accepted = try LynxCatalogPolicy.accept(catalog: catalog, snapshot: current, expectedRevision: expectedRevision,
            claimedContextHash: contextHash, highestSeen: state.highWater[key]?.policy, previouslyAcceptedCatalog: prior)
        guard state.highWater[key] != nil || state.highWater.count < 32 else { throw LynxArtifactError.invalid("Catalog identity capacity exhausted") }
        var next = state
        next.highWater[key] = .init(generation: catalog.generation, hash: catalog.catalogHash)
        next.catalogs[key] = json
        var acceptances = next.catalogAcceptances ?? [:]
        acceptances[key] = try LynxStoredCatalogAcceptance(
            accepted.selectionGuard,
            explicitScopeSwitch: explicitScopeSwitch
        )
        next.catalogAcceptances = acceptances
        try save(next)
        return accepted.selectionGuard
    }
    @discardableResult private func authorize(_ guardValue: LynxPolicyGuard, _ receipt: LynxPolicyReceipt) throws -> LynxPolicyAuthorization {
        let key = Self.key(guardValue.catalogId, guardValue.scopeKey)
        guard let bytes = state.catalogs[key],
              let accepted = state.catalogAcceptances?[key],
              (try? accepted.policyGuard) == guardValue else {
            throw LynxArtifactError.authorizationRequired
        }
        let current = try selectionSnapshot(
            targetChannel: guardValue.channel,
            explicitScopeSwitch: accepted.explicitScopeSwitch
        )
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
            if let artifact {
                // JavaScript cannot nominate a patch base. The controller's immutable,
                // verified running tree is the only base admitted to the installer.
                prepared = try await installer.prepare(
                    artifact,
                    base: runningArtifact,
                    releaseId: receipt.releaseId
                )
            }
            return try retainPreparation(guardValue, receipt, prepared, context)
        } catch {
            if let prepared { try? installer.discard(prepared) }
            if case LynxArtifactError.incompatible = error, let cacheKey {
                try rememberIncompatible(cacheKey)
            }
            throw error
        }
    }
    public func validateSelection(guard guardValue: LynxPolicyGuard, receipt: LynxPolicyReceipt,
                                  artifact: LynxArtifactRequest?, context: LynxLaunchContext) async throws {
        let preparedId = try await prepareSelection(
            guard: guardValue,
            receipt: receipt,
            artifact: artifact,
            context: context
        )
        let consumed = consumeValidation(preparedId, context: context)
        guard let retained = consumed.preparation else { throw LynxArtifactError.stalePreparation }
        if let prepared = retained.artifact { try installer.discard(prepared) }
        if let error = consumed.contextError { throw error }
    }
    private func consumeValidation(_ preparedId: String, context: LynxLaunchContext) -> (
        preparation: LynxSelectionPreparation?,
        contextError: Error?
    ) {
        lock.lock(); defer { lock.unlock() }
        guard let retained = preparations.removeValue(forKey: preparedId),
              retained.context === context else {
            return (nil, LynxArtifactError.stalePreparation)
        }
        let contextError: Error?
        do { try validate(context, primaryRequired: true); contextError = nil }
        catch { contextError = error }
        try? cleanupUnusedArtifacts()
        return (retained, contextError)
    }
    private func reservePreparation(_ guardValue: LynxPolicyGuard, _ receipt: LynxPolicyReceipt, _ artifact: LynxArtifactRequest?, _ context: LynxLaunchContext) throws -> String? {
        lock.lock(); defer { lock.unlock() }; try validate(context, primaryRequired: true); try authorize(guardValue, receipt)
        try cleanupUnusedArtifacts() // A failed prune blocks additional downloads, while existing launches remain usable.
        guard preparations.count + inFlight < 16 else { throw LynxArtifactError.invalid("Preparation capacity exhausted") }
        if let artifact {
            guard receipt.kind == "BUNDLE", artifact.bundleId == receipt.bundleId else { throw LynxArtifactError.invalid("Artifact does not belong to selected Bundle") }
        }
        let key = try artifact.map {
            Self.hash(try JSONSerialization.data(withJSONObject: [
                guardValue.scopeKey, receipt.bundleId, $0.fileHash ?? "cached",
                $0.manifestFileHash ?? "archive-anchor",
            ]))
        }
        if let key, state.incompatibleArtifacts.contains(key) {
            throw LynxArtifactError.incompatible
        }
        inFlight += 1
        inFlightBundles[receipt.bundleId, default: 0] += 1
        return key
    }
    private func finishPreparation(_ bundleId: String) {
        lock.lock(); defer { lock.unlock() }
        if inFlight > 0 { inFlight -= 1 }
        guard !closed else { return }
        if inFlightBundles[bundleId] == 1 { inFlightBundles.removeValue(forKey: bundleId) }
        else { inFlightBundles[bundleId, default: 0] -= 1 }
    }
    private func rememberIncompatible(_ key: String) throws {
        lock.lock(); defer { lock.unlock() }
        guard !closed else { return }
        guard !state.incompatibleArtifacts.contains(key) else { return }
        var next = state
        if next.incompatibleArtifacts.count == 128 {
            next.incompatibleArtifacts.removeFirst()
        }
        next.incompatibleArtifacts.append(key)
        try save(next)
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
        defer {
            preparations.removeValue(forKey: preparedId)
            if let artifact = value.artifact { try? installer.discard(artifact) }
            try? cleanupUnusedArtifacts()
        }
        let authorization = try authorize(value.guardValue, value.receipt)
        let adopt = value.receipt.kind == "BUNDLE"
            && value.receipt.bundleId == runningSelection.bundleId && runningConfirmed
        func publishState() throws {
            var next = state
            let selection = try LynxStoredSelection(value.receipt, manifestDigest: value.digest, rollback: authorization.rollback)
            next.selectionChannel = value.receipt.channel
            next.installedDigests[value.receipt.bundleId] = value.digest
            // Running bytes remain immutable. A same-byte new Release may adopt
            // its authorized identity only after the current bytes are confirmed.
            if adopt {
                next.next = nil
                next.confirmed = selection
                if let transition = Self.launchTransition(from: runningSelection, to: value.receipt) {
                    next.launchTransition = try LynxStoredLaunchTransition(transition)
                }
            } else {
                next.next = selection
                if value.receipt.kind == "BUILTIN" { next.confirmed = nil }
            }
            next.revision = UUID().uuidString
            try save(next)
            if adopt {
                running = selection
                runningSelection = value.receipt
            }
            runtimeChannel = value.receipt.channel
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
        return ["status": adopt ? "ADOPTED" : "STAGED", "requiresRestart": !adopt]
    }
    private func cleanupUnusedArtifacts() throws {
        var retained = Set([runningSelection.bundleId] + preparations.values.map { $0.receipt.bundleId } + Array(inFlightBundles.keys))
        if let confirmed = try state.confirmed?.policy { retained.insert(confirmed.bundleId) }
        if let next = try state.next?.policy { retained.insert(next.bundleId) }
        let extras = state.installedDigests.keys.filter { !retained.contains($0) }.sorted()
        retained.formUnion(extras.suffix(1))
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
    public func notifyAppReady(_ context: LynxLaunchContext,
                               completion: @escaping (Result<LynxConfirmationResult, Error>) -> Void) {
        lock.lock(); defer { lock.unlock() }
        do { try validate(context, primaryRequired: true) }
        catch { completion(.failure(error)); return }
        if runningConfirmed {
            do {
                var next = state
                let transition = try next.launchTransition?.policy
                guard transition.map({ Self.sameIdentity($0.to, runningSelection) }) ?? true else {
                    throw LynxArtifactError.invalid("Launch transition does not match the running selection")
                }
                if next.launchTransition != nil {
                    next.launchTransition = nil
                    next.revision = UUID().uuidString
                    try save(next)
                }
                completion(.success(.init(status: "ALREADY_CONFIRMED", transition: transition)))
            } catch { completion(.failure(error)) }
            return
        }
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
        let transition = try next.launchTransition?.policy
        guard transition.map({ Self.sameIdentity($0.to, runningSelection) }) ?? true else {
            throw LynxArtifactError.invalid("Launch transition does not match the running selection")
        }
        next.confirmed = running; next.pending = nil
        next.launchTransition = nil
        next.revision = UUID().uuidString
        try save(next)
        runningConfirmed = true
        let callbacks = readyCallbacks; readyCallbacks = []
        callbacks.enumerated().forEach {
            $0.element(.success(.init(
                status: $0.offset == 0 ? "CONFIRMED" : "ALREADY_CONFIRMED",
                transition: $0.offset == 0 ? transition : nil
            )))
        }
        } catch {
            readyRequested = false
            let callbacks = readyCallbacks; readyCallbacks = []
            callbacks.forEach { $0(.failure(error)) }
            throw error
        }
    }
    @discardableResult
    public func reportFailure(
        _ context: LynxLaunchContext,
        fatal knownFatal: Bool,
        allowConfirmed: Bool = false
    ) throws -> Bool {
        lock.lock(); defer { lock.unlock() }; try validate(context, primaryRequired: true)
        // Errors after startup confirmation are outside the initial rollback window.
        guard knownFatal, !runningConfirmed || allowConfirmed else { return false }
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
        return true
    }
    /// All contexts retain the same generation-pinned immutable tree; no resource uses next selection.
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
