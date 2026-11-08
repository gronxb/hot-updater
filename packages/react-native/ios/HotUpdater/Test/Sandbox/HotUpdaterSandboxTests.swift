#if canImport(Testing)
import Foundation
import Testing

@testable import HotUpdaterSandboxCore

private let fingerprint = "abc"

private func link(_ channel: String, fingerprintHash: String = fingerprint) -> String {
    "hu-sandbox-app://hot-updater/preview?channel=\(channel)&fingerprint=\(fingerprintHash)"
}

private enum FakeError: Error { case offline }

/// A step the test finishes by hand.
private final class Gate<T: Sendable>: @unchecked Sendable {
    private var continuation: CheckedContinuation<T, Error>?
    private var result: Result<T, Error>?
    private(set) var started = 0

    func wait() async throws -> T {
        started += 1
        if let result { return try result.get() }
        return try await withCheckedThrowingContinuation { continuation = $0 }
    }

    func finish(_ value: Result<T, Error>) {
        if let continuation {
            self.continuation = nil
            continuation.resume(with: value)
        } else {
            result = value
        }
    }
}

@MainActor
private final class FakeHost: HotUpdaterSandboxHost {
    var fingerprint: String? = "abc"
    var serverConfig = true
    var channel = "sandbox-release"
    var bundleId = "built-in"
    var calls: [String] = []
    var preflightGate: Gate<Bool>?
    var preflights: [String: Result<Bool, Error>] = [:]
    var resetResult: Result<Bool, Error> = .success(true)
    var stageGate: Gate<HotUpdaterSandboxStaged>?
    var stageResult: Result<HotUpdaterSandboxStaged, Error> = .success(.update(bundleId: "ota"))
    var progressReporter: ((Double) -> Void)?
    /// The OTA this process launched, which stays what it runs after a reset deletes it.
    var runningBundleId: String?
    var channelAfterStaging: String?
    var runsDevServer = false
    var devExits = 0
    var storedBundleId: String?
    var startedStored: [String] = []

    nonisolated var isInSession: Bool {
        MainActor.assumeIsolated { runsDevServer || storedBundleId != nil }
    }

    nonisolated var storedSessionBundleId: String? {
        MainActor.assumeIsolated { storedBundleId }
    }

    nonisolated func startStoredSession(_ bundle: HotUpdaterSandboxStoredBundle) {
        MainActor.assumeIsolated {
            startedStored.append(bundle.bundleId)
            storedBundleId = bundle.bundleId
        }
    }

    nonisolated func exitSession() {
        exitSessionForLink()
    }

    nonisolated func exitSessionForLink() {
        MainActor.assumeIsolated {
            devExits += 1
            runsDevServer = false
            storedBundleId = nil
        }
    }

    var evidence = HotUpdaterSandboxLaunchEvidence()
    var pendingBundleId: String?

    nonisolated func launchEvidence() -> HotUpdaterSandboxLaunchEvidence {
        MainActor.assumeIsolated { evidence }
    }

    nonisolated func details() -> HotUpdaterSandboxDetails {
        MainActor.assumeIsolated {
            HotUpdaterSandboxDetails(
                builtInBundleId: "built-in",
                fingerprintHash: fingerprint,
                pendingBundleId: pendingBundleId
            )
        }
    }

    nonisolated func fingerprintHash() -> String? {
        MainActor.assumeIsolated { fingerprint }
    }

    nonisolated func hasServerConfig() -> Bool {
        MainActor.assumeIsolated { serverConfig }
    }

    func selection() async -> HotUpdaterSandboxSelection {
        HotUpdaterSandboxSelection(
            channel: channel,
            defaultChannel: "sandbox-release",
            bundleId: bundleId,
            isBuiltIn: bundleId == "built-in"
        )
    }

    func launchBundleId() async -> String {
        runningBundleId ?? bundleId
    }

    var appRunning = false

    nonisolated func isAppRunning() -> Bool {
        MainActor.assumeIsolated { appRunning }
    }

    func preflight(channel: String) async throws -> Bool {
        calls.append("preflight \(channel)")
        if let preflightGate { return try await preflightGate.wait() }
        return try (preflights[channel] ?? .success(true)).get()
    }

    func reset() async throws -> Bool {
        calls.append("reset")
        let reset = try resetResult.get()
        if reset {
            channel = "sandbox-release"
            bundleId = "built-in"
        }
        return reset
    }

    func checkAndStage(channel: String, onProgress: @escaping (Double) -> Void) async throws -> HotUpdaterSandboxStaged {
        calls.append("check \(channel)")
        progressReporter = onProgress
        let staged: HotUpdaterSandboxStaged
        if let stageGate {
            staged = try await stageGate.wait()
        } else {
            staged = try stageResult.get()
        }
        if case .update(let bundleId, _) = staged {
            self.channel = channelAfterStaging ?? channel
            self.bundleId = bundleId
        }
        return staged
    }
}

private final class FakeStore: HotUpdaterSandboxStore {
    var pendingLinks: [String] = []
    var selected: [String] = []
    var opened: [String] = []
    var lastLaunch: HotUpdaterSandboxLastLaunch?
    var openedBundles: [String] = []

    func recordSelected(_ selection: HotUpdaterSandboxSelection) {
        selected.append(selection.channel)
    }

    func recordOpened(_ selection: HotUpdaterSandboxSelection) {
        opened.append(selection.channel)
        openedBundles.append(selection.bundleId)
    }
}

/// Lets the coordinator's tasks run, including a copy off the main actor.
@MainActor
private func settle() async {
    for index in 0 ..< 50 {
        await Task.yield()
        if index % 10 == 0 { try? await Task.sleep(nanoseconds: 2_000_000) }
    }
}

