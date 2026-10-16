import Foundation

/// The file a launch leaves when its process dies before first content. Each
/// instance keeps its own in its own bundle store, so only that instance's
/// next start reads it, rolls back the bundle it names, and records the crash
/// in its own history. The file's location says whose it is.
enum HotUpdaterCrashMarker {
    static let filename = "recovery-crash-marker.json"

    /// `<documents>/bundle-store/recovery-crash-marker.json` for main,
    /// `<documents>/hot-updater-instances/<name>/bundle-store/...` otherwise.
    static func url(for environment: HotUpdaterInstanceEnvironment, documentsPath: String) -> URL {
        URL(fileURLWithPath: environment.bundleStorePath(documentsPath: documentsPath), isDirectory: true)
            .appendingPathComponent(filename)
    }

    /// Reads and deletes the marker; nil when there is none.
    static func consume(at url: URL) -> PendingCrashRecovery? {
        guard FileManager.default.fileExists(atPath: url.path) else {
            return nil
        }

        defer {
            try? FileManager.default.removeItem(at: url)
        }

        do {
            let data = try Data(contentsOf: url)
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
            return PendingCrashRecovery.from(json: json)
        } catch {
            NSLog("[HotUpdaterRecovery] Failed to read crash marker: \(error)")
            return nil
        }
    }

    static func write(bundleId: String?, shouldRollback: Bool, to url: URL) {
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: nil
            )

            let payload: [String: Any] = [
                "bundleId": bundleId ?? NSNull(),
                "shouldRollback": shouldRollback,
            ]
            let data = try JSONSerialization.data(withJSONObject: payload)
            try data.write(to: url, options: .atomic)
        } catch {
            NSLog("[HotUpdaterRecovery] Failed to write crash marker: \(error)")
        }
    }
}

/// Where crash recovery mirrors its slots for the native signal handler,
/// which can't call into Swift: HotUpdater.mm keeps a fixed array of C slots
/// it writes markers from, and this keeps them in step.
protocol HotUpdaterCrashSlotSink: AnyObject {
    /// Slot `slot` writes `{"bundleId":…,"shouldRollback":true}` to
    /// `markerPath` on a native crash while `shouldRollback` is set.
    func updateSlot(_ slot: Int, markerPath: String, bundleId: String?, shouldRollback: Bool)
    /// `HotUpdaterRecoveryCoordinator.unattributed`, a slot, or
    /// `attributedWithoutSlot`: which slots a native crash may write.
    func attributeCrash(toSlot slot: Int)
}

/// Crash recovery of every instance in the process. The handlers that see a
/// crash are process-wide (one signal handler, one uncaught exception handler,
/// one React Native fatal handler), so they ask this which instances a crash
/// counts against:
///
/// - A JavaScript fatal belongs to the instance whose runtime threw it, and
///   charges only that one. One that can't be attributed counts as a native
///   crash.
/// - A native crash, or an uncaught exception, kills the process: it counts
///   against each instance whose launch is unverified (started, first content
///   not yet shown), and never against one whose content appeared.
/// - First content verifies only the instance whose view showed it.
///
/// Main keeps what it always did: its launch counts as started when it is
/// selected in the foreground, and its fatal before first content reloads it
/// in-process. A named launch counts as started only once a view of its
/// runtime is shown, since a runtime warmed up without UI must not be rolled
/// back at the next start.
final class HotUpdaterRecoveryCoordinator {
    /// Native crash markers the signal handler can write, main's included.
    /// More instances than this still roll back an unfinished launch at their
    /// next start (`launchInProgress`), but get no marker from a native crash.
    static let slotCount = 8
    static let mainSlot = 0
    /// A native crash writes every slot whose launch is unverified.
    static let unattributed = -1
    /// The crash is a fatal of an instance without a slot: a native crash
    /// writes none.
    static let attributedWithoutSlot = -2

    /// One instance's launch as crash recovery watches it.
    final class Launch {
        let name: String
        let markerURL: URL
        let storage: BundleStorageService
        var isMain: Bool { name == HotUpdaterInstanceEnvironment.mainName }

