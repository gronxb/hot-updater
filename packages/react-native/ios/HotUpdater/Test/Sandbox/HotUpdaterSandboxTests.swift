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
    /// Whether a staging moves what a launch selects: not once a launch is fixed.
    var launchFixed = false
    var channelAfterStaging: String?
    var isRunningDevServer = false
    var devExits = 0

    func exitDevServerForLink() {
        devExits += 1
        isRunningDevServer = false
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
        if case .update(let bundleId) = staged {
            self.channel = channelAfterStaging ?? channel
            if !launchFixed { self.bundleId = bundleId }
        }
        return staged
    }
}

private final class FakeStore: HotUpdaterSandboxStore {
    var pendingLinks: [String] = []
    var selected: [String] = []
    var opened: [String] = []

    func recordSelected(_ selection: HotUpdaterSandboxSelection) {
        selected.append(selection.channel)
    }

    func recordOpened(_ selection: HotUpdaterSandboxSelection) {
        opened.append(selection.channel)
    }
}

@MainActor
private func settle() async {
    for _ in 0 ..< 50 { await Task.yield() }
}

@MainActor
private struct Fixture {
    let host = FakeHost()
    let store = FakeStore()
    var opens: [(Bool, Bool)] { box.opens }
    private let box = Box()
    let coordinator: HotUpdaterSandboxCoordinator

    private final class Box {
        var opens: [(Bool, Bool)] = []
    }

    init(pendingLinks: [String] = []) {
        store.pendingLinks = pendingLinks
        let box = box
        coordinator = HotUpdaterSandboxCoordinator(
            host: host,
            store: store,
            openApp: { box.opens.append(($0, $1)) }
        )
    }
}

@MainActor
struct HotUpdaterSandboxCoordinatorTests {
    @Test
    func inADevSessionAConfirmedLinkExitsItAndIsAskedAgain() async {
        let fixture = Fixture()
        fixture.host.isRunningDevServer = true
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
    func inADevSessionARowOrAResetAsksToExitFirstAndChangesNothing() async {
        let fixture = Fixture()
        fixture.host.isRunningDevServer = true
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
        fixture.host.launchFixed = true
        fixture.coordinator.switchTo("pr-1")
        await settle()
        #expect(fixture.opens.count == 1)
        #expect(fixture.opens[0] == (true, true))
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
    func theBundleIsDevFalse() {
        #expect(HotUpdaterSandboxDevHost.bundleURL(host: "http://a:1")?.absoluteString == "http://a:1/index.bundle?platform=ios&dev=false&minify=false")
    }
}
#endif