/// A directory of its own, for each test's files.
private func temporaryDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("sandbox-shelf-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// A bundle as main's store installs it: its manifest, the JavaScript, and an image.
private func install(_ bundleId: String, in store: URL, skipping: String? = nil) {
    let directory = store.appendingPathComponent(bundleId, isDirectory: true)
    try? FileManager.default.createDirectory(at: directory.appendingPathComponent("assets"), withIntermediateDirectories: true)
    let assets = ["index.ios.bundle", "assets/logo.png"]
    let manifest: [String: Any] = [
        "bundleId": bundleId,
        "assets": Dictionary(uniqueKeysWithValues: assets.map { ($0, ["fileHash": "hash"]) }),
    ]
    try? JSONSerialization.data(withJSONObject: manifest).write(to: directory.appendingPathComponent("manifest.json"))
    for asset in assets where asset != skipping {
        try? Data("\(bundleId) \(asset)".utf8).write(to: directory.appendingPathComponent(asset))
    }
}

private func makeShelf(_ root: URL, key: String = "key", storesBundles: Bool = true) -> HotUpdaterSandboxShelf {
    HotUpdaterSandboxShelf(
        root: root.appendingPathComponent("shelf", isDirectory: true),
        source: root.appendingPathComponent("bundle-store", isDirectory: true),
        isolationKey: key,
        storesBundles: storesBundles
    )
}

@MainActor
private struct Fixture {
    let host = FakeHost()
    let store = FakeStore()
    let lock = HotUpdaterSandboxLock()
    let files = temporaryDirectory()
    let shelf: HotUpdaterSandboxShelf
    var opens: [(Bool, Bool)] { box.opens }
    private let box = Box()
    let coordinator: HotUpdaterSandboxCoordinator

    private final class Box {
        var opens: [(Bool, Bool)] = []
    }

    init(pendingLinks: [String] = []) {
        store.pendingLinks = pendingLinks
        let box = box
        shelf = makeShelf(files)
        // What the fake check installs.
        install("ota", in: shelf.source)
        coordinator = HotUpdaterSandboxCoordinator(
            host: host,
            store: store,
            shelf: shelf,
            openApp: { box.opens.append(($0, $1)) },
            now: { Date(timeIntervalSince1970: 1000) },
            lock: lock
        )
    }
}

@MainActor
struct HotUpdaterSandboxCoordinatorTests {
    @Test
    func inADevSessionAConfirmedLinkExitsItAndIsAskedAgain() async {
        let fixture = Fixture()
        fixture.host.runsDevServer = true
        fixture.coordinator.receiveLink(link("pr-1"))
        fixture.coordinator.confirmLink()
        await settle()
        #expect(fixture.host.devExits == 1)
        #expect(fixture.host.calls.isEmpty)
        #expect(fixture.store.pendingLinks == [link("pr-1")])
        guard case .confirming = fixture.coordinator.state.phase else {
            Issue.record("expected the link to ask again")
            return
        }
    }

    @Test
    func openingInADevSessionRecordsNoBundleAsOpened() async {
        let fixture = Fixture()
        fixture.host.runsDevServer = true
        await fixture.coordinator.open()
        #expect(fixture.store.opened.isEmpty)
        #expect(fixture.opens.count == 1)
    }

    @Test
    func aDevSessionsOpenNeverReloadsWhateverThisLaunchAndTheNextOneSay() async {
        // What makes a normal launch fixed: it runs one bundle, and the next selects another.
        let normal = Fixture()
        normal.host.runningBundleId = "ota-1"
        normal.host.bundleId = "ota-2"
        await normal.coordinator.open()
        #expect(normal.opens.first?.1 == true)

        let dev = Fixture()
        dev.host.runsDevServer = true
        dev.host.runningBundleId = "ota-1"
        dev.host.bundleId = "ota-2"
        await dev.coordinator.refresh()
        await dev.coordinator.open()
        #expect(dev.opens.first?.1 == false)
        #expect(dev.store.opened.isEmpty)
    }

    @Test
    func inADevSessionARowOrAResetAsksToExitFirstAndChangesNothing() async {
        let fixture = Fixture()
        fixture.host.runsDevServer = true
        #expect(fixture.coordinator.switchTo("pr-1"))
        await settle()
        guard case .failed(_, _, _, .error(let message), _) = fixture.coordinator.state.phase else {
            Issue.record("expected a failure")
            return
        }
        #expect(message == "The dev server is running. Exit it, then try again.")
        #expect(fixture.host.calls.isEmpty)
        fixture.coordinator.dismiss()
        #expect(fixture.coordinator.resetToBuiltIn())
        await settle()
        #expect(fixture.host.calls.isEmpty)
        #expect(fixture.host.devExits == 0)
    }

    @Test
    func aSessionThatStartsDuringASwitchStopsItBeforeAnythingChanges() async {
        let fixture = Fixture()
        let preflight = Gate<Bool>()
        fixture.host.preflightGate = preflight
        #expect(fixture.coordinator.switchTo("pr-1"))
        await settle()
        #expect(fixture.host.calls == ["preflight pr-1"])
        // A dev server's session starts while the preflight awaits.
        fixture.host.runsDevServer = true
        preflight.finish(.success(true))
        await settle()
        #expect(fixture.host.calls == ["preflight pr-1"], "the switch went on in a dev session")
        guard case .failed(_, _, _, .error(let message), _) = fixture.coordinator.state.phase else {
            Issue.record("expected a failure")
            return
        }
        #expect(message == "The dev server is running. Exit it, then try again.")
    }

    @Test
    func aSwitchWhileADevServerConnectsIsRefusedAndChangesNothing() async {
        let fixture = Fixture()
        #expect(fixture.lock.take(.devServer))
        #expect(fixture.coordinator.switchTo("pr-1"))
        await settle()
        #expect(fixture.host.calls.isEmpty)
        guard case .failed(_, _, _, .error(let message), _) = fixture.coordinator.state.phase else {
            Issue.record("expected a failure")
            return
        }
        #expect(message == "A dev server is connecting. Wait for it, then try again.")
        fixture.coordinator.dismiss()
        #expect(fixture.coordinator.resetToBuiltIn())
        await settle()
        #expect(fixture.host.calls.isEmpty)
        fixture.coordinator.dismiss()
        fixture.lock.release(.devServer)
        #expect(fixture.coordinator.switchTo("pr-1"))
        await settle()
        #expect(fixture.host.calls == ["preflight pr-1", "reset", "check pr-1"])
    }

    @Test
    func aSwitchHoldsTheLockUntilItEndsEitherWay() async {
        let fixture = Fixture()
        let preflight = Gate<Bool>()
        fixture.host.preflightGate = preflight
        #expect(fixture.coordinator.switchTo("pr-1"))
        await settle()
        #expect(fixture.lock.holder == .switching)
        preflight.finish(.failure(FakeError.offline))
        await settle()
        #expect(fixture.lock.holder == nil)
        fixture.host.preflightGate = nil
        fixture.coordinator.retry()
        await settle()
        #expect(fixture.host.calls == ["preflight pr-1", "preflight pr-1", "reset", "check pr-1"])
        #expect(fixture.lock.holder == nil)
        #expect(fixture.coordinator.resetToBuiltIn())
        await settle()
        #expect(fixture.lock.holder == nil)
    }

    @Test
    func aLinkConfirmsThenRunsEveryStepInOrderAndOpens() async {
        let fixture = Fixture()
        fixture.coordinator.receiveLink(link("pr-1"))
        guard case .confirming(let parsed) = fixture.coordinator.state.phase else {
            Issue.record("expected a confirmation")
            return
        }
        #expect(parsed.channel == "pr-1")
        #expect(fixture.host.calls.isEmpty)

        fixture.coordinator.confirmLink()
        await settle()
        #expect(fixture.host.calls == ["preflight pr-1", "reset", "check pr-1"])
        #expect(fixture.coordinator.state.phase == .idle)
        #expect(fixture.opens.count == 1)
        #expect(fixture.opens[0] == (true, false))
        #expect(fixture.store.pendingLinks.isEmpty)
        #expect(fixture.store.selected == ["pr-1"])
        #expect(fixture.store.opened == ["pr-1"])
    }

    @Test
    func anotherFingerprintIsRefusedBeforeAnyRequest() async {
        let fixture = Fixture()
        fixture.coordinator.receiveLink(link("pr-1", fingerprintHash: "other"))
        #expect(fixture.coordinator.state.phase == .refused(.otherFingerprint(
            link: HotUpdaterSandboxLink(url: link("pr-1", fingerprintHash: "other"))!,
            buildFingerprintHash: "abc"
        )))
        #expect(fixture.host.calls.isEmpty)
        #expect(fixture.store.pendingLinks.isEmpty)
    }

    @Test
    func aRefusedLinkDeliveredTwiceAsksOnce() async {
        let fixture = Fixture()
        let refused = link("pr-1", fingerprintHash: "other")
        fixture.coordinator.receiveLink(refused)
        fixture.coordinator.receiveLink(refused)
        #expect(fixture.store.pendingLinks.isEmpty)
        fixture.coordinator.dismiss()
        #expect(fixture.coordinator.state.phase == .idle)
        // Sent again after the answer, it's a new question.
        fixture.coordinator.receiveLink(refused)
        guard case .refused = fixture.coordinator.state.phase else {
            Issue.record("expected a refusal")
            return
        }
    }

    @Test
    func aBuildWithoutAFingerprintRefusesEveryLink() async {
        let fixture = Fixture()
        fixture.host.fingerprint = nil
        fixture.coordinator.receiveLink(link("pr-1"))
        guard case .refused(.otherFingerprint(_, let build)) = fixture.coordinator.state.phase else {
            Issue.record("expected a refusal")
            return
        }
        #expect(build == nil)
    }

    @Test
    func aPastedLinkHasTheFingerprintCheckAndConfirmsLikeAScannedOne() async {
        let fixture = Fixture()
        fixture.coordinator.switchTo("  \(link("pr-1", fingerprintHash: "other")) ")
        guard case .refused(.otherFingerprint) = fixture.coordinator.state.phase else {
            Issue.record("expected a refusal")
            return
        }
        fixture.coordinator.dismiss()
        fixture.coordinator.switchTo(link("pr-2"))
        guard case .confirming = fixture.coordinator.state.phase else {
            Issue.record("expected a confirmation")
            return
        }
    }

    @Test
    func aRowRunsWithoutAConfirmation() async {
        let fixture = Fixture()
        #expect(fixture.coordinator.switchTo("pr-1"))
        await settle()
        #expect(fixture.host.calls == ["preflight pr-1", "reset", "check pr-1"])
    }

    @Test
    func anInvalidTypedChannelIsRefused() async {
        let fixture = Fixture()
        fixture.coordinator.switchTo("")
        #expect(fixture.coordinator.state.phase == .refused(.invalidChannel("")))
    }

    @Test
    func anUnreadableLinkIsRefusedAndConsumed() async {
        let fixture = Fixture()
        fixture.coordinator.receiveLink("hu-sandbox-app://hot-updater/other")
        #expect(fixture.coordinator.state.phase == .refused(.unreadable(url: "hu-sandbox-app://hot-updater/other")))
        #expect(fixture.store.pendingLinks.isEmpty)
    }

    @Test
    func theSameUrlCountsOnceWhetherWaitingOrRunning() async {
        let fixture = Fixture()
        let gate = Gate<Bool>()
        fixture.host.preflightGate = gate
        fixture.coordinator.receiveLink(link("pr-1"))
        fixture.coordinator.receiveLink(link("pr-1"))
        #expect(fixture.store.pendingLinks == [link("pr-1")])
        fixture.coordinator.confirmLink()
        await settle()
        fixture.coordinator.receiveLink(link("pr-1"))
        #expect(fixture.store.pendingLinks == [link("pr-1")])
        #expect(fixture.coordinator.state.queuedLinks == 0)
        gate.finish(.success(true))
        await settle()
        #expect(fixture.host.calls.filter { $0 == "reset" }.count == 1)
    }

    @Test
    func aSecondLinkQueuesForItsOwnConfirmationAndHoldsTheOpen() async {
        let fixture = Fixture()
        let gate = Gate<HotUpdaterSandboxStaged>()
        fixture.host.stageGate = gate
        fixture.coordinator.receiveLink(link("pr-1"))
        fixture.coordinator.confirmLink()
        await settle()
        fixture.coordinator.receiveLink(link("pr-2"))
        guard case .working(_, "pr-1", _, _) = fixture.coordinator.state.phase else {
            Issue.record("expected the first switch to keep running")
            return
        }
        #expect(fixture.coordinator.state.queuedLinks == 1)
        gate.finish(.success(.update(bundleId: "ota-1")))
        await settle()
        guard case .confirming(let next) = fixture.coordinator.state.phase else {
            Issue.record("expected the second link's confirmation")
            return
        }
        #expect(next.channel == "pr-2")
        #expect(fixture.opens.isEmpty)
        fixture.coordinator.dismiss()
        #expect(fixture.opens.count == 1)
        #expect(fixture.store.pendingLinks.isEmpty)
    }

    @Test
    func aRowOrResetCantStartDuringASwitch() async {
        let fixture = Fixture()
        let gate = Gate<Bool>()
        fixture.host.preflightGate = gate
        #expect(fixture.coordinator.switchTo("pr-1"))
        #expect(!fixture.coordinator.switchTo("pr-2"))
        #expect(!fixture.coordinator.resetToBuiltIn())
        gate.finish(.success(true))
        await settle()
        #expect(fixture.host.calls == ["preflight pr-1", "reset", "check pr-1"])
    }

    @Test
    func aFailedPreflightLeavesEverythingDownloadedInPlace() async {
        let fixture = Fixture()
        fixture.host.channel = "pr-0"
        fixture.host.bundleId = "ota-0"
        fixture.host.preflights["pr-1"] = .failure(FakeError.offline)
        fixture.coordinator.switchTo("pr-1")
        await settle()
        guard case .failed(_, "pr-1", .preflight, .error, let selection) = fixture.coordinator.state.phase else {
            Issue.record("expected the preflight's failure")
            return
        }
        #expect(selection.channel == "pr-0")
        #expect(selection.bundleId == "ota-0")
        #expect(!fixture.host.calls.contains("reset"))
        #expect(fixture.opens.isEmpty)
    }

    @Test
    func anEmptyChannelStopsBeforeTheReset() async {
        let fixture = Fixture()
        fixture.host.preflights["pr-1"] = .success(false)
        fixture.coordinator.switchTo("pr-1")
        await settle()
        guard case .failed(_, _, .preflight, .noBundle, _) = fixture.coordinator.state.phase else {
            Issue.record("expected no bundle")
            return
        }
        #expect(fixture.host.calls == ["preflight pr-1"])
    }

    @Test
    func goingOfflineAfterThePreflightShowsTheBuiltInSelectionAndRetries() async {
        let fixture = Fixture()
        fixture.host.channel = "pr-0"
        fixture.host.bundleId = "ota-0"
        fixture.host.stageResult = .failure(FakeError.offline)
        fixture.coordinator.switchTo("pr-1")
        await settle()
        guard case .failed(let first, "pr-1", .check, .error, let selection) = fixture.coordinator.state.phase else {
            Issue.record("expected the check's failure")
            return
        }
        // The reset ran: the bundle that's gone isn't what the screen says.
        #expect(selection.channel == "sandbox-release")
        #expect(selection.isBuiltIn)
        #expect(fixture.coordinator.state.selection == selection)
        #expect(fixture.opens.isEmpty)

        fixture.host.stageResult = .success(.update(bundleId: "ota-1"))
        fixture.coordinator.retry()
        await settle()
        #expect(fixture.opens.count == 1)
        #expect(fixture.host.channel == "pr-1")
        #expect(fixture.host.calls.filter { $0 == "preflight pr-1" }.count == 2)
        #expect(first == 1)
    }

    @Test
    func goingOfflineOverARunningOtaShowsTheBuiltInSelectionNotTheDeletedBundle() async {
        let fixture = Fixture()
        fixture.host.channel = "pr-0"
        fixture.host.bundleId = "ota-0"
        fixture.host.runningBundleId = "ota-0"
        fixture.host.stageResult = .failure(FakeError.offline)
        fixture.coordinator.switchTo("pr-1")
        await settle()
        guard case .failed(_, _, _, _, let selection) = fixture.coordinator.state.phase else {
            Issue.record("expected the check's failure")
            return
        }
        #expect(selection.bundleId == "built-in")
        #expect(selection.isBuiltIn)
        #expect(fixture.store.selected == ["sandbox-release"])
    }

    @Test
    func theNextLaunchIsWhatStorageHoldsOnceALaunchIsFixed() {
        func next(_ running: String?, _ launch: String?, _ active: String?) -> String {
            hotUpdaterSandboxNextLaunchBundleId(
                runningBundleId: running,
                launchBundleId: launch,
                activeBundleId: active,
                builtInBundleId: "built-in"
            )
        }
        // Before any launch, the SDK's read is what a launch would pick.
        #expect(next(nil, "ota", "ota") == "ota")
        #expect(next(nil, nil, nil) == "built-in")
        // A running OTA a reset deleted: its read still names it, and storage holds nothing.
        #expect(next("ota", "ota", nil) == "built-in")
        // A running OTA with another staged.
        #expect(next("ota", "ota", "next") == "next")
        // A launch of the built-in bundle with an OTA staged since.
        #expect(next(nil, nil, "next") == "next")
    }

    @Test
    func openOverARunningAppRecordsWhatItRunsAndLeavesWhatsStagedForItsLaunch() async {
        let fixture = Fixture()
        fixture.host.bundleId = "next"
        fixture.host.runningBundleId = "ota-0"
        fixture.host.appRunning = true
        await fixture.coordinator.open()
        #expect(fixture.store.openedBundles == ["ota-0"])
        #expect(fixture.opens[0] == (false, false))
    }

    @Test
    func openBeforeTheAppStartsReloadsAFixedLaunchIntoWhatsSelected() async {
        let fixture = Fixture()
        fixture.host.bundleId = "built-in"
        fixture.host.runningBundleId = "ota-0"
        await fixture.coordinator.open()
        #expect(fixture.store.openedBundles == ["built-in"])
        #expect(fixture.opens[0] == (false, true))
    }

    @Test
    func theDefaultChannelWithNothingPublishedNeedsAReloadOverAFixedLaunch() async {
        let fixture = Fixture()
        fixture.host.channel = "pr-1"
        fixture.host.bundleId = "ota-1"
        fixture.host.runningBundleId = "ota-1"
        fixture.host.preflights["sandbox-release"] = .success(false)
        fixture.host.stageResult = .success(.noUpdate)
        fixture.coordinator.switchTo("sandbox-release")
        await settle()
        #expect(fixture.opens.count == 1)
        #expect(fixture.opens[0] == (true, true))
        #expect(fixture.coordinator.state.selection?.bundleId == "built-in")
    }

    @Test
    func resetNeedsAReloadOverAFixedLaunch() async {
        let fixture = Fixture()
        fixture.host.channel = "pr-1"
        fixture.host.bundleId = "ota-1"
        fixture.host.runningBundleId = "ota-1"
        fixture.coordinator.resetToBuiltIn()
        await settle()
        #expect(fixture.opens.count == 1)
        #expect(fixture.opens[0] == (true, true))
    }

    @Test
    func aLaunchThatAlreadyRunsTheSelectionNeedsNoReload() async {
        let fixture = Fixture()
        fixture.host.channel = "pr-1"
        fixture.host.bundleId = "ota-1"
        fixture.host.runningBundleId = "ota-1"
        fixture.host.stageResult = .success(.noUpdate)
        fixture.coordinator.switchTo("pr-1")
        await settle()
        #expect(fixture.opens.count == 1)
        #expect(fixture.opens[0] == (true, false))
    }

    @Test
    func noFixedLaunchNeedsNoReloadWhateverTheSwitchDid() async {
        let fixture = Fixture()
        fixture.host.channel = "pr-1"
        fixture.host.bundleId = "ota-1"
        fixture.host.preflights["sandbox-release"] = .success(false)
        fixture.host.stageResult = .success(.noUpdate)
        fixture.coordinator.switchTo("sandbox-release")
        await settle()
        #expect(fixture.opens.count == 1)
        #expect(fixture.opens[0] == (true, false))
    }

    @Test
    func openAfterAFailedSwitchReloadsAFixedLaunchOutOfTheDeletedBundle() async {
        let fixture = Fixture()
        fixture.host.channel = "pr-0"
        fixture.host.bundleId = "ota-0"
        fixture.host.runningBundleId = "ota-0"
        fixture.host.stageResult = .failure(FakeError.offline)
        fixture.coordinator.switchTo("pr-1")
        await settle()
        fixture.coordinator.dismiss()
        #expect(fixture.opens.isEmpty)
        await fixture.coordinator.open()
        #expect(fixture.opens.count == 1)
        #expect(fixture.opens[0] == (false, true))
    }

    @Test
    func aQueuedLinkThatFailsDecidesTheReloadNotTheSwitchBeforeIt() async {
        let fixture = Fixture()
        fixture.host.channel = "pr-0"
        fixture.host.bundleId = "ota-1"
        fixture.host.runningBundleId = "ota-1"
        fixture.host.stageResult = .success(.update(bundleId: "ota-1"))
        fixture.coordinator.receiveLink(link("pr-1"))
        fixture.coordinator.receiveLink(link("pr-2"))
        fixture.coordinator.confirmLink()
        await settle()
        // The first switch selects what this launch already runs.
        guard case .confirming = fixture.coordinator.state.phase else {
            Issue.record("expected the second link's confirmation")
            return
        }
        fixture.host.stageResult = .failure(FakeError.offline)
        fixture.coordinator.confirmLink()
        await settle()
        guard case .failed = fixture.coordinator.state.phase else {
            Issue.record("expected the second link's failure")
            return
        }
        #expect(fixture.opens.isEmpty)
        // The second reset deleted it, so the first switch's open can't keep its answer.
        fixture.coordinator.dismiss()
        #expect(fixture.opens.count == 1)
        #expect(fixture.opens[0] == (true, true))
    }

    @Test
    func nothingForTheTargetAfterTheResetIsAFailureThatSaysSo() async {
        let fixture = Fixture()
        fixture.host.stageResult = .success(.noUpdate)
        fixture.coordinator.switchTo("pr-1")
        await settle()
        guard case .failed(_, _, .check, .noBundle, _) = fixture.coordinator.state.phase else {
            Issue.record("expected no bundle")
            return
        }
        #expect(fixture.opens.isEmpty)
    }

    @Test
    func theDefaultChannelWithNothingNewerIsTheBuiltInBundle() async {
        let fixture = Fixture()
        fixture.host.channel = "pr-1"
        fixture.host.bundleId = "ota-1"
        fixture.host.preflights["sandbox-release"] = .success(false)
        fixture.host.stageResult = .success(.noUpdate)
        fixture.coordinator.switchTo("sandbox-release")
        await settle()
        #expect(fixture.coordinator.state.phase == .idle)
        #expect(fixture.opens.count == 1)
        #expect(fixture.host.calls.contains("reset"))
        #expect(fixture.coordinator.state.selection?.isBuiltIn == true)
    }

    @Test
    func aSwitchToTheCurrentChannelKeepsWhatIsDownloaded() async {
        let fixture = Fixture()
        fixture.host.channel = "pr-1"
        fixture.host.bundleId = "ota-1"
        fixture.host.stageResult = .success(.noUpdate)
        fixture.coordinator.switchTo("pr-1")
        await settle()
        #expect(!fixture.host.calls.contains("reset"))
        #expect(fixture.opens.count == 1)
    }

    @Test
    func aSupersededStagingIsAFailure() async {
        let fixture = Fixture()
        fixture.host.stageResult = .success(.superseded)
        fixture.coordinator.switchTo("pr-1")
        await settle()
        guard case .failed(_, _, .check, .superseded, _) = fixture.coordinator.state.phase else {
            Issue.record("expected superseded")
            return
        }
    }

    @Test
    func aRunningChecksChannelSwitchIsDetected() async {
        let fixture = Fixture()
        // The running app's own check moved the channel during the SDK's steps.
        fixture.host.channelAfterStaging = "other"
        fixture.coordinator.switchTo("pr-1")
        await settle()
        guard case .failed(_, _, .check, .superseded, let selection) = fixture.coordinator.state.phase else {
            Issue.record("expected superseded")
            return
        }
        #expect(selection.channel == "other")
        #expect(fixture.opens.isEmpty)
    }

    @Test
    func aFixedLaunchNeedsAReload() async {
        let fixture = Fixture()
        fixture.host.bundleId = "ota-0"
        fixture.host.runningBundleId = "ota-0"
        fixture.coordinator.switchTo("pr-1")
        await settle()
        #expect(fixture.opens.count == 1)
        #expect(fixture.opens[0] == (true, true))
        // The screen says what the next launch runs, not what this one does.
        #expect(fixture.coordinator.state.selection?.bundleId == "ota")
    }

    @Test
    func aLateProgressReportChangesNothing() async {
        let fixture = Fixture()
        fixture.coordinator.switchTo("pr-1")
        await settle()
        #expect(fixture.coordinator.state.phase == .idle)
        fixture.host.progressReporter?(0.5)
        await settle()
        #expect(fixture.coordinator.state.phase == .idle)
    }

    @Test
    func progressBelongsToItsOperation() async {
        let fixture = Fixture()
        let gate = Gate<HotUpdaterSandboxStaged>()
        fixture.host.stageGate = gate
        fixture.coordinator.switchTo("pr-1")
        await settle()
        fixture.host.progressReporter?(0.5)
        await settle()
        guard case .working(_, "pr-1", .download, 0.5) = fixture.coordinator.state.phase else {
            Issue.record("expected the download's progress")
            return
        }
        gate.finish(.success(.update(bundleId: "ota")))
        await settle()
    }

    @Test
    func aPendingLinkWaitsForAServerAnswerAndSurvivesARestart() async {
        let first = Fixture()
        first.host.serverConfig = false
        first.coordinator.receiveLink(link("pr-1"))
        guard case .waitingForServer = first.coordinator.state.phase else {
            Issue.record("expected the link to wait")
            return
        }
        #expect(first.store.pendingLinks == [link("pr-1")])

        // The next process reads it back, and a server has answered by then.
        let second = Fixture(pendingLinks: first.store.pendingLinks)
        await second.coordinator.refresh()
        guard case .confirming = second.coordinator.state.phase else {
            Issue.record("expected the link's confirmation")
            return
        }
    }

    @Test
    func aPendingLinkRevalidatesItsFingerprint() async {
        let fixture = Fixture(pendingLinks: [link("pr-1", fingerprintHash: "old")])
        await fixture.coordinator.refresh()
        guard case .refused(.otherFingerprint) = fixture.coordinator.state.phase else {
            Issue.record("expected a refusal")
            return
        }
        #expect(fixture.store.pendingLinks.isEmpty)
    }

    @Test
    func aScreenClosesOnlyOnceNothingIsLeftToAnswer() async {
        let fixture = Fixture()
        var closes = 0
        fixture.coordinator.receiveLink(link("pr-1"))
        fixture.coordinator.receiveLink(link("pr-2", fingerprintHash: "other"))
        fixture.coordinator.receiveLink(link("pr-3"))

        // Declined: the refusal behind it is on screen now.
        fixture.coordinator.dismiss { closes += 1 }
        guard case .refused = fixture.coordinator.state.phase else {
            Issue.record("expected the refusal")
            return
        }
        #expect(closes == 0)

        // Acknowledged: the third link asks next.
        fixture.coordinator.dismiss { closes += 1 }
        guard case .confirming(let next) = fixture.coordinator.state.phase else {
            Issue.record("expected the third link")
            return
        }
        #expect(next.channel == "pr-3")
        #expect(closes == 0)

        fixture.coordinator.dismiss { closes += 1 }
        #expect(fixture.coordinator.state.phase == .idle)
        #expect(closes == 1)
    }

    @Test
    func aDeclinedLinkIsForgotten() async {
        let fixture = Fixture()
        fixture.coordinator.receiveLink(link("pr-1"))
        fixture.coordinator.dismiss()
        #expect(fixture.coordinator.state.phase == .idle)
        #expect(fixture.store.pendingLinks.isEmpty)
        #expect(fixture.host.calls.isEmpty)
    }

    @Test
    func openRecordsWhatOpenedAndDoesNotReadAsASwitch() async {
        let fixture = Fixture()
        await fixture.coordinator.open()
        #expect(fixture.opens.count == 1)
        #expect(fixture.opens[0] == (false, false))
        #expect(fixture.store.opened == ["sandbox-release"])
        #expect(fixture.store.selected.isEmpty)
    }

    @Test
    func resetReturnsToTheBuiltInBundle() async {
        let fixture = Fixture()
        fixture.host.channel = "pr-1"
        fixture.host.bundleId = "ota-1"
        #expect(fixture.coordinator.resetToBuiltIn())
        #expect(!fixture.coordinator.switchTo("pr-2"))
        await settle()
        #expect(fixture.host.calls == ["reset"])
        #expect(fixture.coordinator.state.selection?.isBuiltIn == true)
    }

    @Test
    func aFailedResetSaysSo() async {
        let fixture = Fixture()
        fixture.host.resetResult = .success(false)
        fixture.coordinator.resetToBuiltIn()
        await settle()
        guard case .failed(_, _, .reset, .resetFailed, _) = fixture.coordinator.state.phase else {
            Issue.record("expected the reset's failure")
            return
        }
    }
}