        fileprivate(set) var slot: Int?
        fileprivate(set) var generation = 0
        fileprivate(set) var bundleId: String?
        /// The launched bundle is pending, and its first content hasn't appeared.
        fileprivate(set) var shouldRollback = false
        /// Named only: a view of its runtime was shown, so its launch started.
        fileprivate(set) var isArmed = false
        /// From the launch until 10 seconds after its first content.
        fileprivate(set) var isMonitoring = false
        /// Until first content, or a JavaScript load failure without recovery.
        fileprivate(set) var isAwaitingContent = false
        /// Main only: an in-process recovery reload is on its way.
        fileprivate(set) var recoveryRequested = false
        /// This launch's runtime has a module that tells its JavaScript
        /// thread apart, so its fatals are attributed directly.
        fileprivate(set) var hasResolvedRuntime = false
        /// This launch's first content appeared: its runtime finished loading.
        fileprivate(set) var hasShownContent = false

        init(name: String, markerURL: URL, storage: BundleStorageService) {
            self.name = name
            self.markerURL = markerURL
            self.storage = storage
        }

        /// What a native crash counts against: for main, any launch it
        /// selected as pending; for a named one, only once a view started it.
        fileprivate var crashCountsAgainstLaunch: Bool {
            shouldRollback && (isMain || isArmed)
        }
    }

    enum RecoveryRequest: Equatable {
        case notNeeded
        case alreadyRequested
        case requested(generation: Int, bundleId: String?)
    }

    private let lock = NSRecursiveLock()
    private let sink: HotUpdaterCrashSlotSink
    private var launches: [String: Launch] = [:]
    private var slotNames: [String?] = Array(repeating: nil, count: HotUpdaterRecoveryCoordinator.slotCount)
    private var slotFlags: [Bool] = Array(repeating: false, count: HotUpdaterRecoveryCoordinator.slotCount)
    private var attributedSlot = HotUpdaterRecoveryCoordinator.unattributed
    private var attributedName: String?
    /// The launches `attribute(to:)` stopped, to restart if the process
    /// survives the fatal.
    private var disarmed: [(name: String, generation: Int, bundleId: String, wasStarted: Bool, wasArmed: Bool)] = []
    /// The latest claim: a fatal of another instance can arrive before an
    /// earlier one's handler returns, and only the latest releases them all.
    private var claimGeneration = 0

    init(sink: HotUpdaterCrashSlotSink) {
        self.sink = sink
    }

    // MARK: - Instances

    /// The launch state of `name`, created on first use. An instance keeps
    /// its marker and storage for the life of the process.
    @discardableResult
    func register(name: String, markerURL: URL, storage: BundleStorageService) -> Launch {
        withLock {
            if let launch = launches[name] {
                return launch
            }
            let launch = Launch(name: name, markerURL: markerURL, storage: storage)
            launches[name] = launch
            return launch
        }
    }

    func launch(named name: String) -> Launch? {
        withLock { launches[name] }
    }

    /// The instance an event of `owner`'s runtime belongs to. A view or
    /// runtime that can't be attributed is main's, as it always was.
    func owner(_ owner: String?) -> Launch? {
        withLock {
            if let owner, let launch = launches[owner] {
                return launch
            }
            return launches[HotUpdaterInstanceEnvironment.mainName]
        }
    }

    // MARK: - Launch

    /// Starts watching a launch of `name`; returns its generation.
    @discardableResult
    func startMonitoring(name: String, bundleId: String?, shouldRollback: Bool) -> Int {
        withLock {
            guard let launch = launches[name] else { return 0 }
            launch.generation += 1
            launch.bundleId = bundleId
            launch.shouldRollback = shouldRollback
            launch.isArmed = false
            launch.recoveryRequested = false
            launch.isMonitoring = true
            launch.isAwaitingContent = true
            launch.hasResolvedRuntime = false
            launch.hasShownContent = false
            if launch.isMain {
                assignSlot(to: launch)
            }
            mirror(launch)
            return launch.generation
        }
    }

    /// A view of a named launch's runtime was shown in the foreground: its
    /// launch has started. From now on an unfinished launch rolls back at the
    /// next start, and a native crash counts against it. Main's launch starts
    /// when it is selected, so main is never armed here.
    @discardableResult
    func arm(name: String) -> Bool {
        withLock {
            guard let launch = launches[name],
                  !launch.isMain,
                  launch.isMonitoring,
                  launch.isAwaitingContent,
                  launch.shouldRollback,
                  !launch.isArmed else {
                return false
            }
            launch.isArmed = true
            launch.storage.markLaunchStarted(bundleId: launch.bundleId)
            assignSlot(to: launch)
            mirror(launch)
            return true
        }
    }

