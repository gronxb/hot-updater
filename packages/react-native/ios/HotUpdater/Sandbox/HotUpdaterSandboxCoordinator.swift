#if HOT_UPDATER_SANDBOX_LAYER
import Foundation

/// What a check of the target channel did.
enum HotUpdaterSandboxStaged: Equatable {
    /// The update is staged or committed: `bundleId` is what a launch selects,
    /// and `releaseId` what `HotUpdater.getBundleId()` reports for it.
    case update(bundleId: String, message: String? = nil, releaseId: String? = nil)
    /// The channel has nothing newer for this build.
    case noUpdate
    /// Another check or reset replaced the selection first.
    case superseded
}

/// What the channel and bundle are now, as storage says, never as the UI assumes.
struct HotUpdaterSandboxSelection: Equatable {
    let channel: String
    let defaultChannel: String
    /// The bundle a launch selects.
    let bundleId: String
    let isBuiltIn: Bool
}

/// The bundle the next launch selects. The SDK's own read answers what this process
/// runs once it has fixed a launch, a bundle a reset may have deleted by then, so after
/// a launch the answer is what storage holds as active.
///
/// - Parameters:
///   - runningBundleId: the OTA this process launched; nil before a launch, or after
///     one of the built-in bundle.
///   - launchBundleId: the SDK's read: the launched bundle, or before a launch the
///     bundle one would pick; nil is the built-in bundle.
///   - activeBundleId: the stored active selection's bundle, or nil.
func hotUpdaterSandboxNextLaunchBundleId(
    runningBundleId: String?,
    launchBundleId: String?,
    activeBundleId: String?,
    builtInBundleId: String
) -> String {
    if runningBundleId == nil, let launchBundleId {
        return launchBundleId
    }
    return activeBundleId ?? builtInBundleId
}

/// Everything the coordinator asks of the SDK and the device.
protocol HotUpdaterSandboxHost: AnyObject {
    /// The fingerprint this build embeds, or nil without one.
    func fingerprintHash() -> String?
    /// Whether this process runs a dev server's JavaScript or a stored bundle, where
    /// nothing can change the normal selection.
    var isInSession: Bool { get }
    /// The stored bundle this process runs, or nil.
    var storedSessionBundleId: String? { get }
    /// Runs a stored bundle for this process: a reload over a running app, or the
    /// app's start. A cold launch is back on the normal selection.
    func startStoredSession(_ bundle: HotUpdaterSandboxStoredBundle)
    /// Ends the session: the normal selection runs again.
    func exitSession()
    /// Ends the session, with the screen still up to answer a link.
    func exitSessionForLink()
    /// Whether the app's JavaScript left a server config: a server answered one of its checks.
    func hasServerConfig() -> Bool
    /// What the next launch selects, as storage holds it. Settles the previous launch
    /// first, so a crash can't be read as a selection.
    func selection() async -> HotUpdaterSandboxSelection
    /// What this process's launch runs, or before one, what it would pick. It differs
    /// from a staged bundle once the launch is fixed, so only a reload applies a switch.
    func launchBundleId() async -> String
    /// Whether the app is up under the screen, so opening it starts nothing.
    func isAppRunning() -> Bool
    /// Whether the target channel has a bundle this build would run. Throws when the server can't say.
    func preflight(channel: String) async throws -> Bool
    /// What the last launch left: read, never a request. Settled reads come after `selection()`.
    func launchEvidence() -> HotUpdaterSandboxLaunchEvidence
    /// What the build and the SDK's store hold: read, never a request.
    func details() -> HotUpdaterSandboxDetails
    /// Deletes downloaded bundles and returns to the default channel.
    func reset() async throws -> Bool
    func checkAndStage(
        channel: String,
        onProgress: @escaping (Double) -> Void
    ) async throws -> HotUpdaterSandboxStaged
}

extension HotUpdaterSandboxHost {
    var isInSession: Bool { false }
    var storedSessionBundleId: String? { nil }
    func startStoredSession(_ bundle: HotUpdaterSandboxStoredBundle) {}
    func exitSession() {}
    func exitSessionForLink() {}

    func launchBundleId() async -> String {
        await selection().bundleId
    }

    func isAppRunning() -> Bool {
        false
    }
}