struct HotUpdaterSandboxLinkTests {
    private static let vectors: [String: Any] = {
        let packages = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // Sandbox
            .deletingLastPathComponent() // Test
            .deletingLastPathComponent() // HotUpdater
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // react-native
            .deletingLastPathComponent() // packages
        let url = packages.appendingPathComponent("test-utils/fixtures/sandbox-preview-links.json")
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            fatalError("Cannot read the vectors at \(url.path)")
        }
        return object
    }()

    @Test
    func readsWhatTheProtocolReads() {
        let valid = Self.vectors["valid"] as! [[String: String]]
        #expect(!valid.isEmpty)
        for vector in valid {
            let parsed = HotUpdaterSandboxLink(url: vector["link"]!)
            #expect(parsed?.urlScheme == vector["urlScheme"])
            #expect(parsed?.channel == vector["channel"])
            #expect(parsed?.fingerprintHash == vector["fingerprintHash"])
        }
    }

    @Test
    func refusesWhatTheProtocolRefuses() {
        let invalid = Self.vectors["invalid"] as! [String]
        #expect(!invalid.isEmpty)
        for url in invalid {
            #expect(HotUpdaterSandboxLink(url: url) == nil, "\(url)")
        }
    }
}

struct HotUpdaterSandboxLaunchPolicyTests {
    @Test
    func anIconLaunchHasNoReason() {
        #expect(!HotUpdaterSandboxLaunchPolicy.isForTheApp(optionKeys: [], urlScheme: nil))
    }