    /// First content of `owner`'s runtime, which verifies only that instance's
    /// launch. Returns the verified launch and its generation, whose
    /// monitoring ends after a grace period.
    func contentAppeared(owner: String?) -> (launch: Launch, generation: Int)? {
        withLock {
            guard let launch = self.owner(owner),
                  launch.isMonitoring,
                  launch.isAwaitingContent,
                  !launch.recoveryRequested else {
                return nil
            }
            launch.isAwaitingContent = false
            launch.hasShownContent = true
            launch.storage.markLaunchCompleted(bundleId: launch.bundleId)
            launch.shouldRollback = false
            launch.isArmed = false
            mirror(launch)
            return (launch, launch.generation)
        }
    }

    /// Ends the grace period after first content.
    func finishMonitoring(name: String, generation: Int) {
        withLock {
            guard let launch = launches[name], launch.generation == generation else { return }
            launch.isMonitoring = false
            launch.recoveryRequested = false
            launch.bundleId = nil
            launch.shouldRollback = false
            launch.isArmed = false
            launch.isAwaitingContent = false
            mirror(launch)
        }
    }

    /// A JavaScript load failure that recovery didn't take: the launch's later
    /// content no longer verifies it.
    func stopAwaitingContent(name: String) {
        withLock {
            launches[name]?.isAwaitingContent = false
        }
    }

    func isCurrent(name: String, generation: Int) -> Bool {
        withLock { launches[name]?.generation == generation }
    }

    // MARK: - Main's in-process recovery

    /// Main's fatal before first content reloads it in-process: writes its
    /// marker once, so the reloaded launch rolls back.
    func requestRecovery(name: String) -> RecoveryRequest {
        withLock {
            guard let launch = launches[name], launch.isMonitoring, launch.shouldRollback else {
                return .notNeeded
            }
            if launch.recoveryRequested {
                return .alreadyRequested
            }
            launch.recoveryRequested = true
            writeMarker(launch)
            return .requested(generation: launch.generation, bundleId: launch.bundleId)
        }
    }

    func recoveryReloadFailed(name: String) {
        withLock {
            launches[name]?.recoveryRequested = false
        }
    }

    // MARK: - Crashes

    /// A JavaScript fatal that will crash the process. Attributed to `owner`:
    /// only `owner`'s marker, and the native crash it causes writes no other
    /// slot (see `attribute(to:)`). Unattributed: every unverified launch's.
    /// Returns the claim to release if the process lives on.
    @discardableResult
    func chargeFatal(owner: String?) -> Int? {
        withLock {
            guard let owner, let launch = launches[owner] else {
                chargeUnattributedCrash()
                return nil
            }
            if launch.isMonitoring {
                writeMarker(launch)
            }
            return attribute(to: owner)
        }
    }

    /// The crash about to happen is `owner`'s alone. A native crash it causes
    /// writes no other slot, and the other launches that already started
    /// forget it, so the unfinished-launch rule doesn't roll them back at the
    /// next start either; they stay pending and launch the same bundle again.
    /// Returns the claim to release if the process lives on. A claim made
    /// while an earlier one holds takes over: the launches the earlier one
    /// stopped, this owner's included, stay listed to start again.
    @discardableResult
    func attribute(to owner: String) -> Int? {
        withLock {
            guard launches[owner] != nil else { return nil }
            claimGeneration += 1
            attributedName = owner
            attributedSlot = launches[owner]?.slot ?? Self.attributedWithoutSlot
            sink.attributeCrash(toSlot: attributedSlot)
            for launch in launches.values where launch.name != owner {
                guard launch.isMonitoring, launch.isAwaitingContent, let bundleId = launch.bundleId else {
                    continue
                }
                let wasStarted = launch.storage.clearLaunchStarted(bundleId: bundleId)
                disarmed.append((launch.name, launch.generation, bundleId, wasStarted, launch.isArmed))
                launch.isArmed = false
                mirror(launch)
            }
            return claimGeneration
        }
    }

    /// React Native's default fatal handler can return in a debug build, and
    /// the process lives on: the launches the attribution stopped that are
    /// still unverified start again, so a later crash still counts against
    /// them. Only the latest claim releases: an earlier one's handler that
    /// returns while a later fatal is on its way leaves that one in place.
    func clearAttribution(claim: Int) {
        withLock {
            guard claim == claimGeneration else { return }
            attributedName = nil
            attributedSlot = Self.unattributed
            sink.attributeCrash(toSlot: attributedSlot)
            for entry in disarmed {
                guard let launch = launches[entry.name],
                      launch.generation == entry.generation,
                      launch.isMonitoring,
                      launch.isAwaitingContent,
                      launch.bundleId == entry.bundleId else {
                    continue
                }
                if entry.wasStarted {
                    launch.storage.markLaunchStarted(bundleId: entry.bundleId)
                }
                if entry.wasArmed {
                    launch.isArmed = true
                }
                mirror(launch)
            }
            disarmed = []
        }
    }