/// What outlives the process.
protocol HotUpdaterSandboxStore: AnyObject {
    /// The unanswered links, oldest first.
    var pendingLinks: [String] { get set }
    /// What the last launch left, until a person moved on from it.
    var lastLaunch: HotUpdaterSandboxLastLaunch? { get set }
}

enum HotUpdaterSandboxStep: Equatable {
    case preflight, reset, check, download
}

enum HotUpdaterSandboxRefusal: Equatable {
    case unreadable(url: String)
    /// The channel's bundles need another native build.
    case otherFingerprint(link: HotUpdaterSandboxLink, buildFingerprintHash: String?)
    /// Something typed isn't a channel a release can target.
    case invalidChannel(String)
}

enum HotUpdaterSandboxFailure: Equatable {
    /// The target has no bundle for this build.
    case noBundle
    case resetFailed
    /// Another check or a reset changed the selection during the switch.
    case superseded
    /// A stored bundle runs: the way back is to the current bundle.
    case inStoredSession
    /// A request failed, or the SDK refused.
    case error(String)
}

enum HotUpdaterSandboxPhase: Equatable {
    case idle
    /// A link waits for a person to accept it. It names the link's channel.
    case confirming(HotUpdaterSandboxLink)
    /// A link waits for a server to answer one of the app's checks.
    case waitingForServer(HotUpdaterSandboxLink)
    case refused(HotUpdaterSandboxRefusal)
    case working(operationId: Int, target: String, step: HotUpdaterSandboxStep, progress: Double?)
    /// `selection` is what storage holds now. After a reset, that's the built-in bundle.
    case failed(
        operationId: Int,
        target: String,
        step: HotUpdaterSandboxStep,
        failure: HotUpdaterSandboxFailure,
        selection: HotUpdaterSandboxSelection
    )
}

/// What the screen renders.
struct HotUpdaterSandboxState: Equatable {
    var selection: HotUpdaterSandboxSelection?
    var hasServerConfig: Bool
    var phase: HotUpdaterSandboxPhase
    /// Links behind the one in `phase`, each asked in turn.
    var queuedLinks: Int
    var details: HotUpdaterSandboxDetails?
    var lastLaunch: HotUpdaterSandboxLastLaunch?
    /// What the sandbox's switches downloaded, newest first.
    var downloaded: [HotUpdaterSandboxShelfEntry] = []
    /// What the stored copies take.
    var downloadedBytes: Int64 = 0
    /// The stored bundle this process runs, or nil.
    var storedSessionBundleId: String?
    /// The deploy message of the selected bundle, when this device knows it.
    var selectedMessage: String?
    /// What this process's launch runs, or before one, what it would pick; `selection` is the next launch.
    var runningBundleId: String?
    var runningMessage: String?
}

/// The one serialization point for what changes the selection or a dev session in
/// this process: a switch (a preview link, a channel, the built-in bundle) or a dev
/// server connection (connect, Reload). Each holds it across all its awaits, and
/// whichever comes second is refused, never queued behind the other.
@MainActor
final class HotUpdaterSandboxLock {
    enum Holder: Equatable {
        case switching
        case devServer
    }

    static let shared = HotUpdaterSandboxLock()

    private(set) var holder: Holder?

    func take(_ who: Holder) -> Bool {
        guard holder == nil else { return false }
        holder = who
        return true
    }

    func release(_ who: Holder) {
        if holder == who { holder = nil }
    }
}

/// The one owner of a channel switch: fingerprint check, confirmation for a link,
/// catalog preflight, reset, the SDK's check and update, then opening the app.
/// One switch runs at a time, and a row, a typed channel or a reset can't start
/// while one does; a link queues for its own confirmation. Each switch has an
/// operation ID, so what arrives after it ended changes nothing. It runs on the
/// main actor; the UI only observes `state` and calls these actions.
@MainActor
final class HotUpdaterSandboxCoordinator {
    private let host: HotUpdaterSandboxHost
    /// Whether a link's scheme is this build's: another app's link isn't for it.
    private let isOwnScheme: (String) -> Bool
    private let store: HotUpdaterSandboxStore
    private let shelf: HotUpdaterSandboxShelf
    /// Where the shelf's file work runs, in order, off the main thread.
    private let shelfQueue: DispatchQueue
    /// The Downloaded list as the shelf last reported it: the screen reads only this.
    private var downloaded: [HotUpdaterSandboxShelfEntry] = []
    private var downloadedBytes: Int64 = 0
    /// A row's stored bundle being checked, before its session starts: Clear and
    /// Delete leave it alone, as they do the running one.
    private var openingBundleId: String?