    @Test
    func aSandboxLinkAloneIsntForTheApp() {
        #expect(!HotUpdaterSandboxLaunchPolicy.isForTheApp(
            optionKeys: ["UIApplicationLaunchOptionsURLKey", "UIApplicationLaunchOptionsSourceApplicationKey"],
            urlScheme: "hu-sandbox-app"
        ))
    }

    @Test
    func everyOtherReasonIs() {
        for key in [
            "UIApplicationLaunchOptionsRemoteNotificationKey",
            "UIApplicationLaunchOptionsUserActivityDictionaryKey",
            "UIApplicationLaunchOptionsShortcutItemKey",
            "UIApplicationLaunchOptionsLocationKey",
            "SomethingNew",
        ] {
            #expect(HotUpdaterSandboxLaunchPolicy.isForTheApp(optionKeys: [key], urlScheme: nil))
        }
        #expect(HotUpdaterSandboxLaunchPolicy.isForTheApp(optionKeys: ["UIApplicationLaunchOptionsURLKey"], urlScheme: "myapp"))
        // A sandbox link can't hide a notification.
        #expect(HotUpdaterSandboxLaunchPolicy.isForTheApp(
            optionKeys: ["UIApplicationLaunchOptionsURLKey", "UIApplicationLaunchOptionsRemoteNotificationKey"],
            urlScheme: "hu-sandbox-app"
        ))
    }
}
private func selection(
    channel: String = "pr-1",
    bundleId: String = "ota",
    defaultChannel: String = "sandbox-release",
    builtIn: String = "built-in"
) -> HotUpdaterSandboxSelection {
    HotUpdaterSandboxSelection(
        channel: channel,
        defaultChannel: defaultChannel,
        bundleId: bundleId,
        isBuiltIn: bundleId == builtIn
    )
}