    /// The instance a crash in progress was attributed to, if any.
    var attributedOwner: String? {
        withLock { attributedName }
    }

    /// A fatal no runtime claims, which main survives with its in-process
    /// recovery: it may have been a named runtime's, so each named launch it
    /// leaves unverified rolls back at its next start. A launch verified
    /// later in this process ignores its marker.
    func chargeUnverifiedNamedLaunches() {
        withLock {
            for launch in launches.values where !launch.isMain && launch.crashCountsAgainstLaunch {
                writeMarker(launch)
            }
        }
    }

    /// An uncaught native exception: the attributed instance's marker, or
    /// every unverified launch's.
    func chargeUncaughtException() {
        withLock {
            if let attributedName, let launch = launches[attributedName] {
                if launch.isMonitoring {
                    writeMarker(launch)
                }
                return
            }
            chargeUnattributedCrash()
        }
    }

    /// The markers the native signal handler writes now, by the rule in
    /// HotUpdater.mm's `HotUpdaterWriteCrashMarkers`, with whether each asks
    /// for a rollback: main's slot always writes once main launched, as it
    /// always has (`shouldRollback: false` after its first content); a named
    /// slot writes only while its launch is unverified. Only the attributed
    /// slot writes while there is one.
    func nativeCrashMarkers() -> [(slot: Int, shouldRollback: Bool)] {
        withLock {
            (0..<Self.slotCount).compactMap { slot in
                guard slotNames[slot] != nil, slot == Self.mainSlot || slotFlags[slot] else { return nil }
                guard attributedSlot == Self.unattributed || attributedSlot == slot else { return nil }
                return (slot, slotFlags[slot])
            }
        }
    }

    /// The runtime of `name`'s launch now has a module, which attributes its
    /// fatals from here on.
    func runtimeResolved(name: String) {
        withLock {
            launches[name]?.hasResolvedRuntime = true
        }
    }

    /// The owner of a fatal on a JavaScript thread no module claims yet, when
    /// only one launch can have thrown it. Any launch of this process whose
    /// runtime hasn't shown it finished loading may have: it hasn't shown its
    /// first content and, for a named one, its runtime has no module yet.
    /// Main counts until its first content. Whether a launch would roll back
    /// says nothing about whether it finished loading, so a built-in or
    /// retried launch counts too. Only when exactly one may have thrown it,
    /// and that one is a named launch that would roll back, is it that one's;
    /// otherwise nil, and the fatal is unattributed.
    func inferredFatalOwner() -> String? {
        withLock {
            let possibleOwners = launches.values.filter { launch in
                guard launch.generation > 0, !launch.hasShownContent else { return false }
                return launch.isMain || !launch.hasResolvedRuntime
            }
            guard possibleOwners.count == 1,
                  let owner = possibleOwners.first,
                  !owner.isMain,
                  owner.shouldRollback else {
                return nil
            }
            return owner.name
        }
    }

    // MARK: - Private

    private func chargeUnattributedCrash() {
        for launch in launches.values {
            // Main writes while it watches its launch, as it always has; a
            // marker of a verified launch carries `shouldRollback: false`.
            if launch.isMain ? launch.isMonitoring : launch.crashCountsAgainstLaunch {
                writeMarker(launch)
            }
        }
    }

    private func writeMarker(_ launch: Launch) {
        HotUpdaterCrashMarker.write(
            bundleId: launch.bundleId,
            shouldRollback: launch.shouldRollback,
            to: launch.markerURL
        )
    }

    /// Main always has slot 0; a named instance takes the next free slot when
    /// its launch first starts, and keeps it for the process.
    private func assignSlot(to launch: Launch) {
        guard launch.slot == nil else { return }
        let slot: Int?
        if launch.isMain {
            slot = Self.mainSlot
        } else {
            slot = (1..<Self.slotCount).first { slotNames[$0] == nil }
        }
        guard let slot else {
            NSLog("[HotUpdaterRecovery] No native crash slot left for \(launch.name)")
            return
        }
        slotNames[slot] = launch.name
        launch.slot = slot
        try? FileManager.default.createDirectory(
            at: launch.markerURL.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: nil
        )
    }