    private var protectedBundleIds: Set<String> {
        Set([host.storedSessionBundleId, openingBundleId].compactMap { $0 })
    }
    /// Opens the app: on `open()` with `switched` false, or after a switch.
    /// `fixed` is true when this process had already fixed its launch, so only a
    /// reload can apply the switch.
    private let openApp: (_ switched: Bool, _ fixed: Bool) -> Void
    private let log: (String) -> Void
    private let lock: HotUpdaterSandboxLock
    private var listeners: [Int: (HotUpdaterSandboxState) -> Void] = [:]
    private var nextListenerId = 0
    private var queue: [String]
    private var nextOperationId = 1
    private var retryTarget: String?
    private var linkInFlight: String?
    /// The link a refusal on screen is about: the system can deliver a cold link twice.
    private var refusedLink: String?
    /// A finished switch opens the app once the links queued behind it are answered.
    private var switchAwaitsOpen = false
    /// `open()` runs until it opens the app; a second tap meanwhile does nothing.
    private var isOpening = false
    /// Whether this process's launch runs something other than what the next one
    /// selects, as of the last `readSelection()`: only a reload can apply that.
    private var launchFixed = false
    /// The bundle of the last launch a person moved on from in this process, whose
    /// evidence stays readable until the process ends.
    private var acknowledgedBundleId: String?
    private let now: () -> Date

    private(set) var state = HotUpdaterSandboxState(
        selection: nil,
        hasServerConfig: false,
        phase: .idle,
        queuedLinks: 0
    )

    init(
        host: HotUpdaterSandboxHost,
        store: HotUpdaterSandboxStore,
        shelf: HotUpdaterSandboxShelf,
        openApp: @escaping (_ switched: Bool, _ fixed: Bool) -> Void,
        log: @escaping (String) -> Void = { _ in },
        now: @escaping () -> Date = Date.init,
        lock: HotUpdaterSandboxLock = .shared,
        shelfQueue: DispatchQueue = DispatchQueue(label: "hot-updater-sandbox.shelf"),
        isOwnScheme: @escaping (String) -> Bool = { HotUpdaterSandboxLink.isOwnScheme($0) }
    ) {
        self.isOwnScheme = isOwnScheme
        self.shelfQueue = shelfQueue
        self.now = now
        self.lock = lock
        self.host = host
        self.store = store
        self.shelf = shelf
        self.openApp = openApp
        self.log = log
        queue = store.pendingLinks
    }

    /// Calls `listener` now and at every change, until the returned function runs.
    func observe(_ listener: @escaping (HotUpdaterSandboxState) -> Void) -> () -> Void {
        let id = nextListenerId
        nextListenerId += 1
        listeners[id] = listener
        listener(state)
        return { [weak self] in
            Task { @MainActor in self?.listeners[id] = nil }
        }
    }

    /// Reads what storage holds, and asks about the oldest unanswered link.
    /// Sends no request: opening the screen costs the update server nothing.
    func refresh() async {
        // A switch may be copying into the shelf: its partial copy isn't listed yet.
        if case .working = state.phase {
            await relist(reconciling: false)
        } else {
            await relist(reconciling: true)
        }
        let selection = await readSelection()
        publish(reading(selection, launched: await host.launchBundleId()))
        pump()
    }

    /// Keeps what the last launch left, for a launch that started without the
    /// screen: the next screen tells it, once that launch's evidence is gone.
    func noteLastLaunch() async {
        // Read first: before a launch, it settles what the previous process left.
        _ = await host.selection()
        let launched = await host.launchBundleId()
        var next = state
        next.lastLaunch = settledLastLaunch(launched: launched)
        publish(next)
    }

    /// A link from any source. The same URL already waiting or running counts once.
    func receiveLink(_ url: String) {
        if url == linkInFlight || url == refusedLink || queue.contains(url) {
            log("link deduped")
            return
        }
        queue.append(url)
        persist()
        pump()
    }