/// Three launches the SDK can leave, as its own files state them. Each expectation
/// comes from what happened to the device, not from what the derivation returns.
struct HotUpdaterSandboxLastLaunchTests {
    private typealias LastLaunch = HotUpdaterSandboxLastLaunch

    @Test
    func aCrashBeforeFirstContentRolledBack() {
        let evidence = HotUpdaterSandboxLaunchEvidence(
            marker: HotUpdaterSandboxCrashMarker(bundleId: "ota", shouldRollback: true),
            rollback: HotUpdaterSandboxRollback(fromBundleId: "ota", toBundleId: "built-in")
        )
        #expect(LastLaunch.derive(evidence: evidence, launchBundleId: "built-in") == LastLaunch(
            kind: .crashedBeforeContent,
            bundleId: "ota",
            rolledBackToBundleId: "built-in"
        ))
    }

    @Test
    func aVerifiedCrashDidNotRollBack() {
        let evidence = HotUpdaterSandboxLaunchEvidence(
            marker: HotUpdaterSandboxCrashMarker(bundleId: "ota", shouldRollback: false)
        )
        #expect(LastLaunch.derive(evidence: evidence, launchBundleId: "ota") == LastLaunch(
            kind: .crashed,
            bundleId: "ota",
            rolledBackToBundleId: nil
        ))
    }

    @Test
    func leavingBeforeFirstContentLeavesNoMarkerAndNoCrashIsClaimed() {
        let evidence = HotUpdaterSandboxLaunchEvidence(
            rollback: HotUpdaterSandboxRollback(fromBundleId: "ota", toBundleId: "built-in")
        )
        #expect(LastLaunch.derive(evidence: evidence, launchBundleId: "built-in") == LastLaunch(
            kind: .endedBeforeContent,
            bundleId: "ota",
            rolledBackToBundleId: "built-in"
        ))
    }

    @Test
    func aMarkerOfAnotherBundleIsNotThatRollbacksCrash() {
        let evidence = HotUpdaterSandboxLaunchEvidence(
            marker: HotUpdaterSandboxCrashMarker(bundleId: "other", shouldRollback: true),
            rollback: HotUpdaterSandboxRollback(fromBundleId: "ota", toBundleId: "built-in")
        )
        #expect(LastLaunch.derive(evidence: evidence, launchBundleId: "built-in")?.kind == .endedBeforeContent)
    }

    @Test
    func noRollbackIsClaimedWhenTheSelectionIsSomewhereElse() {
        let evidence = HotUpdaterSandboxLaunchEvidence(
            marker: HotUpdaterSandboxCrashMarker(bundleId: "ota", shouldRollback: true),
            rollback: HotUpdaterSandboxRollback(fromBundleId: "ota", toBundleId: "built-in")
        )
        let last = LastLaunch.derive(evidence: evidence, launchBundleId: "newer")
        #expect(last?.kind == .crashed)
        #expect(last?.rolledBackToBundleId == nil)
    }

    @Test
    func nothingLeftSaysNothing() {
        #expect(LastLaunch.derive(evidence: HotUpdaterSandboxLaunchEvidence(), launchBundleId: "ota") == nil)
    }
}

@MainActor
struct HotUpdaterSandboxScreenStateTests {
    @Test
    func openingTheScreenSendsNoRequestInAnyState() async {
        let crashed = Fixture()
        crashed.host.evidence = HotUpdaterSandboxLaunchEvidence(
            marker: HotUpdaterSandboxCrashMarker(bundleId: "built-in", shouldRollback: false)
        )
        let fresh = Fixture()
        fresh.host.serverConfig = false
        let waiting = Fixture(pendingLinks: [link("pr-1")])
        waiting.host.serverConfig = false
        for fixture in [Fixture(), crashed, fresh, waiting, Fixture(pendingLinks: [link("pr-1")])] {
            let stop = fixture.coordinator.observe { _ in }
            await fixture.coordinator.refresh()
            await fixture.coordinator.noteLastLaunch()
            stop()
            await settle()
            #expect(fixture.host.calls.isEmpty)
        }
    }

    @Test
    func aCrashIsToldOnceAPersonMovesOnNotBefore() async {
        let fixture = Fixture()
        fixture.host.bundleId = "ota"
        fixture.host.channel = "pr-1"
        fixture.host.evidence = HotUpdaterSandboxLaunchEvidence(
            marker: HotUpdaterSandboxCrashMarker(bundleId: "ota", shouldRollback: false)
        )
        await fixture.coordinator.refresh()
        #expect(fixture.coordinator.state.lastLaunch?.kind == .crashed)
        #expect(fixture.store.lastLaunch?.kind == .crashed)

        await fixture.coordinator.open()
        #expect(fixture.coordinator.state.lastLaunch == nil)
        // The marker this process read stays readable, and it's not told again.
        await fixture.coordinator.refresh()
        #expect(fixture.coordinator.state.lastLaunch == nil)
        #expect(fixture.store.lastLaunch == nil)
    }

    @Test
    func anUnseenCrashSurvivesARestartWithNoEvidenceLeft() async {
        let fixture = Fixture()
        fixture.store.lastLaunch = HotUpdaterSandboxLastLaunch(
            kind: .crashedBeforeContent,
            bundleId: "ota",
            rolledBackToBundleId: "built-in"
        )
        await fixture.coordinator.refresh()
        #expect(fixture.coordinator.state.lastLaunch?.kind == .crashedBeforeContent)
    }

    @Test
    func aSwitchEndsWhatTheLastLaunchLeft() async {
        let fixture = Fixture()
        fixture.host.evidence = HotUpdaterSandboxLaunchEvidence(
            marker: HotUpdaterSandboxCrashMarker(bundleId: "built-in", shouldRollback: false)
        )
        await fixture.coordinator.refresh()
        #expect(fixture.coordinator.state.lastLaunch != nil)
        fixture.coordinator.switchTo("pr-1")
        await settle()
        #expect(fixture.coordinator.state.lastLaunch == nil)
    }