    private func mirror(_ launch: Launch) {
        guard let slot = launch.slot else { return }
        let flag = launch.crashCountsAgainstLaunch
        slotFlags[slot] = flag
        sink.updateSlot(slot, markerPath: launch.markerURL.path, bundleId: launch.bundleId, shouldRollback: flag)
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

/// Fabric surfaces that started before their runtime could be told apart.
/// A surface starts before its bundle runs, so before the runtime's
/// TurboModule, which is what tells whose runtime it is, exists. Each is
/// kept until that module appears.
final class HotUpdaterPendingSurfaceStarts {
    private struct Entry {
        weak var surface: AnyObject?
        let inForeground: Bool
    }

    private let lock = NSLock()
    private var entries: [Entry] = []

    func add(_ surface: AnyObject, inForeground: Bool) {
        lock.lock()
        entries.append(Entry(surface: surface, inForeground: inForeground))
        lock.unlock()
    }

    /// The surfaces `owner` attributes now, with whether each started in the
    /// foreground; they and the surfaces already gone are forgotten.
    func resolve(_ owner: (AnyObject) -> String?) -> [(name: String, surface: AnyObject, inForeground: Bool)] {
        lock.lock()
        let current = entries
        lock.unlock()

        var resolved: [(name: String, surface: AnyObject, inForeground: Bool)] = []
        var settled: [ObjectIdentifier] = []
        for entry in current {
            guard let surface = entry.surface else { continue }
            if let name = owner(surface) {
                resolved.append((name, surface, entry.inForeground))
                settled.append(ObjectIdentifier(surface))
            }
        }

        lock.lock()
        entries.removeAll { entry in
            guard let surface = entry.surface else { return true }
            return settled.contains(ObjectIdentifier(surface))
        }
        lock.unlock()
        return resolved
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return entries.filter { $0.surface != nil }.count
    }
}

/// The views of one named instance that started while the app was in the
/// background. Its launch starts when the app comes to the foreground, but
/// only if one of them is still shown then: a view stopped or discarded in
/// the meantime leaves the launch unstarted, until a view starts again.
final class HotUpdaterBackgroundViewStarts {
    private struct Entry {
        weak var view: AnyObject?
    }

    private let lock = NSLock()
    private var entries: [Entry] = []

    var isEmpty: Bool {
        lock.lock()
        defer { lock.unlock() }
        return entries.isEmpty
    }

    func add(_ view: AnyObject) {
        lock.lock()
        entries.append(Entry(view: view))
        lock.unlock()
    }

    /// Whether a view that started in the background is still shown, by
    /// `isShown`; forgets them all either way.
    func takeAnyShown(_ isShown: (AnyObject) -> Bool) -> Bool {
        lock.lock()
        let views = entries.compactMap(\.view)
        entries = []
        lock.unlock()
        return views.contains { isShown($0) }
    }

    func removeAll() {
        lock.lock()
        entries = []
        lock.unlock()
    }
}

/// The instance whose bundle a JavaScript error was thrown in, read from its
/// stack: `RCTJSStackTraceKey`'s frames, `{"file", "methodName",
/// "lineNumber", "column"}`, whose `file` is the source URL the runtime
/// evaluated (a `file://` URL or path of a staged bundle, the `main.jsbundle`
/// embedded in a framework, or a development server URL). This attributes a
/// fatal that no runtime module claims, such as one thrown while two
/// instances' bundles both still evaluate.
enum HotUpdaterJSStackOwner {
    /// The bundle locations of the frames; frames without one, such as
    /// `unknown` or native ones, are skipped.
    static func bundleURLs(in stack: Any?) -> [URL] {
        guard let frames = stack as? [Any] else { return [] }
        return frames.compactMap { frame in
            ((frame as? [String: Any])?["file"] as? String).flatMap(bundleURL)
        }
    }

    static func bundleURL(_ file: String) -> URL? {
        var location = file.trimmingCharacters(in: .whitespaces)
        // Hermes prints bytecode locations as "address at <url>".
        let bytecodePrefix = "address at "
        if location.hasPrefix(bytecodePrefix) {
            location.removeFirst(bytecodePrefix.count)
        }
        if location.hasPrefix("/") {
            return URL(fileURLWithPath: location)
        }
        guard let url = URL(string: location),
              let scheme = url.scheme?.lowercased(),
              ["file", "http", "https"].contains(scheme) else {
            return nil
        }
        return url
    }

    /// The one instance every frame with a bundle location belongs to, by
    /// `resolve` (the C2 router); nil when no frame has one or they name
    /// more than one instance.
    static func owner(of stack: Any?, resolve: (URL) -> String) -> String? {
        let names = Set(bundleURLs(in: stack).map(resolve))
        return names.count == 1 ? names.first : nil
    }
}