    /// Accepts the link in `.confirming`.
    func confirmLink() {
        guard case .confirming(let link) = state.phase else { return }
        // A row is opening its stored bundle: the link waits for it.
        if openingBundleId != nil { return }
        // The link stays stored, and the screen asks about it on the normal selection.
        if host.isInSession {
            host.exitSessionForLink()
            setPhase(.idle)
            pump()
            return
        }
        linkInFlight = link.url
        begin(target: link.channel)
    }

    /// Closes a declined link, a refusal, or a failure, and asks about the next link.
    /// `onAnswered` runs only if nothing is left to answer, so a screen closing itself
    /// can't take the next question with it.
    func dismiss(onAnswered: (() -> Void)? = nil) {
        switch state.phase {
        case .confirming(let link), .waitingForServer(let link):
            remove(link.url)
        case .refused:
            refusedLink = nil
        case .failed:
            retryTarget = nil
        case .idle, .working:
            return
        }
        setPhase(.idle)
        pump()
        openSwitchIfAnswered()
        if state.phase == .idle {
            onAnswered?()
        }
    }

    /// A row or a typed channel: no confirmation, since a person chose it here.
    /// A full link pasted in is a link, with the same checks as a scanned one.
    /// Returns false while another switch runs.
    @discardableResult
    func switchTo(_ entry: String) -> Bool {
        let text = entry.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.contains("://") {
            receiveLink(text)
            return true
        }
        guard canStart else { return false }
        guard HotUpdaterSandboxLink.isChannelName(text) else {
            setPhase(.refused(.invalidChannel(text)))
            return true
        }
        begin(target: text)
        return true
    }

    /// Back to the built-in bundle: what a failed switch leaves, on purpose. It
    /// opens nothing: the screen stays, and its row opens the built-in bundle.
    /// Returns false while a switch runs.
    @discardableResult
    func resetToBuiltIn() -> Bool {
        guard canStart else { return false }
        let operationId = takeOperationId()
        // Taken now, so nothing else can start while the selection is read.
        setPhase(.working(operationId: operationId, target: "", step: .reset, progress: nil))
        Task { @MainActor in
            guard await takeLock(operationId, "") else { return }
            defer { lock.release(.switching) }
            let target = await host.selection().defaultChannel
            if await refuseInSession(operationId, target) { return }
            setPhase(.working(operationId: operationId, target: target, step: .reset, progress: nil))
            guard let reset = await attempt(operationId, target, .reset, { try await self.host.reset() }) else { return }
            guard reset else {
                await fail(operationId, target, .reset, .resetFailed)
                return
            }
            await finish(operationId, opens: false)
        }
        return true
    }

    /// Runs the failed switch again from its preflight.
    func retry() {
        guard case .failed(_, let target, _, let failure, _) = state.phase else { return }
        // A refusal in a stored session offers the way back instead.
        if failure == .inStoredSession {
            leaveStoredSession()
            return
        }
        begin(target: retryTarget ?? target)
    }

    /// Opens the app on what's selected, when no switch or question stands in the way.
    /// A second tap while one opens opens nothing more.
    func open() async {
        guard !isOpening else { return }
        isOpening = true
        defer { isOpening = false }
        let selection = await readSelection()
        let launched = await host.launchBundleId()
        // Over a running app, opening shows what it runs: what's selected waits for
        // its launch. Before the app starts, what's selected is what opens.
        let reloads = launchFixed && !host.isAppRunning()
        acknowledgeLastLaunch()
        publish(reading(selection, launched: launched))
        openApp(false, reloads)
    }

    /// What a tap on Home's big row does: its action, worked out with the row's
    /// words, so the two agree.
    func tap(_ action: HotUpdaterSandboxHomeModel.Action, devServer: HotUpdaterSandboxDevServer?) {
        switch action {
        case .open: Task { await open() }
        case .openOverApp, .reloadApp: reloadApp()
        case .reloadDevServer: devServer?.reloadDevServer()
        }
    }

    /// Runs the app again from the screen over it: the bundle a launch selects now.
    func reloadApp() {
        guard canStart else { return }
        if let stored = host.storedSessionBundleId {
            openDownloaded(stored)
            return
        }
        acknowledgeLastLaunch()
        openApp(true, true)
    }