    @Test
    func aSwitchListsWhatItDownloadedWithItsMessage() async {
        let fixture = Fixture()
        fixture.host.stageResult = .success(.update(bundleId: "ota", message: "fix: login"))
        fixture.coordinator.switchTo("pr-1")
        await settle()
        #expect(fixture.shelf.entries == [HotUpdaterSandboxShelfEntry(
            bundleId: "ota",
            channel: "pr-1",
            message: "fix: login",
            isolationKey: "key",
            downloadedAtMs: 1_000_000
        )])
        #expect(fixture.shelf.stored("ota") != nil)
        #expect(fixture.coordinator.state.selectedMessage == "fix: login")
        #expect(fixture.coordinator.state.downloaded.count == 1)
    }

    @Test
    func aMessageBelongsToItsBundleNotItsChannel() async {
        let fixture = Fixture()
        install("older", in: fixture.shelf.source)
        fixture.shelf.add(bundleId: "older", channel: "pr-1", message: "old words", nowMs: 0, running: nil)
        fixture.host.channel = "pr-1"
        fixture.host.bundleId = "ota"
        await fixture.coordinator.refresh()
        #expect(fixture.coordinator.state.selectedMessage == nil)
    }

    @Test
    func whatRunsAndWhatsNextAreReadApart() async {
        let fixture = Fixture()
        fixture.host.channel = "pr-2"
        fixture.host.bundleId = "staged"
        fixture.host.runningBundleId = "running"
        install("running", in: fixture.shelf.source)
        install("staged", in: fixture.shelf.source)
        fixture.shelf.add(bundleId: "running", channel: "pr-2", message: "what runs", nowMs: 0, running: nil)
        fixture.shelf.add(bundleId: "staged", channel: "pr-2", message: "what's next", nowMs: 1, running: nil)
        await fixture.coordinator.refresh()
        let state = fixture.coordinator.state
        #expect(state.selection?.bundleId == "staged")
        #expect(state.runningBundleId == "running")
        #expect(state.selectedMessage == "what's next")
        #expect(state.runningMessage == "what runs")
        let row = HotUpdaterSandboxHomeModel(state: state, isOverApp: true, nowMs: 0).bigRow
        #expect(row.subtitle == "Running bundle running")
        #expect(row.detail == "Next launch: bundle staged")
        let over = HotUpdaterSandboxInfoModel(state: state, version: "1", configuration: "Release", isOverApp: true)
        #expect(over.bundle.first { $0.name == "Current" }?.value == "running")
        // Before the app starts, a fixed launch's Open reloads into what's next.
        let before = HotUpdaterSandboxInfoModel(state: state, version: "1", configuration: "Release")
        #expect(before.bundle.first { $0.name == "Current" }?.value == "staged")
    }

    @Test
    func aRollbackIsClaimedAgainstWhatRunsNotWhatsNext() async {
        let fixture = Fixture()
        fixture.host.bundleId = "staged"
        fixture.host.runningBundleId = "built-in"
        fixture.host.evidence = HotUpdaterSandboxLaunchEvidence(
            rollback: HotUpdaterSandboxRollback(fromBundleId: "ota", toBundleId: "built-in")
        )
        await fixture.coordinator.refresh()
        #expect(fixture.coordinator.state.lastLaunch?.rolledBackToBundleId == "built-in")
    }

    @Test
    func openRecordsWhatOpensOverTheAppAndBeforeIt() async {
        let over = Fixture()
        over.host.channel = "pr-2"
        over.host.bundleId = "staged"
        over.host.runningBundleId = "running"
        over.host.appRunning = true
        await over.coordinator.open()
        #expect(over.store.openedBundles.last == "running")
        #expect(over.opens.last?.1 == false)

        // Before the app starts, a fixed launch's Open reloads into what's selected.
        let before = Fixture()
        before.host.channel = "pr-2"
        before.host.bundleId = "staged"
        before.host.runningBundleId = "running"
        await before.coordinator.open()
        #expect(before.store.openedBundles.last == "staged")
        #expect(before.opens.last?.1 == true)
    }

    @Test
    func openingListsNothing() async {
        let fixture = Fixture()
        fixture.host.channel = "pr-3"
        await fixture.coordinator.refresh()
        await fixture.coordinator.open()
        #expect(fixture.store.opened == ["pr-3"])
        #expect(fixture.shelf.entries.isEmpty)
    }

    @Test
    func aRowRunsItsStoredBundleWithNoRequest() async {
        let fixture = Fixture()
        fixture.coordinator.switchTo("pr-1")
        await settle()
        fixture.host.calls = []
        #expect(fixture.coordinator.openDownloaded("ota"))
        #expect(fixture.host.calls.isEmpty)
        #expect(fixture.host.startedStored == ["ota"])
        #expect(fixture.coordinator.state.storedSessionBundleId == "ota")
        // Reload runs the same stored bundle again.
        fixture.coordinator.reloadApp()
        #expect(fixture.host.startedStored == ["ota", "ota"])
        #expect(fixture.host.calls.isEmpty)
    }

    @Test
    func aRowWhoseFilesAreGoneChecksItsChannel() async {
        let fixture = Fixture()
        fixture.coordinator.switchTo("pr-1")
        await settle()
        try? FileManager.default.removeItem(at: fixture.shelf.root.appendingPathComponent("ota"))
        fixture.host.calls = []
        fixture.coordinator.openDownloaded("ota")
        await settle()
        #expect(fixture.host.startedStored.isEmpty)
        #expect(fixture.host.calls == ["preflight pr-1", "check pr-1"])
    }

    @Test
    func aSameIdBuildListsRowsThatCheckTheirChannel() async {
        let fixture = Fixture()
        let shelf = makeShelf(fixture.files, storesBundles: false)
        install("ota", in: shelf.source)
        shelf.add(bundleId: "ota", channel: "pr-1", message: nil, nowMs: 0, running: nil)
        #expect(shelf.entries.map(\.channel) == ["pr-1"])
        #expect(!FileManager.default.fileExists(atPath: shelf.root.appendingPathComponent("ota").path))
        #expect(shelf.stored("ota") == nil)
    }

    @Test
    func inAStoredSessionATypedChannelIsRefusedWithAWayBack() async {
        let fixture = Fixture()
        fixture.host.storedBundleId = "ota"
        fixture.coordinator.switchTo("pr-2")
        await settle()
        guard case .failed(_, _, _, let failure, _) = fixture.coordinator.state.phase else {
            Issue.record("expected a refusal")
            return
        }
        #expect(failure == .inStoredSession)
        #expect(HotUpdaterSandboxQuestion(phase: fixture.coordinator.state.phase, isOverApp: true)?.accept == "Back")
        #expect(fixture.host.calls.isEmpty)
        fixture.coordinator.retry()
        #expect(fixture.host.devExits == 1)
        #expect(fixture.coordinator.state.phase == .idle)
    }

    @Test
    func inAStoredSessionALinkExitsOnlyOnceConfirmed() async {
        let fixture = Fixture()
        fixture.host.storedBundleId = "ota"
        fixture.coordinator.receiveLink(link("pr-1"))
        guard case .confirming = fixture.coordinator.state.phase else {
            Issue.record("expected the link's question")
            return
        }
        #expect(fixture.host.devExits == 0)
        fixture.coordinator.confirmLink()
        #expect(fixture.host.devExits == 1)
        #expect(fixture.host.calls.isEmpty)
    }

    @Test
    func clearAndDeleteKeepTheRunningBundle() async {
        let fixture = Fixture()
        install("other", in: fixture.shelf.source)
        install("third", in: fixture.shelf.source)
        fixture.shelf.add(bundleId: "ota", channel: "pr-1", message: nil, nowMs: 0, running: nil)
        fixture.shelf.add(bundleId: "other", channel: "pr-2", message: nil, nowMs: 1, running: nil)
        fixture.shelf.add(bundleId: "third", channel: "pr-3", message: nil, nowMs: 2, running: nil)
        fixture.host.storedBundleId = "ota"
        fixture.coordinator.deleteDownloaded("ota")
        #expect(fixture.shelf.stored("ota") != nil)
        fixture.coordinator.deleteDownloaded("third")
        #expect(fixture.shelf.entries.map(\.bundleId) == ["other", "ota"])
        fixture.coordinator.clearDownloaded()
        #expect(fixture.shelf.entries.map(\.bundleId) == ["ota"])
        #expect(fixture.shelf.stored("other") == nil)
        #expect(fixture.host.calls.isEmpty)
    }

    @Test
    func reloadAsksForTheReloadAndWaitsForASwitch() async {
        let fixture = Fixture()
        fixture.coordinator.reloadApp()
        #expect(fixture.opens.count == 1)
        #expect(fixture.opens[0] == (true, true))

        let busy = Fixture()
        busy.host.preflightGate = Gate()
        busy.coordinator.switchTo("pr-1")
        await settle()
        busy.coordinator.reloadApp()
        #expect(busy.opens.isEmpty)
        busy.host.preflightGate?.finish(.success(false))
        await settle()
    }

    @Test
    func downloadedSaysWhenAndHowMuch() {
        let minute = 60_000.0
        #expect(HotUpdaterSandboxHomeModel.downloadedText(atMs: 0, nowMs: 30_000) == "downloaded just now")
        #expect(HotUpdaterSandboxHomeModel.downloadedText(atMs: 0, nowMs: 5 * minute) == "downloaded 5 min ago")
        #expect(HotUpdaterSandboxHomeModel.downloadedText(atMs: 0, nowMs: 125 * minute) == "downloaded 2 h ago")
        #expect(HotUpdaterSandboxHomeModel.downloadedText(atMs: 0, nowMs: 1500 * minute) == "downloaded 1 day ago")
        #expect(HotUpdaterSandboxHomeModel.downloadedText(atMs: 0, nowMs: 4400 * minute) == "downloaded 3 days ago")
        #expect(HotUpdaterSandboxHomeModel.sizeText(400) == "1 KB")
        #expect(HotUpdaterSandboxHomeModel.sizeText(2_340_000) == "2.3 MB")
        #expect(HotUpdaterSandboxHomeModel.sizeText(120_400_000) == "120 MB")
    }
}

struct HotUpdaterSandboxShelfTests {
    @Test
    func aPartialCopyListsNothing() {
        let files = temporaryDirectory()
        let shelf = makeShelf(files)
        install("broken", in: shelf.source, skipping: "assets/logo.png")
        shelf.add(bundleId: "broken", channel: "pr-1", message: nil, nowMs: 0, running: nil)
        #expect(shelf.entries.isEmpty)
        #expect(((try? FileManager.default.contentsOfDirectory(atPath: shelf.root.path)) ?? []).isEmpty)
    }

    @Test
    func aStoredBundleIsWhatMainAnswers() throws {
        let files = temporaryDirectory()
        let shelf = makeShelf(files)
        install("a", in: shelf.source)
        shelf.add(bundleId: "a", channel: "pr-1", message: nil, nowMs: 0, running: nil)
        let stored = try #require(shelf.stored("a"))
        #expect(stored.bundleURL.lastPathComponent == "index.ios.bundle")
        #expect(stored.baseURL == "file://\(shelf.root.appendingPathComponent("a").path)")
        #expect(stored.manifest["bundleId"] as? String == "a")
        // Main's store can prune its copy: the shelf's stays.
        try FileManager.default.removeItem(at: shelf.source.appendingPathComponent("a"))
        #expect(shelf.stored("a") != nil)
    }

    @Test
    func theCapDropsTheOldestButNeverTheRunningOne() {
        let files = temporaryDirectory()
        let shelf = makeShelf(files)
        for index in 0 ... HotUpdaterSandboxShelf.limit {
            install("b\(index)", in: shelf.source)
            shelf.add(bundleId: "b\(index)", channel: "pr-\(index)", message: nil, nowMs: Double(index), running: "b0")
        }
        #expect(shelf.entries.count == HotUpdaterSandboxShelf.limit)
        #expect(shelf.entries.first?.bundleId == "b10")
        #expect(shelf.stored("b0") != nil)
        #expect(shelf.entries.contains { $0.bundleId == "b1" } == false)
        #expect(shelf.stored("b1") == nil)
    }

