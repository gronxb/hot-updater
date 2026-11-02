#if HOT_UPDATER_SANDBOX_LAYER
import Foundation

/// What a check of the target channel did.
enum HotUpdaterSandboxStaged: Equatable {
    /// The update is staged or committed: `bundleId` is what a launch selects.
    case update(bundleId: String)
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
    /// Deletes downloaded bundles and returns to the default channel.
    func reset() async throws -> Bool
    func checkAndStage(
        channel: String,
        onProgress: @escaping (Double) -> Void
    ) async throws -> HotUpdaterSandboxStaged
}

extension HotUpdaterSandboxHost {
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
    func recordSelected(_ selection: HotUpdaterSandboxSelection)
    func recordOpened(_ selection: HotUpdaterSandboxSelection)
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
    private let store: HotUpdaterSandboxStore
    /// Opens the app: on `open()` with `switched` false, or after a switch.
    /// `fixed` is true when this process had already fixed its launch, so only a
    /// reload can apply the switch.
    private let openApp: (_ switched: Bool, _ fixed: Bool) -> Void
    private let log: (String) -> Void
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
    /// Whether this process's launch runs something other than what the next one
    /// selects, as of the last `readSelection()`: only a reload can apply that.
    private var launchFixed = false

    private(set) var state = HotUpdaterSandboxState(
        selection: nil,
        hasServerConfig: false,
        phase: .idle,
        queuedLinks: 0
    )

    init(
        host: HotUpdaterSandboxHost,
        store: HotUpdaterSandboxStore,
        openApp: @escaping (_ switched: Bool, _ fixed: Bool) -> Void,
        log: @escaping (String) -> Void = { _ in }
    ) {
        self.host = host
        self.store = store
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
    func refresh() async {
        let selection = await readSelection()
        var next = state
        next.selection = selection
        next.hasServerConfig = host.hasServerConfig()
        publish(next)
        pump()
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

    /// Back to the built-in bundle: what a failed switch leaves, on purpose.
    /// Returns false while a switch runs.
    @discardableResult
    func resetToBuiltIn() -> Bool {
        guard canStart else { return false }
        let operationId = takeOperationId()
        // Taken now, so nothing else can start while the selection is read.
        setPhase(.working(operationId: operationId, target: "", step: .reset, progress: nil))
        Task { @MainActor in
            let target = await host.selection().defaultChannel
            setPhase(.working(operationId: operationId, target: target, step: .reset, progress: nil))
            guard let reset = await attempt(operationId, target, .reset, { try await self.host.reset() }) else { return }
            guard reset else {
                await fail(operationId, target, .reset, .resetFailed)
                return
            }
            await finish(operationId)
        }
        return true
    }

    /// Runs the failed switch again from its preflight.
    func retry() {
        guard case .failed(_, let target, _, _, _) = state.phase else { return }
        begin(target: retryTarget ?? target)
    }

    /// Opens the app on what's selected, when no switch or question stands in the way.
    func open() async {
        let selection = await readSelection()
        // Over a running app, opening shows what it runs: what's selected waits for
        // its launch. Before the app starts, what's selected is what opens.
        let reloads = launchFixed && !host.isAppRunning()
        if reloads {
            store.recordOpened(selection)
        } else {
            let launchBundleId = await host.launchBundleId()
            store.recordOpened(HotUpdaterSandboxSelection(
                channel: selection.channel,
                defaultChannel: selection.defaultChannel,
                bundleId: launchBundleId,
                isBuiltIn: selection.isBuiltIn && launchBundleId == selection.bundleId
            ))
        }
        var next = state
        next.selection = selection
        publish(next)
        openApp(false, reloads)
    }

    private var canStart: Bool {
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

    private func run(_ operationId: Int, _ target: String) async {
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
            setPhase(.working(operationId: operationId, target: target, step: .reset, progress: nil))
            guard let reset = await attempt(operationId, target, .reset, { try await self.host.reset() }) else { return }
            guard reset else {
                await fail(operationId, target, .reset, .resetFailed)
                return
            }
        }
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
        case .update:
            // A check from the running app may have switched channels between the SDK's steps.
            if await host.selection().channel != target {
                await fail(operationId, target, .check, .superseded)
                return
            }
            await finish(operationId)
        }
    }

    private func finish(_ operationId: Int) async {
        clearLinkInFlight()
        retryTarget = nil
        let selection = await readSelection()
        store.recordSelected(selection)
        var next = state
        next.selection = selection
        next.phase = .idle
        publish(next)
        log("operation \(operationId) selected \(selection.channel) \(selection.bundleId)")
        switchAwaitsOpen = true
        pump()
        openSwitchIfAnswered()
    }

    private func openSwitchIfAnswered() {
        guard switchAwaitsOpen, state.phase == .idle else { return }
        switchAwaitsOpen = false
        if let selection = state.selection {
            store.recordOpened(selection)
        }
        openApp(true, launchFixed)
    }

    /// What the next launch selects, and with it whether this process's launch runs that.
    private func readSelection() async -> HotUpdaterSandboxSelection {
        let selection = await host.selection()
        let launchBundleId = await host.launchBundleId()
        launchFixed = launchBundleId != selection.bundleId
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
        store.recordSelected(selection)
        var next = state
        next.selection = selection
        next.phase = .failed(operationId: operationId, target: target, step: step, failure: failure, selection: selection)
        publish(next)
    }

    /// Asks about the oldest link, unless something is already on screen. A link
    /// waiting for a server is asked about again from scratch, so its fingerprint
    /// is read again after a restart too.
    private func pump() {
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
        guard let link = HotUpdaterSandboxLink(url: url) else {
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