    /// A Downloaded row runs its stored bundle for this process, offline. A row
    /// whose bundle isn't on this device checks its channel, as a typed one does,
    /// and stays: only Delete and Clear remove a row.
    /// Returns false while a switch runs.
    @discardableResult
    func openDownloaded(_ bundleId: String) -> Bool {
        guard canStart, lock.holder == nil,
              let entry = downloaded.first(where: { $0.bundleId == bundleId }) else { return false }
        openingBundleId = bundleId
        let shelf = shelf
        Task { @MainActor in
            // The files are checked off the main thread.
            let stored = await onShelf { shelf.stored(bundleId) }
            guard var bundle = stored else {
                openingBundleId = nil
                switchTo(entry.channel)
                pump()
                return
            }
            // The session reports the release its row was listed as.
            bundle.releaseId = entry.releaseId
            // The session is this process's own from here: its ID is the running one at once.
            openingBundleId = nil
            if canStart, lock.holder == nil {
                acknowledgeLastLaunch()
                setPhase(.idle)
                log("opening stored \(entry.channel) \(bundleId)")
                host.startStoredSession(bundle)
            }
            publish(reading(state))
            pump()
        }
        return true
    }

    /// Back to what the normal selection runs.
    func leaveStoredSession() {
        guard host.storedSessionBundleId != nil else { return }
        if case .failed = state.phase { dismiss() }
        host.exitSession()
    }

    /// Removes a row and its files. The running one stays.
    func deleteDownloaded(_ bundleId: String) {
        guard !protectedBundleIds.contains(bundleId) else { return }
        let shelf = shelf
        Task { @MainActor in
            await onShelf { shelf.remove(bundleId) }
            await relist(reconciling: false)
        }
    }

    /// A person moved on from what the last launch left, so it's not told again.
    func acknowledgeLastLaunch() {
        guard let shown = store.lastLaunch else { return }
        acknowledgedBundleId = shown.bundleId
        store.lastLaunch = nil
        var next = state
        next.lastLaunch = nil
        publish(next)
    }

    /// Removes every row and its files but the running one: they're only on this device.
    func clearDownloaded() {
        let shelf = shelf
        let kept = protectedBundleIds
        Task { @MainActor in
            await onShelf { shelf.clear(keeping: kept) }
            await relist(reconciling: false)
        }
    }

    /// Runs the shelf's file work in order on its queue, so the main thread never waits for it.
    private func onShelf<T>(_ work: @escaping () -> T) async -> T {
        await withCheckedContinuation { continuation in
            shelfQueue.async { continuation.resume(returning: work()) }
        }
    }

    /// Takes the shelf's list and size from its queue, and shows them.
    private func relist(reconciling: Bool) async {
        let shelf = shelf
        let (entries, bytes) = await onShelf { () -> ([HotUpdaterSandboxShelfEntry], Int64) in
            if reconciling { shelf.reconcile() }
            return (shelf.entries, shelf.totalBytes())
        }
        downloaded = entries
        downloadedBytes = bytes
        publish(reading(state))
    }

    /// The Downloaded list as the shelf last reported it.
    private func reading(_ base: HotUpdaterSandboxState) -> HotUpdaterSandboxState {
        var next = base
        next.downloaded = downloaded
        next.downloadedBytes = downloadedBytes
        next.storedSessionBundleId = host.storedSessionBundleId
        next.selectedMessage = next.selection.flatMap { message(of: $0.bundleId) }
        next.runningMessage = next.runningBundleId.flatMap(message(of:))
        return next
    }

    private func message(of bundleId: String) -> String? {
        downloaded.first { $0.bundleId == bundleId }?.message
    }

    /// What storage says now, with no request.
    private func reading(_ selection: HotUpdaterSandboxSelection, launched: String) -> HotUpdaterSandboxState {
        var next = state
        next.selection = selection
        next.runningBundleId = launched
        next.hasServerConfig = host.hasServerConfig()
        next.details = host.details()
        next.lastLaunch = settledLastLaunch(launched: launched)
        return reading(next)
    }

