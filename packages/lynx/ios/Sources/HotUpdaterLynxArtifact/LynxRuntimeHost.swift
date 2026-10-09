import Foundation

/// Coordinates native storage ownership for foreground generations and detached tasks.
public final class LynxRuntimeHost {
    private final class WeakHost {
        weak var value: LynxRuntimeHost?
        init(_ value: LynxRuntimeHost) { self.value = value }
    }
    private struct TaskRecord {
        let snapshot: LynxBackgroundSnapshot
        var fatal = false
        var persisted = false
        var ended = false
    }
    private static let registryLock = NSLock()
    private static var hosts: [String: WeakHost] = [:]

    public let configuration: LynxControllerConfiguration
    let scope: LynxNativeScope
    let ownerLock = NSRecursiveLock()
    let stateLock = NSRecursiveLock()
    weak var foreground: LynxController?
    private var tasks: [UUID: TaskRecord] = [:]
    // An unpersisted fatal must survive the executor and the last foreground owner.
    private var taskRetention: LynxRuntimeHost?

    private init(configuration: LynxControllerConfiguration, scope: LynxNativeScope) {
        self.configuration = configuration
        self.scope = scope
    }

    public static func get(configuration config: LynxControllerConfiguration) throws -> LynxRuntimeHost {
        let canonical = LynxControllerConfiguration(
            root: URL(fileURLWithPath: config.root.standardizedFileURL.resolvingSymlinksInPath().path, isDirectory: true),
            runtimeId: config.runtimeId, binaryIdentity: config.binaryIdentity,
            embeddedDirectory: URL(fileURLWithPath: config.embeddedDirectory.standardizedFileURL.resolvingSymlinksInPath().path, isDirectory: true),
            embeddedBundleId: config.embeddedBundleId, embeddedManifestDigest: config.embeddedManifestDigest,
            minimumBundleId: config.minimumBundleId, appVersion: config.appVersion,
            channel: config.channel, cohort: config.cohort, publicKeyPEM: config.publicKeyPEM,
            startupResourcePaths: config.startupResourcePaths, fingerprintHash: config.fingerprintHash
        )
        let scope = try LynxNativeScope(configuration: canonical)
        registryLock.lock(); defer { registryLock.unlock() }
        hosts = hosts.filter { $0.value.value != nil }
        if let host = hosts[scope.home.path]?.value {
            guard host.configuration == canonical else {
                throw LynxArtifactError.invalid("Conflicting native configuration for a live Lynx scope")
            }
            return host
        }
        let host = LynxRuntimeHost(configuration: canonical, scope: scope)
        hosts[scope.home.path] = WeakHost(host)
        return host
    }

    /// Ordinary controller construction uses the same coordinator as this factory.
    public func createForeground() throws -> LynxController {
        try LynxController(configuration: configuration)
    }

    // Caller holds ownerLock. No existing foreground can publish while a cold lease is held.
    func prepareForeground() throws {
        guard foreground == nil else { throw LynxArtifactError.storeBusy }
        stateLock.lock(); defer { stateLock.unlock() }
        if tasks.values.contains(where: { $0.fatal && !$0.persisted }) {
            try withColdStore { _, journal in
                var state = try journal.load()
                try persistFailures(state: &state, journal: journal)
            }
        }
    }

    func beginBackground() throws -> LynxBackgroundTask {
        ownerLock.lock(); defer { ownerLock.unlock() }
        if let foreground { return try foreground.beginBackground() }
        stateLock.lock(); defer { stateLock.unlock() }
        return try withColdStore { installer, journal in
            var state = try journal.load()
            try persistFailures(state: &state, journal: journal)
            try requireTaskSlot()
            let snapshot = try LynxStoredSelectionReader.copy(
                state: state, scope: scope, configuration: configuration,
                installer: installer, cold: true, processToken: LynxController.processToken
            )
            return try reserve(snapshot, state: state, live: nil)
        }
    }

    private func withColdStore<T>(
        _ body: (LynxArtifactInstaller, LynxControllerJournal) throws -> T
    ) throws -> T {
        let installer = try LynxArtifactInstaller(root: scope.home, configuration: .init(
            runtimeId: configuration.runtimeId, publicKeyPEM: configuration.publicKeyPEM
        ))
        defer { installer.close() }
        return try body(installer, LynxControllerJournal(file: scope.home.appendingPathComponent("state.json")))
    }

    // All task and admission operations below run under the shared state lock.
    private func reservedReleases(state: LynxControllerState, live: LynxPolicyReceipt?) -> Set<String> {
        var ids = state.recoveryIdentities
        let selections = [state.pending?.selection] + (state.pendingPages ?? []).map { Optional($0.selection) }
        for selection in selections.compactMap({ $0 }) {
            if let id = try? selection.policy.releaseId { ids.insert(id) }
        }
        if let id = live?.releaseId { ids.insert(id) }
        for task in tasks.values {
            if let id = task.snapshot.selection.releaseId { ids.insert(id) }
        }
        return ids
    }

    func canAdmit(_ receipt: LynxPolicyReceipt, state: LynxControllerState, live: LynxPolicyReceipt?) -> Bool {
        var ids = reservedReleases(state: state, live: live)
        if let id = receipt.releaseId { ids.insert(id) }
        return ids.count <= 128
    }

    func requireTaskSlot() throws {
        guard tasks.count < 4 else { throw LynxArtifactError.invalid("Too many concurrent Lynx background tasks") }
    }

    func reserve(_ snapshot: LynxBackgroundSnapshot, state: LynxControllerState,
                 live: LynxPolicyReceipt?) throws -> LynxBackgroundTask {
        try requireTaskSlot()
        guard canAdmit(snapshot.selection, state: state, live: live),
              !tasks.values.contains(where: { $0.fatal && !$0.persisted }) else {
            throw LynxArtifactError.invalid("Background recovery capacity unavailable")
        }
        tasks[snapshot.taskId] = TaskRecord(snapshot: snapshot)
        taskRetention = self
        return LynxBackgroundTask(snapshot: snapshot, host: self)
    }

    func finishBackground(_ taskId: UUID, fatal: Bool, ended: Bool) throws {
        var deliveries: [() -> Void] = []
        ownerLock.lock()
        stateLock.lock()
        defer {
            stateLock.unlock()
            ownerLock.unlock()
            deliveries.forEach { $0() }
        }
        guard var task = tasks[taskId] else { return }
        task.fatal = task.fatal || fatal
        task.ended = task.ended || ended
        tasks[taskId] = task
        if task.fatal && !task.persisted {
            if let foreground {
                deliveries = foreground.invalidateBackgroundFailure(bundleId: task.snapshot.selection.bundleId)
                try foreground.replayBackgroundFailures()
            } else {
                try withColdStore { _, journal in
                    var state = try journal.load()
                    try persistFailures(state: &state, journal: journal)
                }
            }
        }
        releaseEndedTasks()
    }

    func persistFailures(state: inout LynxControllerState, journal: LynxControllerJournal) throws {
        let failed = tasks.filter { $0.value.fatal && !$0.value.persisted }
        guard !failed.isEmpty else { return }
        var next = state
        for task in failed.values {
            try next.recordFatal(task.snapshot.stored, embeddedBundleId: configuration.embeddedBundleId)
        }
        next.revision = UUID().uuidString
        try journal.save(next)
        state = next
        for id in failed.keys { tasks[id]?.persisted = true }
        releaseEndedTasks()
    }

    private func releaseEndedTasks() {
        tasks = tasks.filter { !$0.value.ended || ($0.value.fatal && !$0.value.persisted) }
        if tasks.isEmpty { taskRetention = nil }
    }
}
