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
/// back at the next start. After its watch ends, main still writes its marker
/// on a crash of its own or of the process, without rollback: its next launch
/// then checks for a fix natively, since this bundle's JavaScript may crash
/// before it can.
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
        /// The bundle URL this launch handed out to React Native.
        fileprivate(set) var launchURL: URL?
        /// The bundle this launch selected, kept after its monitoring ends.
        fileprivate(set) var selectedBundleId: String?

        init(name: String, markerURL: URL, storage: BundleStorageService) {
            self.name = name
            self.markerURL = markerURL
            self.storage = storage
        }

        /// What a native crash counts against: for main, any launch it
        /// selected as pending; for a named one, only once a view started it.
        fileprivate var crashCountsAgainstLaunch: Bool {
            shouldRollback && (isMain || isArmed || isCharged)
        }
        /// Named only: a crash of its own was charged to this launch, so its
        /// native slot asks for rollback even if no view of it showed.
        fileprivate(set) var isCharged = false
        /// The directory of `markerURL` was created.
        fileprivate var hasMarkerDirectory = false

        /// Main only, outside development builds: a crash after its watch
        /// ended still writes its marker (`recordsCrashesAfterWatch`).
        fileprivate var recordsAfterWatch = false

        /// Whether a crash now writes this launch's marker: while it is
        /// watched, and for main for the rest of the process once it
        /// launched, so the next launch knows to check for a fix
        /// (`HotUpdaterPostCrashUpdateCheck`).
        fileprivate var recordsCrashes: Bool {
            isMonitoring || (recordsAfterWatch && generation > 0)
        }
        /// The bundle a marker of this launch names: main's selected bundle
        /// once its watch ended, which cleared `bundleId`.
        fileprivate var markerBundleId: String? {
            recordsAfterWatch && !isMonitoring ? selectedBundleId : bundleId
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
    /// The launch of `attributedName` the claim belongs to: a later launch
    /// of the same instance, started before the process ends, is not it.
    private var attributedGeneration: Int?
    /// The launches `attribute(to:)` stopped, to restart if the process
    /// survives the fatal.
    private var disarmed: [(name: String, generation: Int, bundleId: String, wasStarted: Bool, wasArmed: Bool)] = []
    /// The latest claim: a fatal of another instance can arrive before an
    /// earlier one's handler returns, and only the latest releases them all.
    private var claimGeneration = 0
    /// Every claim whose fatal handler hasn't returned, oldest first. The
    /// latest is the one published: a crash now is that fatal's.
    private var activeClaims: [Claim] = []

    private struct Claim {
        let id: Int
        let name: String?
        let generation: Int?
        var slot: Int
        let isEarlierRuntime: Bool
        /// A load failure's claim, waiting since then for the fatal React
        /// Native reports next, which takes it over.
        var awaitingFatalSince: TimeInterval?
        /// When the claim was made, for the fail-safe.
        var startedAt: TimeInterval = 0
        /// An earlier runtime's claim: the instance it belonged to and the
        /// bundle it ran, which tell its follow-up fatal apart.
        var earlierRuntimeOwner: String?
        var earlierRuntimeURLKey: String?
    }

    /// How long a claim may stay active. A fatal handler that blocks without
    /// ending the process (a custom one) would otherwise keep every other
    /// launch stopped and every later crash attributed to it.
    static let claimFailSafe: TimeInterval = 60
    /// Called when a claim is made, so the host schedules
    /// `releaseStaleClaims()` after `claimFailSafe`; called under the lock,
    /// so it must only schedule. Set once, before any launch.
    var onClaimStarted: (() -> Void)?

    /// How long a load failure's claim waits for its fatal. React Native
    /// reports it right after the load failure; if none comes (a
    /// development build that shows the error instead), the claim must not
    /// keep the other launches stopped for the rest of the process.
    static let loadFailureClaimBound: TimeInterval = 10
    /// Load failures no runtime claimed whose fatal hasn't come yet: several
    /// runtimes can fail close together, and each fatal that no runtime
    /// claims takes one. Each lives until `loadFailureClaimBound` passes, or
    /// until every named launch it was deferred for is known not to have
    /// failed (it launched again, its runtime resolved, or it showed
    /// content): a fatal that never came must not turn a later, unrelated
    /// one into a load failure.
    private var deferredLoadFailures: [DeferredLoadFailure] = []

    /// A load failure no runtime claimed, waiting for its fatal.
    struct DeferredLoadFailure {
        let deferredAt: TimeInterval
        /// The launches that may have failed when it was reported, by
        /// generation: the unresolved named ones, and main until its first
        /// content. Only these can be its owner, or be charged for it.
        let possibleOwners: [String: Int]
    }
    /// Called with a named instance whose own fatal or load failure marked
    /// its launch for rollback, outside the lock. If the process lives on (a
    /// development build, or a fatal handler that returns) and the host
    /// starts the instance again, its next launch must be prepared anew, so
    /// it consumes the marker and rolls back. Set once, before any launch.
    var onRollbackCharged: ((String) -> Void)?
    /// Named instances a charge in progress marked for rollback.
    private var rolledBackNames: [String] = []
    /// The current claim is of a runtime no current launch runs.
    private var isEarlierRuntimeClaim = false
    /// First content no runtime claims yet, held while a named launch's
    /// runtime may still turn out to be its own.
    private var heldContent: [HeldContent] = []
    /// Seconds, monotonic.
    private let now: () -> TimeInterval

    private struct HeldContent {
        weak var view: AnyObject?
        let heldAt: TimeInterval
        /// Each instance's launch when the content appeared: content of an
        /// earlier launch never verifies a later one.
        let generations: [String: Int]
        /// Main was verified by it after the bound; kept so a named runtime
        /// that resolves later still finds its own content.
        var creditedToMain = false
    }

    /// How long content no runtime claims waits for a named runtime's module
    /// before it is main's. A named runtime whose JavaScript never loads Hot
    /// Updater never resolves; without a bound, main's launch would never be
    /// verified and the next start would roll it back.
    static let heldContentBound: TimeInterval = 10

    /// Main's crashes after its watch ended write its marker. A development
    /// build turns this off: a RedBox is no reason to check for a fix.
    private let recordsCrashesAfterWatch: Bool

    init(
        sink: HotUpdaterCrashSlotSink,
        now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        recordsCrashesAfterWatch: Bool = true
    ) {
        self.sink = sink
        self.now = now
        self.recordsCrashesAfterWatch = recordsCrashesAfterWatch
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
            launch.recordsAfterWatch = launch.isMain && recordsCrashesAfterWatch
            launches[name] = launch
            return launch
        }
    }

    /// Whether this process has created a named instance.
    var hasNamedInstance: Bool {
        withLock { hasNamedInstanceUnlocked }
    }

    private var hasNamedInstanceUnlocked: Bool {
        launches.values.contains { !$0.isMain }
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
    func startMonitoring(name: String, bundleId: String?, shouldRollback: Bool, launchURL: URL? = nil) -> Int {
        withLock {
            guard let launch = launches[name] else { return 0 }
            launch.generation += 1
            // A load failure of this instance whose fatal never came: the
            // instance starts again, so that crash is over.
            // An earlier runtime's claim keeps its instance in earlierRuntimeOwner.
            for claim in activeClaims
            where (claim.name ?? claim.earlierRuntimeOwner) == name && claim.awaitingFatalSince != nil {
                releaseClaim(claim.id)
            }
            if activeClaims.contains(where: { $0.name == name }) {
                // A claimed crash is the previous launch's: its marker is
                // written, and the native crash it causes writes no slot,
                // so this launch's state never stands in for it.
                for index in activeClaims.indices where activeClaims[index].name == name {
                    activeClaims[index].slot = Self.attributedWithoutSlot
                }
                publishLatestClaim()
            }
            launch.launchURL = launchURL
            launch.bundleId = bundleId
            launch.selectedBundleId = bundleId
            launch.shouldRollback = shouldRollback
            launch.isArmed = false
            launch.recoveryRequested = false
            launch.isMonitoring = true
            launch.isAwaitingContent = true
            launch.hasResolvedRuntime = false
            launch.hasShownContent = false
            launch.isCharged = false
            // Every launch publishes its slot now (a named one not asking
            // for rollback yet), so starting or charging it later only flips
            // the flag in place, which a signal always reads whole.
            assignSlot(to: launch)
            mirror(launch)
            return launch.generation
        }
    }

    /// The generation of `name`'s launch when a new preparation selected the
    /// same bundle at the same URL: that launch continues, with its
    /// generation and monitoring, rather than a new one starting. A named
    /// instance prepares again only after a channel reset, a built-in
    /// commit, or its own rollback, each of which selects another bundle
    /// (or the built-in, never pending), and it never reloads; so two
    /// launches of one name never share a bundle, which is what tells their
    /// runtimes apart. Main, which reloads its launch in place, always
    /// starts a new one.
    func continuingLaunch(name: String, bundleId: String?, launchURL: URL?) -> Int? {
        withLock {
            guard let launch = launches[name], !launch.isMain, launch.generation > 0,
                  launch.selectedBundleId == bundleId else {
                return nil
            }
            let sameURL: Bool
            switch (launch.launchURL, launchURL) {
            case (nil, nil):
                sameURL = true
            case let (current?, new?):
                sameURL = HotUpdaterInstanceRouter.comparableKey(current) == HotUpdaterInstanceRouter.comparableKey(new)
            default:
                sameURL = false
            }
            return sameURL ? launch.generation : nil
        }
    }

    /// A view of a named launch's runtime was shown in the foreground: its
    /// launch has started. From now on an unfinished launch rolls back at the
    /// next start, and a native crash counts against it. Main's launch starts
    /// when it is selected, so main is never armed here.
    /// `generation`, when given, is the launch the view started in: a view of
    /// an earlier launch never starts a later one.
    @discardableResult
    ///
    /// `runtimeBundleURL` is the bundle the view's runtime runs, when known:
    /// a view of a runtime of an earlier launch, such as one still torn down
    /// while its host is recreated, never starts the current launch.
    func arm(name: String, generation: Int? = nil, runtimeBundleURL: URL? = nil) -> Bool {
        withLock {
            guard let launch = launches[name],
                  generation == nil || launch.generation == generation,
                  isCurrentRuntime(of: launch, runtimeBundleURL: runtimeBundleURL),
                  !launch.isMain,
                  launch.isMonitoring,
                  launch.isAwaitingContent,
                  launch.shouldRollback,
                  !launch.isArmed else {
                return false
            }
            return markStarted(launch)
        }
    }

    /// Main's launch of `generation` is in the foreground, so it started:
    /// an unfinished launch rolls back at the next start, as it always did.
    /// Refused for a later launch or once its content appeared. Called after
    /// `startMonitoring` registered the launch, so a claim of another
    /// instance's fatal sees it.
    @discardableResult
    func markMainLaunchStarted(generation: Int) -> Bool {
        withLock {
            guard let launch = launches[HotUpdaterInstanceEnvironment.mainName],
                  launch.generation == generation,
                  launch.isMonitoring,
                  !launch.hasShownContent,
                  launch.shouldRollback,
                  !launch.isArmed else {
                return false
            }
            return markStarted(launch)
        }
    }

    /// Marks `launch` started, unless another instance's fatal holds a claim
    /// that stopped every other launch: then it starts when that claim is
    /// released, if the process lives on.
    private func markStarted(_ launch: Launch) -> Bool {
        let isClaimOwner = attributedName == launch.name && attributedGeneration == launch.generation
        let claimHeld = !activeClaims.isEmpty && !isClaimOwner
        if claimHeld, let bundleId = launch.bundleId {
            disarmed.append((launch.name, launch.generation, bundleId, true, true))
            return false
        }
        assignSlot(to: launch)
        guard launch.slot != nil else {
            // No native slot left: nothing asks for rollback if a signal
            // comes, so the start is persisted before the launch counts as
            // armed, and the unfinished-launch rule covers it.
            launch.storage.markLaunchStarted(bundleId: launch.bundleId)
            launch.isArmed = true
            return true
        }
        // The slot first, then storage.
        launch.isArmed = true
        mirror(launch)
        launch.storage.markLaunchStarted(bundleId: launch.bundleId)
        return true
    }

    /// First content of `owner`'s runtime, which verifies only that instance's
    /// launch. Returns the verified launch and its generation, whose
    /// monitoring ends after a grace period.
    /// `generation`, when given, is the launch the content appeared in.
    /// `runtimeBundleURL` is the bundle the view's runtime runs, when known:
    /// content of a runtime of an earlier launch verifies no launch.
    /// `runtimeGeneration` is the launch the view's runtime was recorded
    /// for (`HotUpdaterRuntimeLaunches`), when known: it tells a runtime of
    /// an earlier launch apart even with the same bundle.
    func contentAppeared(
        owner: String?,
        generation: Int? = nil,
        runtimeBundleURL: URL? = nil,
        runtimeGeneration: Int? = nil
    ) -> (launch: Launch, generation: Int)? {
        withLock {
            guard let launch = self.owner(owner),
                  generation == nil || launch.generation == generation,
                  isCurrentRuntime(of: launch, runtimeBundleURL: runtimeBundleURL, runtimeGeneration: runtimeGeneration),
                  launch.isMonitoring,
                  launch.isAwaitingContent,
                  !launch.recoveryRequested else {
                return nil
            }
            launch.isAwaitingContent = false
            launch.hasShownContent = true
            // The slot stops asking for rollback before the verification is
            // written: a signal while it is written leaves no rollback marker
            // for a launch that rendered.
            launch.shouldRollback = false
            launch.isArmed = false
            mirror(launch)
            launch.storage.markLaunchCompleted(bundleId: launch.bundleId)
            return (launch, launch.generation)
        }
    }

    /// First content whose view no runtime claims yet. In a process where
    /// every named launch's runtime already has a module, it is main's, as it
    /// always was (returns false). Otherwise a named runtime that renders
    /// before its module exists may have shown it, so it is held (returns
    /// true) until `releaseHeldContent` can tell whose it is, for at most
    /// `heldContentBound` seconds; check again then.
    func holdUnclaimedContent(_ view: AnyObject) -> Bool {
        withLock {
            guard hasUnresolvedNamedLaunch else { return false }
            heldContent.append(HeldContent(view: view, heldAt: now(), generations: currentGenerations))
            return true
        }
    }

    /// Credits held content: each view `owner` now attributes verifies that
    /// instance. Content still unclaimed `heldContentBound` seconds after it
    /// appeared is main's (main may be verified a little early, never left
    /// unverified), and so is all of it once no named launch's runtime is
    /// left unresolved. Content credited to main after the bound stays
    /// known: a named runtime that resolves later verifies its launch with
    /// it, rather than starting a launch whose content already appeared.
    /// Call when a runtime resolves, a named launch stops waiting for
    /// content, or the bound passes. Returns the launches it verified.
    func releaseHeldContent(
        owner: (AnyObject) -> String?,
        runtimeBundleURL: (AnyObject) -> URL? = { _ in nil },
        runtimeGeneration: (AnyObject) -> Int? = { _ in nil }
    ) -> [(launch: Launch, generation: Int)] {
        withLock {
            guard !heldContent.isEmpty else { return [] }
            var verified: [(launch: Launch, generation: Int)] = []
            var kept: [HeldContent] = []
            // Main's launches the content credited to main appeared in.
            var mainGenerations: Set<Int> = []
            let mainName = HotUpdaterInstanceEnvironment.mainName
            let currentTime = self.now()
            for var held in heldContent {
                if let view = held.view, let name = owner(view) {
                    // The launch its runtime was recorded for, else the one
                    // current when the content appeared.
                    if let generation = runtimeGeneration(view) ?? held.generations[name],
                       let launch = contentAppeared(
                           owner: name,
                           generation: generation,
                           runtimeBundleURL: runtimeBundleURL(view)
                       ) {
                        verified.append(launch)
                    }
                    continue
                }
                // A view already gone can't be attributed any more.
                if held.view == nil, held.creditedToMain {
                    continue
                }
                if !held.creditedToMain, currentTime - held.heldAt >= Self.heldContentBound {
                    held.creditedToMain = true
                    held.generations[mainName].map { _ = mainGenerations.insert($0) }
                }
                kept.append(held)
            }
            if !hasUnresolvedNamedLaunch {
                // Nothing left that could claim it.
                for held in kept where !held.creditedToMain {
                    held.generations[mainName].map { _ = mainGenerations.insert($0) }
                }
                kept = []
            }
            heldContent = kept
            if let generation = launches[mainName]?.generation,
               mainGenerations.contains(generation),
               let launch = contentAppeared(owner: nil, generation: generation) {
                verified.append(launch)
            }
            return verified
        }
    }

    /// The current launch generation of every instance. Callers on other
    /// threads keep it with what they schedule, so a later callback acts
    /// only on the launch it was meant for.
    func generations() -> [String: Int] {
        withLock { currentGenerations }
    }

    private var currentGenerations: [String: Int] {
        launches.mapValues(\.generation)
    }

    /// A JavaScript load failure nothing attributes, while a named launch's
    /// runtime may still be the one that failed: main must not recover
    /// in-process for it. Returns true, and the fatal React Native reports
    /// next (`takeDeferredLoadFailure`) decides whose it is. With only main,
    /// or every named runtime known, false: it is main's, as it always was.
    func deferUnclaimedLoadFailure() -> Bool {
        withLock {
            guard hasUnresolvedNamedLaunch else { return false }
            let possibleOwners = possibleFatalOwners
            deferredLoadFailures.append(DeferredLoadFailure(
                deferredAt: now(),
                possibleOwners: Dictionary(uniqueKeysWithValues: possibleOwners.map { ($0.name, $0.generation) })
            ))
            return true
        }
    }

    /// The fatal of a load failure no runtime claimed, which crashes the
    /// process: every launch whose runtime may be the one that failed is
    /// charged, a named one whose view hasn't shown yet included, so the
    /// failing bundle rolls back at its next start whoever it was.
    ///
    /// Returns the claim to release once the forwarded fatal's handler
    /// returns: while it holds, every launch that can't have failed is
    /// stopped, so a native crash or uncaught exception the fatal causes
    /// writes only the possible owners' markers.
    ///
    /// `deferred`, the load failure the fatal follows, limits the charge to
    /// the launches that could have failed when it was reported: a runtime
    /// started since then is not charged.
    @discardableResult
    func chargeUnclaimedLoadFailure(_ deferred: DeferredLoadFailure? = nil) -> Int {
        charging {
            var owners = possibleFatalOwners
            if let deferred {
                owners = owners.filter { deferred.possibleOwners[$0.name] == $0.generation }
            }
            // As for an attributed fatal: their slots ask for rollback, the
            // others stop, then the marker files are written.
            for launch in owners where launch.isMonitoring {
                prepareCharge(launch)
            }
            // Slotless owners' markers first: nothing native writes them.
            for launch in owners where launch.isMonitoring && launch.slot == nil {
                writeMarker(launch)
            }
            claimGeneration += 1
            appendClaim(Claim(
                id: claimGeneration,
                name: nil,
                generation: nil,
                slot: Self.unattributed,
                isEarlierRuntime: false
            ))
            publishLatestClaim()
            let ownerNames = Set(owners.map(\.name))
            disarm(launches.values.filter { !ownerNames.contains($0.name) })
            for launch in owners where launch.isMonitoring && launch.slot != nil {
                writeMarker(launch)
            }
            return claimGeneration
        }
    }

    /// The launches of this process whose runtime hasn't shown it finished
    /// loading: no first content yet and, for a named one, no module.
    private var possibleFatalOwners: [Launch] {
        launches.values.filter { launch in
            guard launch.generation > 0, !launch.hasShownContent else { return false }
            return launch.isMain || !launch.hasResolvedRuntime
        }
    }

    /// Whether the fatal now reported follows a deferred load failure; the
    /// next one doesn't. (`takeDeferredLoadFailure(for:owner:)` with no owner.)
    func takeDeferredLoadFailure() -> Bool {
        takeDeferredLoadFailure(for: .none) != nil
    }

    /// Takes the oldest live deferred load failure `matches` accepts.
    private func takeLiveDeferredLoadFailure(where matches: (DeferredLoadFailure) -> Bool) -> DeferredLoadFailure? {
        let currentTime = now()
        // Live while one of its launches could still have failed: main
        // until that launch's first content, a named one while its runtime
        // is unresolved. With only main left, it is main's failure.
        deferredLoadFailures.removeAll { deferred in
            currentTime - deferred.deferredAt >= Self.loadFailureClaimBound
                || !deferred.possibleOwners.contains { name, generation in
                    guard let launch = launches[name], launch.generation == generation else { return false }
                    return launch.isMain
                        ? launch.isMonitoring && !launch.hasShownContent
                        : isUnresolvedNamedLaunch(launch)
                }
        }
        guard let index = deferredLoadFailures.firstIndex(where: matches) else { return nil }
        return deferredLoadFailures.remove(at: index)
    }

    /// A fatal's owner, by the first that names one: the runtime's own
    /// module, the bundles in its JavaScript stack, the claim of a crash
    /// already going on (a follow-up fatal with nothing of its own to tell),
    /// then inference. A module-less runtime's fatal with a stack of its own
    /// is its own, even while another runtime's fatal holds a claim.
    static func fatalOwner(
        module: (name: String, runtimeBundleURL: URL?)?,
        stack: (name: String, runtimeBundleURL: URL?)?,
        claim: String?,
        inference: () -> String?
    ) -> (name: String, runtimeBundleURL: URL?, attribution: FatalAttribution)? {
        if let module {
            return (module.name, module.runtimeBundleURL, .runtimeModule)
        }
        if let stack {
            return (stack.name, stack.runtimeBundleURL, .stack)
        }
        if let claim {
            return (claim, nil, .claim)
        }
        return inference().map { ($0, nil, .inference) }
    }

    /// How a fatal's owner was found.
    enum FatalAttribution {
        /// The runtime's own module: a runtime that has one never deferred
        /// a load failure.
        case runtimeModule
        /// The claim of a crash already going on.
        case claim
        /// The bundles in its JavaScript stack, or the only launch that may
        /// have thrown it: how a module-less runtime's fatal, the kind that
        /// follows a deferred load failure, is told apart.
        case stack
        case inference
        /// Nothing: only the deferred path decides, unless an earlier
        /// runtime's claim already accounts for it.
        case none
    }

    /// The deferred load failure the fatal now reported follows, taken so
    /// no later fatal takes it, or nil. A fatal attributed by its stack or by
    /// inference to `owner` takes one only if `owner`'s current launch could
    /// have failed when it was reported; an unattributed fatal takes the
    /// oldest live one. A runtime with a module, or a claimed crash, never
    /// deferred one.
    @discardableResult
    func takeDeferredLoadFailure(for attribution: FatalAttribution, owner: String? = nil) -> DeferredLoadFailure? {
        withLock {
            switch attribution {
            case .runtimeModule, .claim:
                return nil
            case .none where isEarlierRuntimeClaim:
                return nil
            case .stack, .inference:
                guard let owner, let generation = launches[owner]?.generation else { return nil }
                return takeLiveDeferredLoadFailure { $0.possibleOwners[owner] == generation }
            case .none:
                return takeLiveDeferredLoadFailure { _ in true }
            }
        }
    }

    /// A named launch of this process still waiting for content whose
    /// runtime has no module yet.
    private var hasUnresolvedNamedLaunch: Bool {
        launches.values.contains(where: isUnresolvedNamedLaunch)
    }

    private func isUnresolvedNamedLaunch(_ launch: Launch) -> Bool {
        !launch.isMain && launch.isMonitoring && launch.isAwaitingContent && !launch.hasResolvedRuntime
    }

    /// Ends the grace period after first content. Main's crashes are still
    /// recorded afterwards, without rollback, naming the bundle it runs.
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
    /// `generation`, when given, is the launch whose load failed; a later
    /// launch keeps waiting for its own content.
    func stopAwaitingContent(name: String, generation: Int? = nil) {
        withLock {
            guard let launch = launches[name], generation == nil || launch.generation == generation else { return }
            launch.isAwaitingContent = false
        }
    }

    /// The generation of `name`'s launch if it still waits for its first
    /// content, read under the lock every transition takes.
    func awaitingContentGeneration(name: String) -> Int? {
        withLock {
            guard let launch = launches[name], launch.isMonitoring, launch.isAwaitingContent else { return nil }
            return launch.generation
        }
    }

    func isCurrent(name: String, generation: Int) -> Bool {
        withLock { launches[name]?.generation == generation }
    }

    // MARK: - Main's in-process recovery

    /// Main's fatal before first content reloads it in-process: writes its
    /// marker once, so the reloaded launch rolls back.
    ///
    /// Not with a named instance in the process: React Native reloads every
    /// host at once, and named instances apply rollbacks at their next start
    /// only. Main's fatal then takes its course, charged to main, which rolls
    /// back at its next start or next same-process launch.
    func requestRecovery(name: String) -> RecoveryRequest {
        charging {
            guard let launch = launches[name], launch.isMonitoring, launch.shouldRollback,
                  !(launch.isMain && hasNamedInstanceUnlocked) else {
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

    /// The recovery reload of `generation` didn't start; a later launch's
    /// own request is left alone.
    func recoveryReloadFailed(name: String, generation: Int) {
        withLock {
            guard let launch = launches[name], launch.generation == generation else { return }
            launch.recoveryRequested = false
        }
    }

    // MARK: - Crashes

    /// A JavaScript fatal that will crash the process. Attributed to `owner`:
    /// only `owner`'s marker, and the native crash it causes writes no other
    /// slot (see `attribute(to:)`). Unattributed: every unverified launch's.
    /// Returns the claim to release if the process lives on.
    @discardableResult
    ///
    /// `runtimeBundleURL` is the bundle the failing runtime runs, when known.
    /// A named instance's runtime of an earlier launch, still being torn down
    /// after a later launch started, runs another bundle: its error charges
    /// no launch at all (see `attributeToEarlierRuntime`).
    ///
    /// `runtimeGeneration`, the launch the failing runtime was recorded for,
    /// tells a runtime of an earlier launch apart even with the same bundle.
    func chargeFatal(owner: String?, runtimeBundleURL: URL? = nil, runtimeGeneration: Int? = nil) -> Int? {
        charging {
            guard let owner, let launch = launches[owner] else {
                chargeUnattributedCrash()
                return nil
            }
            let isCurrent = isCurrentRuntime(
                of: launch,
                runtimeBundleURL: runtimeBundleURL,
                runtimeGeneration: runtimeGeneration
            )
            // The fatal of a load failure: the same crash, so the load
            // failure's claim is its claim, found among every claim (another
            // runtime's may have come in between). For this launch, by its
            // generation; for an earlier runtime of this instance, by the
            // bundle it ran when both are known.
            let urlKey = runtimeBundleURL.map(HotUpdaterInstanceRouter.comparableKey)
            if let index = activeClaims.firstIndex(where: { claim in
                guard claim.awaitingFatalSince != nil else { return false }
                if claim.isEarlierRuntime {
                    return !isCurrent
                        && claim.earlierRuntimeOwner == owner
                        && (urlKey == nil || claim.earlierRuntimeURLKey == nil || claim.earlierRuntimeURLKey == urlKey)
                }
                return isCurrent && claim.name == owner && claim.generation == launch.generation
            }) {
                activeClaims[index].awaitingFatalSince = nil
                return activeClaims[index].id
            }
            guard isCurrent else {
                return attributeToEarlierRuntime(owner: owner, urlKey: urlKey)
            }
            // The claimed crash going on, after its instance started a later
            // launch: still the earlier launch's.
            if runtimeBundleURL == nil, attributedName == owner, attributedGeneration != launch.generation {
                return attributeToEarlierRuntime(owner: owner, urlKey: nil)
            }
            // Its slot asks for rollback, then the crash is published as its,
            // then the marker file is written: a signal at any point writes
            // its slot alone (unless every slot is taken).
            if launch.isMonitoring {
                prepareCharge(launch)
            }
            // Without a slot nothing native writes its marker: it is written
            // before the attribution, which then stops every other slot.
            let markerFirst = launch.isMonitoring && launch.slot == nil
            if markerFirst {
                writeMarker(launch)
            }
            let claim = attribute(to: owner)
            // Main's marker is written after its watch ended too, without
            // rollback.
            if launch.recordsCrashes, !markerFirst {
                writeMarker(launch)
            }
            return claim
        }
    }

    /// A load failure of `owner`'s runtime, which React Native follows with
    /// a fatal: charged as `chargeFatal` does, and its claim kept for that
    /// fatal, which takes it over and releases it when its handler returns.
    /// Without a fatal it is released when the instance launches again or
    /// after `loadFailureClaimBound` (`releaseExpiredLoadFailureClaims`).
    @discardableResult
    func chargeLoadFailure(owner: String, runtimeBundleURL: URL? = nil, runtimeGeneration: Int? = nil) -> Int? {
        let claim = chargeFatal(owner: owner, runtimeBundleURL: runtimeBundleURL, runtimeGeneration: runtimeGeneration)
        withLock {
            if let claim, let index = activeClaims.firstIndex(where: { $0.id == claim }) {
                activeClaims[index].awaitingFatalSince = now()
            }
        }
        return claim
    }

    /// Releases the load failures' claims whose fatal hasn't come within
    /// `loadFailureClaimBound`.
    func releaseExpiredLoadFailureClaims() {
        withLock {
            let currentTime = now()
            for claim in activeClaims {
                if let since = claim.awaitingFatalSince, currentTime - since >= Self.loadFailureClaimBound {
                    releaseClaim(claim.id)
                }
            }
        }
    }

    /// The number of claims still active, for tests.
    var activeClaimCount: Int {
        withLock { activeClaims.count }
    }

    /// The first step of charging `launch` with the crash under way: its
    /// native slot asks for rollback (a named launch takes a free slot if it
    /// has none), so a signal before or while its marker file is written
    /// still leaves a marker. The caller publishes the attribution, then
    /// writes the marker.
    private func prepareCharge(_ launch: Launch) {
        if !launch.isMain, launch.shouldRollback {
            launch.isCharged = true
            assignSlot(to: launch)
            mirror(launch)
        }
    }

    /// Whether a runtime that runs `runtimeBundleURL` is `name`'s current
    /// launch: false only for a named instance whose launch handed out
    /// another bundle. Main, and an unknown URL, count as current.
    /// `runtimeGeneration`, when known, decides instead: the runtime runs
    /// the current launch only if it was recorded for it.
    func isCurrentRuntime(name: String, runtimeBundleURL: URL?, runtimeGeneration: Int? = nil) -> Bool {
        withLock {
            guard let launch = launches[name] else { return true }
            return isCurrentRuntime(of: launch, runtimeBundleURL: runtimeBundleURL, runtimeGeneration: runtimeGeneration)
        }
    }

    /// Main's runtime always counts as current, as it always has.
    private func isCurrentRuntime(of launch: Launch, runtimeBundleURL: URL?, runtimeGeneration: Int? = nil) -> Bool {
        guard !launch.isMain else { return true }
        if let runtimeGeneration {
            return runtimeGeneration == launch.generation
        }
        guard let runtimeBundleURL, let launchURL = launch.launchURL else {
            return true
        }
        return HotUpdaterInstanceRouter.comparableKey(runtimeBundleURL)
            == HotUpdaterInstanceRouter.comparableKey(launchURL)
    }

    /// The crash about to happen comes from a runtime no current launch runs:
    /// no marker, no native slot, and every launch that started forgets it,
    /// so no current launch is rolled back for it. Returns the claim, as
    /// `attribute(to:)` does.
    private func attributeToEarlierRuntime(owner: String, urlKey: String?) -> Int {
        claimGeneration += 1
        appendClaim(Claim(
            id: claimGeneration,
            name: nil,
            generation: nil,
            slot: Self.attributedWithoutSlot,
            isEarlierRuntime: true,
            earlierRuntimeOwner: owner,
            earlierRuntimeURLKey: urlKey
        ))
        publishLatestClaim()
        disarm(launches.values)
        return claimGeneration
    }

    private func appendClaim(_ claim: Claim) {
        var claim = claim
        claim.startedAt = now()
        activeClaims.append(claim)
        onClaimStarted?()
    }

    /// Releases every claim older than `claimFailSafe`, the way a returning
    /// fatal handler would.
    func releaseStaleClaims() {
        withLock {
            let currentTime = now()
            for claim in activeClaims where currentTime - claim.startedAt >= Self.claimFailSafe {
                releaseClaim(claim.id)
            }
        }
    }

    /// Publishes the latest active claim, or no attribution without one.
    private func publishLatestClaim() {
        let latest = activeClaims.last
        attributedName = latest?.name
        attributedGeneration = latest?.generation
        isEarlierRuntimeClaim = latest?.isEarlierRuntime ?? false
        attributedSlot = latest?.slot ?? Self.unattributed
        sink.attributeCrash(toSlot: attributedSlot)
    }

    /// The claim of an earlier runtime's crash in progress, if any: a fatal
    /// that follows it unattributed, such as RCTInstance's after a load
    /// failure, belongs to that runtime too.
    var earlierRuntimeClaim: Int? {
        withLock { activeClaims.last.flatMap { $0.isEarlierRuntime ? $0.id : nil } }
    }

    private func disarm<Launches: Sequence>(_ launches: Launches) where Launches.Element == Launch {
        for launch in launches {
            guard launch.isMonitoring, launch.isAwaitingContent, let bundleId = launch.bundleId else {
                continue
            }
            // A launch charged earlier counts as started too.
            let wasArmed = launch.isArmed || launch.isCharged
            launch.isArmed = false
            launch.isCharged = false
            // Its slot stops asking for rollback before its storage is
            // written.
            mirror(launch)
            let wasStarted = launch.storage.clearLaunchStarted(bundleId: bundleId)
            disarmed.append((launch.name, launch.generation, bundleId, wasStarted, wasArmed))
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
            guard let launch = launches[owner] else { return nil }
            claimGeneration += 1
            appendClaim(Claim(
                id: claimGeneration,
                name: owner,
                generation: launch.generation,
                slot: launch.slot ?? Self.attributedWithoutSlot,
                isEarlierRuntime: false
            ))
            publishLatestClaim()
            disarm(launches.values.filter { $0.name != owner })
            return claimGeneration
        }
    }

    /// React Native's default fatal handler can return in a debug build, and
    /// the process lives on: the launches the attribution stopped that are
    /// still unverified start again, so a later crash still counts against
    /// them. Fatals overlap: a handler that returns removes only its own
    /// claim, and the latest one still active is published again; only the
    /// last one's return releases the launches every claim stopped.
    func clearAttribution(claim: Int) {
        withLock {
            releaseClaim(claim)
        }
    }

    private func releaseClaim(_ claim: Int) {
        guard let index = activeClaims.firstIndex(where: { $0.id == claim }) else { return }
        activeClaims.remove(at: index)
        publishLatestClaim()
        guard activeClaims.isEmpty else { return }
        for entry in disarmed {
            guard let launch = launches[entry.name],
                  launch.generation == entry.generation,
                  launch.isMonitoring,
                  !launch.hasShownContent,
                  launch.bundleId == entry.bundleId else {
                continue
            }
            assignSlot(to: launch)
            if launch.slot == nil {
                // Slotless: the start is persisted before it counts as armed.
                if entry.wasStarted {
                    launch.storage.markLaunchStarted(bundleId: entry.bundleId)
                }
                if entry.wasArmed {
                    launch.isArmed = true
                }
                continue
            }
            if entry.wasArmed {
                launch.isArmed = true
            }
            mirror(launch)
            if entry.wasStarted {
                launch.storage.markLaunchStarted(bundleId: entry.bundleId)
            }
        }
        disarmed = []
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
        charging {
            for launch in launches.values where !launch.isMain && launch.crashCountsAgainstLaunch {
                writeMarker(launch)
            }
        }
    }

    /// An uncaught native exception: the attributed instance's marker, or
    /// every unverified launch's.
    func chargeUncaughtException() {
        charging {
            if let attributedName, let launch = launches[attributedName] {
                // Not a later launch of the claimed instance.
                if launch.recordsCrashes, launch.generation == attributedGeneration {
                    writeMarker(launch)
                }
                return
            }
            // The exception the forwarded fatal of an earlier runtime raises.
            if isEarlierRuntimeClaim {
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
    ///
    /// `runtimeBundleURL` is the bundle the resolving runtime runs: a module
    /// of a runtime of an earlier launch, resolving late, doesn't resolve the
    /// current launch, whose own runtime may still render or fail before it
    /// has a module.
    func runtimeResolved(name: String, runtimeBundleURL: URL? = nil) {
        withLock {
            guard let launch = launches[name],
                  isCurrentRuntime(of: launch, runtimeBundleURL: runtimeBundleURL) else {
                return
            }
            launch.hasResolvedRuntime = true
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
            let possibleOwners = possibleFatalOwners
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
            // Main writes for the whole process once it launched; a marker
            // of a verified launch carries `shouldRollback: false`.
            if launch.isMain ? launch.recordsCrashes : launch.crashCountsAgainstLaunch {
                writeMarker(launch)
            }
        }
    }

    /// Every marker goes through here: one that rolls back a named
    /// instance's current launch is also reported through
    /// `onRollbackCharged` once the charge finishes (`charging`).
    private func writeMarker(_ launch: Launch) {
        HotUpdaterCrashMarker.write(
            bundleId: launch.markerBundleId,
            shouldRollback: launch.shouldRollback,
            to: launch.markerURL
        )
        // Main too once named instances exist: its in-process reload is off
        // then, so its next same-process launch must roll back instead.
        if launch.shouldRollback, !launch.isMain || hasNamedInstanceUnlocked,
           !rolledBackNames.contains(launch.name) {
            rolledBackNames.append(launch.name)
        }
    }

    /// Runs a charge under the lock, then reports outside it each named
    /// instance whose launch it marked for rollback.
    private func charging<T>(_ body: () -> T) -> T {
        let result: T
        let rolledBack: [String]
        lock.lock()
        result = body()
        rolledBack = rolledBackNames
        rolledBackNames = []
        let notify = onRollbackCharged
        lock.unlock()
        rolledBack.forEach { notify?($0) }
        return result
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
    }

    /// Publishes `launch`'s state to its native slot, before anything else
    /// touches the file system: the directory the signal handler writes the
    /// marker into is created after, once per launch.
    private func mirror(_ launch: Launch) {
        guard let slot = launch.slot else { return }
        let flag = launch.crashCountsAgainstLaunch
        slotFlags[slot] = flag
        // Main's slot writes on any signal, and keeps naming its bundle
        // after its watch ended. A development build's names no marker once
        // the watch ended, so a signal then records nothing either: an empty
        // path is a slot the signal handler skips.
        let recordsNow = !launch.isMain || launch.isMonitoring || launch.recordsAfterWatch
        sink.updateSlot(
            slot,
            markerPath: recordsNow ? launch.markerURL.path : "",
            bundleId: launch.markerBundleId,
            shouldRollback: flag
        )
        if !launch.hasMarkerDirectory {
            try? FileManager.default.createDirectory(
                at: launch.markerURL.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: nil
            )
            launch.hasMarkerDirectory = true
        }
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
        /// Each instance's launch when the surface started.
        let generations: [String: Int]
    }

    private let lock = NSLock()
    private var entries: [Entry] = []

    /// `generations` is `HotUpdaterRecoveryCoordinator.generations()` when
    /// the surface started.
    func add(_ surface: AnyObject, inForeground: Bool, generations: [String: Int] = [:]) {
        lock.lock()
        entries.append(Entry(surface: surface, inForeground: inForeground, generations: generations))
        lock.unlock()
    }

    /// The surfaces `owner` attributes now, with whether each started in the
    /// foreground and the owner's launch it started in (nil when the owner
    /// had none then); they and the surfaces already gone are forgotten.
    func resolve(_ owner: (AnyObject) -> String?) -> [(name: String, surface: AnyObject, inForeground: Bool, generation: Int?)] {
        lock.lock()
        let current = entries
        lock.unlock()

        var resolved: [(name: String, surface: AnyObject, inForeground: Bool, generation: Int?)] = []
        var settled: [ObjectIdentifier] = []
        for entry in current {
            guard let surface = entry.surface else { continue }
            if let name = owner(surface) {
                resolved.append((name, surface, entry.inForeground, entry.generations[name]))
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

    /// Whether a view that started in the background is shown now, by
    /// `isShown`. They are forgotten once one is shown, or after the `final`
    /// check of a foreground transition (didBecomeActive): a surface not yet
    /// in its window at willEnterForeground may be by then.
    func takeAnyShown(_ isShown: (AnyObject) -> Bool, final: Bool = true) -> Bool {
        lock.lock()
        let views = entries.compactMap(\.view)
        lock.unlock()
        let shown = views.contains { isShown($0) }
        if shown || final {
            removeAll()
        }
        return shown
    }

    /// What a view of a named launch's runtime does when it starts, is
    /// attached to a window, or is told apart after either: its launch
    /// starts only once the view is shown while the app is in the
    /// foreground. A surface started for pre-rendering is not shown yet: it
    /// waits for its view to be attached (the attachment is reported as
    /// another start). In the background it waits for the foreground.
    enum ViewStart: Equatable {
        case arm
        case waitForAttachment
        case waitForForeground
    }

    static func viewStart(inForeground: Bool, isShown: () -> Bool) -> ViewStart {
        guard inForeground else { return .waitForForeground }
        return isShown() ? .arm : .waitForAttachment
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

/// The invalidation count of one instance's prepared launch. Marking a
/// rollback only advances it, without the launch lock (a crash may be
/// reported on a thread that holds it); a launch prepared at an older count
/// is prepared again, so a preparation running concurrently can't publish a
/// selection that outlives the rollback.
final class HotUpdaterLaunchEpoch {
    private let lock = NSLock()
    private var value = 0

    var current: Int {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func invalidate() {
        lock.lock()
        value += 1
        lock.unlock()
    }

    /// Whether a selection prepared at `epoch` is still current.
    func isCurrent(_ epoch: Int) -> Bool {
        current == epoch
    }

    /// Runs `prepare` until no rollback was marked while it ran, so a marker
    /// written during a preparation is consumed by the next one instead of
    /// handing out the failing bundle. After `maxAttempts`, the latest
    /// result, with the epoch it started at: the next request prepares again.
    func prepareCurrent<Value>(maxAttempts: Int = 3, _ prepare: () -> Value) -> (value: Value, epoch: Int) {
        let prepared = prepareCurrent(maxAttempts: maxAttempts, prepare: prepare, startMonitoring: { _ in () })
        return (prepared.value, prepared.epoch)
    }

    /// `prepareCurrent`, with the launch's monitoring started in each
    /// attempt (which replaces the running launch's; a later attempt
    /// replaces it again). The check comes after: until monitoring is
    /// replaced, the running launch's fatal can still mark a rollback.
    func prepareCurrent<Value, Monitoring>(
        maxAttempts: Int = 3,
        prepare: () -> Value,
        startMonitoring: (Value) -> Monitoring
    ) -> (value: Value, monitoring: Monitoring, epoch: Int) {
        var attempts = 0
        while true {
            let epoch = current
            let value = prepare()
            let monitoring = startMonitoring(value)
            attempts += 1
            if isCurrent(epoch) || attempts >= maxAttempts {
                return (value, monitoring, epoch)
            }
        }
    }
}

/// The newest launch generation main-queue work was scheduled for. Work
/// queued for an older launch can run after a newer launch's: it then does
/// nothing, so it never removes or resets what the newer launch set up.
struct HotUpdaterLatestGeneration {
    private(set) var latest = 0

    /// Whether work for `generation` is still the newest seen; records it.
    mutating func admit(_ generation: Int) -> Bool {
        guard generation >= latest else { return false }
        latest = generation
        return true
    }
}

/// The launch each React Native runtime runs, by the runtime's module,
/// recorded when the module tells its instance apart. A host can start a
/// replacement launch with the same bundle while its previous runtime is
/// still torn down; that runtime's late content then names the same
/// instance and bundle, and only the launch it was recorded for tells it
/// apart. Weakly: a runtime gone is forgotten.
final class HotUpdaterRuntimeLaunches {
    private let lock = NSLock()
    private let generations = NSMapTable<AnyObject, NSNumber>.weakToStrongObjects()

    func record(runtime: AnyObject, generation: Int) {
        lock.lock()
        generations.setObject(NSNumber(value: generation), forKey: runtime)
        lock.unlock()
    }

    private let firstStarts = NSMapTable<AnyObject, NSDictionary>.weakToStrongObjects()

    /// Each instance's launch at a surface's first start (`current`, for a
    /// first start), kept for its later starts, such as its attachment to a
    /// window after a replacement launch began: the launch a surface whose
    /// runtime has no record belongs to.
    func generationsOfFirstStart(_ surface: AnyObject, current: [String: Int]) -> [String: Int] {
        lock.lock()
        defer { lock.unlock() }
        if let first = firstStarts.object(forKey: surface) as? [String: Int] {
            return first
        }
        firstStarts.setObject(current as NSDictionary, forKey: surface)
        return current
    }

    /// The launch `runtime` was recorded for; nil when unknown (no runtime
    /// told apart yet), which keeps it attributed by name and bundle alone.
    func generation(of runtime: AnyObject?) -> Int? {
        guard let runtime else { return nil }
        lock.lock()
        defer { lock.unlock() }
        return generations.object(forKey: runtime)?.intValue
    }
}

/// First content that appeared while the app was in the background, such as
/// the root view a silent push's launch creates. Nobody sees it, so it
/// verifies no launch until the app comes to the foreground: the old
/// architecture posts content for a root view even when the headless App
/// renders nothing, which would otherwise verify a staged bundle no one saw.
/// A view torn down before then verifies nothing.
final class HotUpdaterBackgroundContent {
    private struct Entry {
        weak var view: AnyObject?
        let hasView: Bool
    }

    private let lock = NSLock()
    private var entries: [Entry] = []

    /// Holds `view`'s content for the foreground. Returns true for the first
    /// one held, when the caller starts waiting for the foreground.
    func hold(_ view: AnyObject?) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        entries.append(Entry(view: view, hasView: view != nil))
        return entries.count == 1
    }

    /// The content held, once: the views still alive, and nil for content
    /// that came without a view.
    func takeAll() -> [AnyObject?] {
        lock.lock()
        let taken = entries
        entries = []
        lock.unlock()
        return taken.compactMap { entry -> AnyObject?? in
            if !entry.hasView { return .some(nil) }
            return entry.view.map { .some($0) }
        }
    }
}