    /// Reads evidence after the host's reads, which settled the previous launch.
    private func settledLastLaunch(launched: String) -> HotUpdaterSandboxLastLaunch? {
        let derived = HotUpdaterSandboxLastLaunch.derive(evidence: host.launchEvidence(), launchBundleId: launched)
        if let derived, derived.bundleId != acknowledgedBundleId {
            store.lastLaunch = derived
        }
        return store.lastLaunch
    }

    private var canStart: Bool {
        if openingBundleId != nil { return false }
        switch state.phase {
        case .idle, .failed:
            return true
        default:
            return false
        }
    }

    private func takeOperationId() -> Int {
        defer { nextOperationId += 1 }
        return nextOperationId
    }

    private func begin(target: String) {
        let operationId = takeOperationId()
        retryTarget = target
        setPhase(.working(operationId: operationId, target: target, step: .preflight, progress: nil))
        Task { @MainActor in await run(operationId, target) }
    }

    /// A switch holds the lock for all of its steps, so no dev server connects between them.
    private func takeLock(_ operationId: Int, _ target: String) async -> Bool {
        guard lock.take(.switching) else {
            await fail(operationId, target, .preflight, .error("A dev server is connecting. Wait for it, then try again."))
            return false
        }
        return true
    }

    /// A session's native state is the session's, so a switch waits for its end.
    /// Asked again after every await, before a step that changes the selection.
    private func refuseInSession(_ operationId: Int, _ target: String, _ step: HotUpdaterSandboxStep = .preflight) async -> Bool {
        guard host.isInSession else { return false }
        if host.storedSessionBundleId != nil {
            await fail(operationId, target, step, .inStoredSession)
        } else {
            await fail(operationId, target, step, .error("The dev server is running. Exit it, then try again."))
        }
        return true
    }

    private func run(_ operationId: Int, _ target: String) async {
        guard await takeLock(operationId, target) else { return }
        defer { lock.release(.switching) }
        if await refuseInSession(operationId, target) { return }
        let before = await host.selection()
        let toDefault = target == before.defaultChannel
        guard let hasBundle = await attempt(operationId, target, .preflight, {
            try await self.host.preflight(channel: target)
        }) else { return }
        // A preflight that found nothing leaves everything downloaded in place.
        if !hasBundle && !toDefault {
            await fail(operationId, target, .preflight, .noBundle)
            return
        }
        if before.channel != target {
            if await refuseInSession(operationId, target, .reset) { return }
            setPhase(.working(operationId: operationId, target: target, step: .reset, progress: nil))
            guard let reset = await attempt(operationId, target, .reset, { try await self.host.reset() }) else { return }
            guard reset else {
                await fail(operationId, target, .reset, .resetFailed)
                return
            }
        }
        if await refuseInSession(operationId, target, .check) { return }
        setPhase(.working(operationId: operationId, target: target, step: .check, progress: nil))
        guard let staged = await attempt(operationId, target, .check, {
            try await self.host.checkAndStage(channel: target) { progress in
                Task { @MainActor in self.reportProgress(operationId, target, progress) }
            }
        }) else { return }
        switch staged {
        case .superseded:
            await fail(operationId, target, .check, .superseded)
        case .noUpdate:
            // The channel is what the device left it on: nothing newer is the success.
            if !toDefault && before.channel != target {
                await fail(operationId, target, .check, .noBundle)
                return
            }
            await finish(operationId)
        case .update(let bundleId, let message, let releaseId):
            // A check from the running app may have switched channels between the SDK's steps.
            if await host.selection().channel != target {
                await fail(operationId, target, .check, .superseded)
                return
            }
            await shelve(bundleId: bundleId, channel: target, message: message, releaseId: releaseId)
            await finish(operationId)
        }
    }

    /// Keeps a copy of what the switch just installed, off the main thread. Main's
    /// store keeps the bundle it just installed, so the copy reads it in place.
    private func shelve(bundleId: String, channel: String, message: String?, releaseId: String?) async {
        let shelf = shelf
        let nowMs = now().timeIntervalSince1970 * 1000
        let kept = protectedBundleIds
        await onShelf {
            shelf.add(bundleId: bundleId, channel: channel, message: message, nowMs: nowMs, kept: kept, releaseId: releaseId)
        }
        await relist(reconciling: false)
    }