    @Test
    func anotherBuildsEntriesAndStrayFilesGo() throws {
        let files = temporaryDirectory()
        let old = makeShelf(files, key: "old-build")
        install("a", in: old.source)
        old.add(bundleId: "a", channel: "pr-1", message: nil, nowMs: 0, running: nil)
        try FileManager.default.createDirectory(at: old.root.appendingPathComponent("b.tmp"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: old.root.appendingPathComponent("c"), withIntermediateDirectories: true)

        let new = makeShelf(files, key: "new-build")
        new.reconcile()
        #expect(new.entries.isEmpty)
        #expect(try FileManager.default.contentsOfDirectory(atPath: new.root.path) == ["index.json"])
    }

    @Test
    func aLinkOrAPathOutsideTheBundleFailsTheCheck() throws {
        let files = temporaryDirectory()
        let directory = files.appendingPathComponent("x")
        install("x", in: files)
        let logo = directory.appendingPathComponent("assets/logo.png")
        try FileManager.default.removeItem(at: logo)
        try FileManager.default.createSymbolicLink(at: logo, withDestinationURL: directory.appendingPathComponent("index.ios.bundle"))
        #expect(HotUpdaterSandboxShelf.check(directory, bundleId: "x") == nil)

        let manifest: [String: Any] = ["bundleId": "x", "assets": ["../x/index.ios.bundle": ["fileHash": "h"]]]
        try JSONSerialization.data(withJSONObject: manifest).write(to: directory.appendingPathComponent("manifest.json"))
        #expect(HotUpdaterSandboxShelf.check(directory, bundleId: "x") == nil)
        #expect(HotUpdaterSandboxShelf.check(directory, bundleId: "y") == nil)
    }
}

private func entry(_ bundleId: String, _ channel: String, message: String? = nil) -> HotUpdaterSandboxShelfEntry {
    HotUpdaterSandboxShelfEntry(bundleId: bundleId, channel: channel, message: message, isolationKey: "key", downloadedAtMs: 0)
}

struct HotUpdaterSandboxHomeModelTests {
    private func state(
        selection: HotUpdaterSandboxSelection?,
        running: String? = nil,
        hasServerConfig: Bool = true,
        phase: HotUpdaterSandboxPhase = .idle,
        lastLaunch: HotUpdaterSandboxLastLaunch? = nil,
        history: [HotUpdaterSandboxShelfEntry] = [],
        storedSession: String? = nil,
        message: String? = nil
    ) -> HotUpdaterSandboxState {
        HotUpdaterSandboxState(
            selection: selection,
            hasServerConfig: hasServerConfig,
            phase: phase,
            queuedLinks: 0,
            details: HotUpdaterSandboxDetails(
                builtInBundleId: "built-in",
                fingerprintHash: "abc",
                pendingBundleId: nil
            ),
            lastLaunch: lastLaunch,
            downloaded: history,
            storedSessionBundleId: storedSession,
            selectedMessage: message,
            runningBundleId: running
        )
    }

    private func home(_ state: HotUpdaterSandboxState, isOverApp: Bool = false) -> HotUpdaterSandboxHomeModel {
        HotUpdaterSandboxHomeModel(state: state, isOverApp: isOverApp, nowMs: 0)
    }

    @Test
    func theBigRowFollowsTheBundleNotTheChannel() {
        let otaOnDefault = home(state(selection: selection(channel: "sandbox-release", bundleId: "019a3f00aabbc2")))
        #expect(otaOnDefault.bigRow.title == "Open sandbox-release")
        #expect(otaOnDefault.bigRow.detail == "Bundle 019a3f…c2")

        let builtInOnPreview = home(state(selection: selection(channel: "pr-1", bundleId: "built-in")))
        #expect(builtInOnPreview.bigRow.title == "Open built-in bundle")
        #expect(builtInOnPreview.bigRow.detail == "Channel pr-1")
    }

    @Test
    func aMessageIsShownOnlyWhenKnown() {
        #expect(home(state(selection: selection())).bigRow.subtitle == nil)
        #expect(home(state(selection: selection(), message: "fix: login"))
            .bigRow.subtitle == "fix: login")
    }

    @Test
    func overTheAppItSaysRunningAndReload() {
        let row = home(state(selection: selection()), isOverApp: true).bigRow
        #expect(row.caption == "Running")
        #expect(row.title == "Reload")
        #expect(row.subtitle == "Running pr-1")
        #expect(row.isReload)
    }

    @Test
    func overTheAppRunningAndNextAreSeparateWhenTheyDiffer() {
        let toBuiltIn = home(state(selection: selection(bundleId: "built-in"), running: "ota"), isOverApp: true).bigRow
        #expect(toBuiltIn.subtitle == "Running bundle ota")
        #expect(toBuiltIn.detail == "Next launch: the built-in bundle")

        let toOta = home(state(selection: selection(bundleId: "ota"), running: "built-in"), isOverApp: true).bigRow
        #expect(toOta.subtitle == "Running the built-in bundle")
        #expect(toOta.detail == "Next launch: bundle ota")
    }

    @Test
    func theDevServerIsWhatRunsWhenItRuns() {
        let model = HotUpdaterSandboxHomeModel(
            state: state(selection: selection()),
            isOverApp: true,
            runningDevServerHost: "localhost:8081",
            nowMs: 0
        )
        #expect(model.bigRow.subtitle == "Running the dev server")
        let info = HotUpdaterSandboxInfoModel(
            state: state(selection: selection()),
            version: "1.0 (1)",
            configuration: "Release",
            isOverApp: true,
            runningDevServerHost: "localhost:8081"
        )
        #expect(info.bundle.first { $0.name == "Current" }?.value == "Dev server")
    }

    @Test
    func aRollbackIsClaimedOnlyByItsOwnBanner() {
        let rolledBack = home(state(
            selection: selection(bundleId: "built-in"),
            lastLaunch: HotUpdaterSandboxLastLaunch(kind: .crashedBeforeContent, bundleId: "ota", rolledBackToBundleId: "built-in"),
            history: [entry("ota", "pr-9")]
        )).banner
        #expect(rolledBack?.text == "pr-9 crashed before its first screen. The device rolled back to the built-in bundle.")
        #expect(rolledBack?.offersReset == false)

        let verified = home(state(
            selection: selection(bundleId: "ota"),
            lastLaunch: HotUpdaterSandboxLastLaunch(kind: .crashed, bundleId: "ota", rolledBackToBundleId: nil)
        )).banner
        #expect(verified?.text == "Bundle ota crashed on its last launch, and it's still selected.")
        #expect(verified?.offersReset == true)
        #expect(verified?.text.contains("rolled back") == false)

        let left = home(state(
            selection: selection(bundleId: "built-in"),
            lastLaunch: HotUpdaterSandboxLastLaunch(kind: .endedBeforeContent, bundleId: "ota", rolledBackToBundleId: "built-in")
        )).banner
        #expect(left?.text == "Bundle ota didn't reach its first screen. The device rolled back to the built-in bundle.")
        #expect(left?.text.contains("crashed") == false)
    }

    @Test
    func aCrashedBuiltInBundleHasNoResetToOffer() {
        let banner = home(state(
            selection: selection(bundleId: "built-in"),
            lastLaunch: HotUpdaterSandboxLastLaunch(kind: .crashed, bundleId: "built-in", rolledBackToBundleId: nil)
        )).banner
        #expect(banner?.text == "The built-in bundle crashed on its last launch, and it's still selected.")
        #expect(banner?.offersReset == false)
    }

    @Test
    func aCrashedBundleThatsNoLongerSelectedSaysWhatIs() {
        let banner = home(state(
            selection: selection(bundleId: "newer"),
            lastLaunch: HotUpdaterSandboxLastLaunch(kind: .crashed, bundleId: "ota", rolledBackToBundleId: nil)
        )).banner
        #expect(banner?.text == "Bundle ota crashed on its last launch. Bundle newer is selected now.")
        #expect(banner?.offersReset == false)
    }

    @Test
    func theFirstLaunchSaysAServerAnswerIsNeeded() {
        let model = home(state(selection: selection(bundleId: "built-in"), hasServerConfig: false))
        #expect(model.previewHint?.contains("answers one of the app's update checks") == true)
        #expect(model.previewHint?.contains("Open the app once") == false)
    }

    @Test
    func everyDownloadedBundleIsARowTheSelectedOneToo() {
        let model = home(state(
            selection: selection(channel: "pr-1"),
            history: [entry("019a3f00aabbc2", "pr-1"), entry("b", "pr-2", message: "words")],
            storedSession: "b"
        ))
        #expect(model.downloaded == [
            HotUpdaterSandboxHomeModel.Downloaded(
                bundleId: "019a3f00aabbc2",
                channel: "pr-1",
                message: nil,
                detail: "Bundle 019a3f…c2 · downloaded just now",
                isRunning: false
            ),
            HotUpdaterSandboxHomeModel.Downloaded(
                bundleId: "b",
                channel: "pr-2",
                message: "words",
                detail: "Bundle b · downloaded just now",
                isRunning: true
            ),
        ])
        #expect(model.downloadedFooter == "2 of 10")
        #expect(home(state(selection: selection())).downloadedFooter == "Bundles you open from a QR code, a link, or a channel stay here.")
    }

    @Test
    func aStoredSessionSaysWhatRunsAndTheWayBack() {
        let current = state(selection: selection(), history: [entry("019a3f00aabbc2", "pr-12")], storedSession: "019a3f00aabbc2")
        let row = home(current, isOverApp: true).bigRow
        #expect(row.subtitle == "Running stored pr-12")
        #expect(row.detail == "Bundle 019a3f…c2")
        #expect(row.isReload)
        #expect(row.showsBack)
        let info = HotUpdaterSandboxInfoModel(state: current, version: "1", configuration: "Release", isOverApp: true)
        #expect(info.bundle.first { $0.name == "Current" }?.value == "Stored 019a3f…c2")
    }

    @Test
    func aSwitchShowsItsStepAndHoldsTheRows() {
        let model = home(state(
            selection: selection(),
            phase: .working(operationId: 1, target: "pr-2", step: .download, progress: 0.5)
        ))
        #expect(model.status == HotUpdaterSandboxHomeModel.Status(text: "Downloading pr-2… 50%", progress: 0.5))
        #expect(model.isBusy)
    }

    @Test
    func infoShowsWhatTheStoreHolds() {
        var withPending = state(selection: selection(bundleId: "019a3f00aabbc2"))
        withPending.details = HotUpdaterSandboxDetails(
            builtInBundleId: "built-in",
            fingerprintHash: nil,
            pendingBundleId: "019a3f00aabbc2"
        )
        let info = HotUpdaterSandboxInfoModel(state: withPending, version: "1.0 (1)", configuration: "Release")
        #expect(info.build.map(\.name) == ["Version", "Configuration", "Fingerprint", "Built-in bundle", "Default channel"])
        #expect(info.build.first { $0.name == "Fingerprint" }?.value == "None")
        #expect(info.bundle.map(\.name) == ["Channel", "Current", "Pending"])
        #expect(info.bundle.first { $0.name == "Current" }?.value == "019a3f…c2")
        #expect(info.bundle.first { $0.name == "Pending" }?.value == "019a3f…c2")
    }

    @Test
    func aLinkSaysItReplacesTheRunningBundleOnlyOverTheApp() {
        let link = HotUpdaterSandboxLink(url: "hu-sandbox-app://hot-updater/preview?channel=pr-1&fingerprint=fp")!
        let over = HotUpdaterSandboxQuestion(phase: .confirming(link), isOverApp: true)
        let before = HotUpdaterSandboxQuestion(phase: .confirming(link), isOverApp: false)
        #expect(over?.message == "This replaces the running bundle. Downloaded bundles stay listed.")
        #expect(before?.message == HotUpdaterSandboxHomeModel.switchNote)
    }

    @Test
    func theScannerSendsOnlyADeniedCameraToSettings() {
        #expect(HotUpdaterSandboxScannerContent(access: .denied)
            == .message("Allow camera access to scan QR codes.", opensSettings: true))
        #expect(HotUpdaterSandboxScannerContent(access: .restricted)
            == .message("Camera access is restricted on this device.", opensSettings: false))
        #expect(HotUpdaterSandboxScannerContent(access: .allowed) == .camera)
        #expect(HotUpdaterSandboxScannerContent(access: .allowed, problem: "No camera on this device.")
            == .message("No camera on this device.", opensSettings: false))
        #expect(HotUpdaterSandboxScannerContent(access: .undetermined) == .waiting)
    }

    @Test
    func licenseReflowsIntoParagraphs() {
        let text = """
        Copyright 2024 The Authors

        -----------------------------------------------------------
        SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
        -----------------------------------------------------------

        PREAMBLE
        The goals of the Open Font License (OFL) are to stimulate\u{20}
        worldwide development.

        DISCLAIMER
        THE FONT SOFTWARE IS PROVIDED "AS IS",
        WITHOUT WARRANTY OF ANY KIND.
        """
        #expect(HotUpdaterSandboxInfoModel.reflow(text) == [
            "Copyright 2024 The Authors",
            "SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007",
            "PREAMBLE",
            "The goals of the Open Font License (OFL) are to stimulate worldwide development.",
            "DISCLAIMER",
            "THE FONT SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND.",
        ].joined(separator: "\n\n"))
    }
}