    /// `opens`: whether the app opens on the selection once the links queued behind it are answered.
    private func finish(_ operationId: Int, opens: Bool = true) async {
        clearLinkInFlight()
        retryTarget = nil
        let selection = await readSelection()
        acknowledgeLastLaunch()
        var next = reading(selection, launched: await host.launchBundleId())
        next.phase = .idle
        publish(next)
        log("operation \(operationId) selected \(selection.channel) \(selection.bundleId)")
        switchAwaitsOpen = opens
        pump()
        openSwitchIfAnswered()
    }

    private func openSwitchIfAnswered() {
        guard switchAwaitsOpen, state.phase == .idle else { return }
        switchAwaitsOpen = false
        openApp(true, launchFixed)
    }

    /// What the next launch selects, and with it whether this process's launch runs that.
    private func readSelection() async -> HotUpdaterSandboxSelection {
        let selection = await host.selection()
        let launchBundleId = await host.launchBundleId()
        // A session runs no selection, and only its end replaces it.
        launchFixed = !host.isInSession && launchBundleId != selection.bundleId
        return selection
    }

    private func reportProgress(_ operationId: Int, _ target: String, _ progress: Double) {
        guard case .working(let current, _, _, _) = state.phase, current == operationId else { return }
        setPhase(.working(operationId: operationId, target: target, step: .download, progress: progress))
    }

    /// Runs a step: on failure, the failure is shown and the result is nil.
    private func attempt<T>(
        _ operationId: Int,
        _ target: String,
        _ step: HotUpdaterSandboxStep,
        _ block: () async throws -> T
    ) async -> T? {
        do {
            return try await block()
        } catch {
            await fail(operationId, target, step, .error((error as NSError).localizedDescription))
            return nil
        }
    }

    private func fail(
        _ operationId: Int,
        _ target: String,
        _ step: HotUpdaterSandboxStep,
        _ failure: HotUpdaterSandboxFailure
    ) async {
        clearLinkInFlight()
        let selection = await readSelection()
        var next = reading(selection, launched: await host.launchBundleId())
        next.phase = .failed(operationId: operationId, target: target, step: step, failure: failure, selection: selection)
        publish(next)
    }

    /// Asks about the oldest link, unless something is already on screen. A link
    /// waiting for a server is asked about again from scratch, so its fingerprint
    /// is read again after a restart too.
    private func pump() {
        // A row is opening its stored bundle: links stay queued until it has.
        if openingBundleId != nil {
            publish(state)
            return
        }
        switch state.phase {
        case .idle, .waitingForServer:
            break
        default:
            publish(state)
            return
        }
        guard let url = queue.first else {
            setPhase(.idle)
            return
        }
        guard let link = HotUpdaterSandboxLink(url: url), isOwnScheme(link.urlScheme) else {
            remove(url)
            refusedLink = url
            setPhase(.refused(.unreadable(url: url)))
            return
        }
        let fingerprintHash = host.fingerprintHash()
        guard fingerprintHash == link.fingerprintHash else {
            remove(url)
            refusedLink = url
            setPhase(.refused(.otherFingerprint(link: link, buildFingerprintHash: fingerprintHash)))
            return
        }
        var next = state
        next.hasServerConfig = host.hasServerConfig()
        next.phase = next.hasServerConfig ? .confirming(link) : .waitingForServer(link)
        publish(next)
    }

    private func clearLinkInFlight() {
        guard let url = linkInFlight else { return }
        linkInFlight = nil
        remove(url)
    }

    private func remove(_ url: String) {
        queue.removeAll { $0 == url }
        persist()
    }

    private func persist() {
        store.pendingLinks = queue
    }

    private func setPhase(_ phase: HotUpdaterSandboxPhase) {
        var next = state
        next.phase = phase
        publish(next)
    }

    private func publish(_ next: HotUpdaterSandboxState) {
        let inPhase: String?
        switch next.phase {
        case .confirming(let link), .waitingForServer(let link):
            inPhase = link.url
        default:
            inPhase = linkInFlight
        }
        var published = next
        published.queuedLinks = queue.filter { $0 != inPhase }.count
        state = published
        for listener in listeners.values {
            listener(published)
        }
    }
}
#endif