struct HotUpdaterSandboxDevHostTests {
    @Test
    func hostsNormalizeAsAPersonTypesThem() {
        #expect(HotUpdaterSandboxDevHost.normalize(" 192.168.0.2 ") == "http://192.168.0.2:8081")
        #expect(HotUpdaterSandboxDevHost.normalize("192.168.0.2:9000/") == "http://192.168.0.2:9000")
        #expect(HotUpdaterSandboxDevHost.normalize("https://dev.example.com") == "https://dev.example.com:8081")
        #expect(HotUpdaterSandboxDevHost.normalize("[::1]") == "http://[::1]:8081")
        for bad in ["", "ftp://host", "host/path", "two words"] {
            #expect(HotUpdaterSandboxDevHost.normalize(bad) == nil)
        }
    }

    @Test
    func recentHostsComeFirstEachOnce() {
        #expect(HotUpdaterSandboxDevHost.listed(isSimulator: true, recent: ["http://a:1", "http://localhost:8081"]) == ["http://a:1", "http://localhost:8081"])
        #expect(HotUpdaterSandboxDevHost.listed(isSimulator: false, recent: []) == [])
    }

    @Test
    func anExpoManifestNamesTheEntryAndTheTransformNeverItsDevSettings() {
        let manifest = #"{"launchAsset":{"url":"http://127.0.0.1:8099/examples/expo-52/index.ts.bundle?platform=ios&dev=true&hot=false&transform.engine=hermes&transform.bytecode=1&unstable_transformProfile=hermes-stable"}}"#
        #expect(HotUpdaterSandboxDevHost.entry(ofManifest: Data(manifest.utf8)) == HotUpdaterSandboxDevEntry(
            path: "examples/expo-52/index.ts",
            query: "&transform.engine=hermes&unstable_transformProfile=hermes-stable"
        ))
        #expect(HotUpdaterSandboxDevHost.entry(ofManifest: Data("React Native packager is running.".utf8)) == nil)
        #expect(HotUpdaterSandboxDevHost.entry(ofManifest: Data(#"{"launchAsset":{}}"#.utf8)) == nil)
    }

    @Test
    func theBundleIsDevFalse() {
        #expect(HotUpdaterSandboxDevHost.bundleURL(host: "http://a:1")?.absoluteString == "http://a:1/index.bundle?platform=ios&dev=false&minify=false")
    }
}
/// A dev server whose answers wait for the test.
@MainActor
private final class SlowDevServer {
    private var waiting: [CheckedContinuation<HotUpdaterSandboxDevResolved, Never>] = []
    var pending: Int { waiting.count }

    func resolve(_ host: String) async -> HotUpdaterSandboxDevResolved {
        await withCheckedContinuation { waiting.append($0) }
    }

    func answer(_ result: HotUpdaterSandboxDevResolved) {
        waiting.removeFirst().resume(returning: result)
    }
}

@MainActor
private func settle(until done: () -> Bool = { false }) async {
    for _ in 0 ..< 200 {
        if done() { return }
        await Task.yield()
    }
}

@MainActor
struct HotUpdaterSandboxDevConnectorTests {
    @Test
    func aConnectWhileASwitchRunsIsRefusedAndStartsNothing() async {
        let server = SlowDevServer()
        let lock = HotUpdaterSandboxLock()
        var committed = 0
        let connector = HotUpdaterSandboxDevConnector(
            resolve: { await server.resolve($0) },
            commit: { _, _ in committed += 1 },
            lock: lock
        )
        #expect(lock.take(.switching))
        var failure: String?
        connector.connect("http://a:1") { failure = $0 }
        await settle { failure != nil }
        #expect(failure == "A preview is being opened. Wait for it, then connect.")
        #expect(server.pending == 0)
        #expect(committed == 0)
        #expect(lock.holder == .switching)
    }

    @Test
    func aConnectionHoldsTheLockWhileItFetchesAndReleasesItEitherWay() async {
        let server = SlowDevServer()
        let lock = HotUpdaterSandboxLock()
        var committed = 0
        let connector = HotUpdaterSandboxDevConnector(
            resolve: { await server.resolve($0) },
            commit: { _, _ in committed += 1 },
            lock: lock
        )
        var failure: String? = "unanswered"
        connector.connect("http://a:1") { failure = $0 }
        await settle { server.pending == 1 }
        #expect(lock.holder == .devServer)
        server.answer(.failure("a:1 answered 500 for its JavaScript."))
        await settle { failure != "unanswered" }
        #expect(lock.holder == nil)
        failure = "unanswered"
        connector.connect("http://a:1") { failure = $0 }
        await settle { server.pending == 1 }
        server.answer(.bundle(URL(string: "http://a:1/index.bundle")!))
        await settle { failure == nil }
        #expect(committed == 1)
        #expect(lock.holder == nil)
    }

    @Test
    func exitDuringAReloadStillFetchingStartsNothing() async {
        let server = SlowDevServer()
        var committed: [URL] = []
        let connector = HotUpdaterSandboxDevConnector(
            resolve: { await server.resolve($0) },
            commit: { _, url in committed.append(url) },
            lock: HotUpdaterSandboxLock()
        )
        connector.reload("http://a:1")
        await settle { server.pending == 1 }
        connector.ended()
        server.answer(.bundle(URL(string: "http://a:1/index.bundle")!))
        await settle()
        #expect(committed.isEmpty)
    }

    @Test
    func aConnectAfterExitStartsASessionAsUsual() async {
        let server = SlowDevServer()
        var committed: [URL] = []
        let connector = HotUpdaterSandboxDevConnector(
            resolve: { await server.resolve($0) },
            commit: { _, url in committed.append(url) },
            lock: HotUpdaterSandboxLock()
        )
        connector.ended()
        var failure: String? = "unanswered"
        connector.connect("http://a:1") { failure = $0 }
        await settle { server.pending == 1 }
        server.answer(.bundle(URL(string: "http://a:1/index.bundle")!))
        await settle { failure == nil }
        #expect(failure == nil)
        #expect(committed.count == 1)
    }

    @Test
    func aFailedReloadIsShownOnTheScreen() async {
        let server = SlowDevServer()
        var changes = 0
        let connector = HotUpdaterSandboxDevConnector(resolve: { await server.resolve($0) }, commit: { _, _ in }, lock: HotUpdaterSandboxLock())
        connector.onChange = { changes += 1 }
        connector.reload("http://a:1")
        await settle { server.pending == 1 }
        server.answer(.failure("a:1 answered 500 for its JavaScript."))
        await settle { changes > 0 }
        #expect(connector.lastError == "a:1 answered 500 for its JavaScript.")
        #expect(changes == 1)
    }

    @Test
    func connectionsRunOneAtATime() async {
        let server = SlowDevServer()
        var committed: [String] = []
        let connector = HotUpdaterSandboxDevConnector(
            resolve: { await server.resolve($0) },
            commit: { host, _ in committed.append(host) },
            lock: HotUpdaterSandboxLock()
        )
        connector.connect("http://a:1") { _ in }
        connector.connect("http://b:2") { _ in }
        await settle { server.pending == 1 }
        #expect(server.pending == 1)
        server.answer(.bundle(URL(string: "http://a:1/index.bundle")!))
        await settle { server.pending == 1 && committed.count == 1 }
        server.answer(.bundle(URL(string: "http://b:2/index.bundle")!))
        await settle { committed.count == 2 }
        #expect(committed == ["http://a:1", "http://b:2"])
    }
}
#endif
