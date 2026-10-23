#if canImport(Testing)
import Foundation
import Testing

@testable import HotUpdaterCore

private let validConfig = """
{"version":1,"baseURL":"https://updates.example.com/api","requestHeaders":{"x-api-key":"secret"},\
"requestTimeoutMs":1500,"updateStrategy":"fingerprint"}
"""

/// Main's native update check at the first launch with UI after a crash:
/// the config JavaScript leaves for it, the flag a consumed crash marker
/// sets, and when the check runs.
struct PostCrashUpdateCheckTests {
    // MARK: - Config

    @Test
    func readsTheConfigJavaScriptWritesWithTheTimeoutInSeconds() throws {
        let config = try #require(HotUpdaterRecoveryCheckConfig(json: validConfig))
        #expect(config.baseURL == "https://updates.example.com/api")
        #expect(config.requestHeaders == ["x-api-key": "secret"])
        #expect(config.requestTimeout == 1.5)
        #expect(config.updateStrategy == .fingerprint)

        let request = config.request
        #expect(request.baseURL == "https://updates.example.com/api")
        #expect(request.requestHeaders == ["x-api-key": "secret"])
        #expect(request.requestTimeout == 1.5)
        #expect(request.updateStrategy == .fingerprint)
        // The current channel: the check never switches it.
        #expect(request.channel == nil)

        let appVersion = try #require(HotUpdaterRecoveryCheckConfig(json: """
        {"version":1,"baseURL":"http://10.0.2.2:3000/","requestHeaders":{},"requestTimeoutMs":5000,"updateStrategy":"appVersion"}
        """))
        #expect(appVersion.updateStrategy == .appVersion)
        #expect(appVersion.requestTimeout == 5)
    }

    /// Headers and timeout JavaScript always writes; a record without them
    /// still checks, with none and the default timeout.
    @Test
    func aRecordWithoutHeadersOrTimeoutUsesTheDefaults() throws {
        let config = try #require(HotUpdaterRecoveryCheckConfig(json: """
        {"version":1,"baseURL":"https://updates.example.com","updateStrategy":"appVersion"}
        """))
        #expect(config.requestHeaders.isEmpty)
        #expect(config.requestTimeout == 5)
    }

    /// Any of these is no config, and so no request at all.
    @Test(arguments: [
        nil,
        "",
        "not json",
        "[]",
        "null",
        #"{"baseURL":"https://u.example.com","updateStrategy":"appVersion"}"#,
        #"{"version":2,"baseURL":"https://u.example.com","updateStrategy":"appVersion"}"#,
        #"{"version":true,"baseURL":"https://u.example.com","updateStrategy":"appVersion"}"#,
        #"{"version":"1","baseURL":"https://u.example.com","updateStrategy":"appVersion"}"#,
        #"{"version":1,"updateStrategy":"appVersion"}"#,
        #"{"version":1,"baseURL":5,"updateStrategy":"appVersion"}"#,
        #"{"version":1,"baseURL":"","updateStrategy":"appVersion"}"#,
        #"{"version":1,"baseURL":"updates.example.com","updateStrategy":"appVersion"}"#,
        #"{"version":1,"baseURL":"ftp://u.example.com","updateStrategy":"appVersion"}"#,
        #"{"version":1,"baseURL":"https://","updateStrategy":"appVersion"}"#,
        #"{"version":1,"baseURL":"https://u.example.com"}"#,
        #"{"version":1,"baseURL":"https://u.example.com","updateStrategy":"semver"}"#,
        #"{"version":1,"baseURL":"https://u.example.com","updateStrategy":"appVersion","requestHeaders":"x"}"#,
        #"{"version":1,"baseURL":"https://u.example.com","updateStrategy":"appVersion","requestHeaders":{"a":1}}"#,
        #"{"version":1,"baseURL":"https://u.example.com","updateStrategy":"appVersion","requestHeaders":null}"#,
        #"{"version":1,"baseURL":"https://u.example.com","updateStrategy":"appVersion","requestTimeoutMs":0}"#,
        #"{"version":1,"baseURL":"https://u.example.com","updateStrategy":"appVersion","requestTimeoutMs":0.5}"#,
        #"{"version":1,"baseURL":"https://u.example.com","updateStrategy":"appVersion","requestTimeoutMs":null}"#,
        #"{"version":1,"baseURL":"https://u.example.com","updateStrategy":"appVersion","requestTimeoutMs":-5}"#,
        #"{"version":1,"baseURL":"https://u.example.com","updateStrategy":"appVersion","requestTimeoutMs":"5000"}"#,
        #"{"version":1,"baseURL":"https://u.example.com","updateStrategy":"appVersion","requestTimeoutMs":true}"#,
    ] as [String?])
    func anInvalidRecordIsNoConfig(json: String?) {
        #expect(HotUpdaterRecoveryCheckConfig(json: json) == nil)
    }

    // MARK: - Pending flag

    /// A crash marker without rollback leaves the check pending; one that
    /// asks for rollback is settled locally, and a launch without one leaves
    /// the flag alone.
    /// A native check's request is written as JavaScript writes it, so the
    /// check after a crash reads it back the same.
    @Test(arguments: [HotUpdaterUpdateStrategy.appVersion, .fingerprint])
    func aNativeRequestRoundTripsThroughTheRecord(strategy: HotUpdaterUpdateStrategy) throws {
        let request = NativeCheckRequest(
            baseURL: "https://updates.example.com/api",
            updateStrategy: strategy,
            requestHeaders: ["x-api-key": "secret"],
            channel: "beta",
            requestTimeout: 2.5
        )

        let json = try #require(HotUpdaterRecoveryCheckConfig.json(for: request))
        let read = try #require(HotUpdaterRecoveryCheckConfig(json: json)).request

        #expect(read.baseURL == request.baseURL)
        #expect(read.updateStrategy == strategy)
        #expect(read.requestHeaders == request.requestHeaders)
        #expect(read.requestTimeout == 2.5)
        // The check after a crash uses the device's own channel.
        #expect(read.channel == nil)
    }

    /// Two spellings of one header keep the value the request sent.
    @Test
    func aNativeRequestKeepsItsHeadersAsSent() throws {
        let request = NativeCheckRequest(
            baseURL: "https://updates.example.com/api",
            updateStrategy: .appVersion,
            requestHeaders: ["Authorization": "Bearer a", "authorization": "Bearer b", "X-Api-Key": "k"]
        )
        let sent = NativeUpdateChecker.normalizedHeaders(request.requestHeaders)

        let json = try #require(HotUpdaterRecoveryCheckConfig.json(for: request))
        let read = try #require(HotUpdaterRecoveryCheckConfig(json: json)).request

        #expect(read.requestHeaders == sent)
        #expect(read.requestHeaders.keys.sorted() == ["authorization", "x-api-key"])
    }

    @Test(arguments: [false, true])
    func consumingACrashMarkerWithoutRollbackLeavesTheCheckPending(shouldRollback: Bool) throws {
        let scene = try CheckScene()
        defer { scene.cleanUp() }
        let markerURL = scene.directory.appendingPathComponent("bundle-store/recovery-crash-marker.json")
        let check = scene.makeCheck()

        #expect(check.consumeMarker { HotUpdaterCrashMarker.consume(at: markerURL) } == nil)
        #expect(scene.storage.getItem(HotUpdaterPostCrashUpdateCheck.pendingKey) == nil)

        HotUpdaterCrashMarker.write(bundleId: "bundle-1", shouldRollback: shouldRollback, to: markerURL)
        let recovery = try #require(check.consumeMarker { HotUpdaterCrashMarker.consume(at: markerURL) })
        #expect(recovery.launchedBundleId == "bundle-1")
        #expect(recovery.shouldRollback == shouldRollback)
        #expect(scene.storage.getItem(HotUpdaterPostCrashUpdateCheck.pendingKey) == (shouldRollback ? nil : "1"))
        #expect(!FileManager.default.fileExists(atPath: markerURL.path))
    }

    /// A rollback also settles a check an earlier crash left pending: the
    /// restored bundle passed its first content, so no request follows.
    @Test
    func aRollbackMarkerClearsACheckLeftPending() throws {
        let scene = try CheckScene()
        defer { scene.cleanUp() }
        let markerURL = scene.directory.appendingPathComponent("bundle-store/recovery-crash-marker.json")
        let check = scene.makeCheck()
        _ = scene.storage.setItem(HotUpdaterPostCrashUpdateCheck.pendingKey, value: "1")

        // A launch without a marker keeps it.
        #expect(check.consumeMarker { HotUpdaterCrashMarker.consume(at: markerURL) } == nil)
        #expect(scene.storage.getItem(HotUpdaterPostCrashUpdateCheck.pendingKey) == "1")

        HotUpdaterCrashMarker.write(bundleId: "bundle-2", shouldRollback: true, to: markerURL)
        #expect(check.consumeMarker { HotUpdaterCrashMarker.consume(at: markerURL) }?.shouldRollback == true)
        #expect(scene.storage.getItem(HotUpdaterPostCrashUpdateCheck.pendingKey) == nil)
    }

    // MARK: - Gating

    @Test
    func aCheckIsRequestedOnlyWhenPendingAndConfigured() throws {
        let scene = try CheckScene()
        defer { scene.cleanUp() }
        let check = scene.makeCheck()

        #expect(check.request() == nil)
        scene.storage.setItem(HotUpdaterRecoveryCheckConfig.storageKey, value: validConfig)
        #expect(check.request() == nil)

        scene.storage.setItem(HotUpdaterRecoveryCheckConfig.storageKey, value: nil)
        scene.storage.setItem(HotUpdaterPostCrashUpdateCheck.pendingKey, value: "1")
        #expect(check.request() == nil)
        #expect(scene.recorder.logs == ["skipped no config"])

        scene.storage.setItem(HotUpdaterRecoveryCheckConfig.storageKey, value: validConfig)
        #expect(check.request()?.baseURL == "https://updates.example.com/api")
    }

    /// Without a valid config nothing is requested, and the flag stays for
    /// a launch whose JavaScript has written one.
    @Test
    func aPendingCheckWithoutConfigSendsNoRequest() throws {
        let scene = try CheckScene()
        defer { scene.cleanUp() }
        scene.storage.setItem(HotUpdaterPostCrashUpdateCheck.pendingKey, value: "1")
        scene.storage.setItem(HotUpdaterRecoveryCheckConfig.storageKey, value: #"{"version":1}"#)
        let check = scene.makeCheck()

        check.startIfNeeded()
        scene.drain()

        #expect(scene.recorder.requests.isEmpty)
        #expect(scene.recorder.shownWaits == 0)
        #expect(scene.storage.getItem(HotUpdaterPostCrashUpdateCheck.pendingKey) == "1")
    }

    @Test
    func noCheckRunsWhenNoneIsPending() throws {
        let scene = try CheckScene()
        defer { scene.cleanUp() }
        scene.storage.setItem(HotUpdaterRecoveryCheckConfig.storageKey, value: validConfig)
        let check = scene.makeCheck()

        check.startIfNeeded()
        scene.drain()

        #expect(scene.recorder.requests.isEmpty)
        #expect(scene.recorder.logs.isEmpty)
    }

    /// One check per process, whatever later launch preparations or
    /// markers ask; the flag is cleared once it finishes.
    @Test
    func aCheckRunsOncePerProcessAndClearsTheFlag() async throws {
        let scene = try CheckScene()
        defer { scene.cleanUp() }
        scene.storage.setItem(HotUpdaterPostCrashUpdateCheck.pendingKey, value: "1")
        scene.storage.setItem(HotUpdaterRecoveryCheckConfig.storageKey, value: validConfig)
        let check = scene.makeCheck(outcome: .success(.staged(bundleId: "bundle-2")))

        check.startIfNeeded()
        check.startIfNeeded()
        #expect(await scene.recorder.waitForLogs(2))

        #expect(scene.recorder.logs == ["started", "staged bundle-2"])
        #expect(scene.recorder.requests.count == 1)
        #expect(scene.recorder.requests.first?.requestHeaders == ["x-api-key": "secret"])
        #expect(scene.recorder.requests.first?.requestTimeout == 1.5)
        #expect(scene.storage.getItem(HotUpdaterPostCrashUpdateCheck.pendingKey) == nil)

        // A marker consumed later in this process waits for the next one.
        HotUpdaterCrashMarker.write(bundleId: nil, shouldRollback: false, to: scene.markerURL)
        _ = check.consumeMarker { HotUpdaterCrashMarker.consume(at: scene.markerURL) }
        check.startIfNeeded()
        scene.drain()
        #expect(scene.recorder.requests.count == 1)
        #expect(scene.storage.getItem(HotUpdaterPostCrashUpdateCheck.pendingKey) == "1")
    }

    @Test(arguments: [
        (Result<HotUpdaterPostCrashUpdateCheck.Outcome, Error>.success(.noUpdate), "no update"),
        (.success(.superseded), "skipped superseded"),
        (.failure(NativeUpdateCheckError.http(status: 500)), "failed Request failed with HTTP 500"),
    ])
    func theFlagIsClearedWhateverTheOutcome(
        outcome: Result<HotUpdaterPostCrashUpdateCheck.Outcome, Error>,
        status: String
    ) async throws {
        let scene = try CheckScene()
        defer { scene.cleanUp() }
        scene.storage.setItem(HotUpdaterPostCrashUpdateCheck.pendingKey, value: "1")
        scene.storage.setItem(HotUpdaterRecoveryCheckConfig.storageKey, value: validConfig)
        let check = scene.makeCheck(outcome: outcome)

        check.startIfNeeded()
        #expect(await scene.recorder.waitForLogs(2))

        #expect(scene.recorder.logs == ["started", status])
        #expect(scene.storage.getItem(HotUpdaterPostCrashUpdateCheck.pendingKey) == nil)
    }

    /// A launch without UI waits: the check runs once the app is shown, and
    /// until then the flag stays for a later launch.
    @Test
    func aLaunchWithoutUIWaitsUntilTheAppIsShown() async throws {
        let scene = try CheckScene()
        defer { scene.cleanUp() }
        scene.storage.setItem(HotUpdaterPostCrashUpdateCheck.pendingKey, value: "1")
        scene.storage.setItem(HotUpdaterRecoveryCheckConfig.storageKey, value: validConfig)
        let check = scene.makeCheck(shown: false)

        check.startIfNeeded()
        check.startIfNeeded()
        scene.drain()
        #expect(scene.recorder.shownWaits == 1)
        #expect(scene.recorder.requests.isEmpty)
        #expect(scene.storage.getItem(HotUpdaterPostCrashUpdateCheck.pendingKey) == "1")

        scene.recorder.show()
        #expect(await scene.recorder.waitForLogs(2))
        #expect(scene.recorder.requests.count == 1)
        #expect(scene.storage.getItem(HotUpdaterPostCrashUpdateCheck.pendingKey) == nil)
    }
}

// MARK: - Fixtures

private final class CheckScene {
    let directory: URL
    let storage: KeyValueStorageService
    let recorder = CheckRecorder()
    let queue = DispatchQueue(label: "post-crash-update-check-tests")
    var markerURL: URL { directory.appendingPathComponent("bundle-store/recovery-crash-marker.json") }

    init() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("post-crash-update-check-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        storage = KeyValueStorageService(directory: directory.appendingPathComponent("HotUpdater", isDirectory: true))
    }

    func cleanUp() {
        try? FileManager.default.removeItem(at: directory)
    }

    /// `shown`: whether the app is shown when the check asks.
    func makeCheck(
        shown: Bool = true,
        outcome: Result<HotUpdaterPostCrashUpdateCheck.Outcome, Error> = .success(.noUpdate)
    ) -> HotUpdaterPostCrashUpdateCheck {
        let recorder = recorder
        return HotUpdaterPostCrashUpdateCheck(
            storage: storage,
            queue: queue,
            whenShown: { action in recorder.waitUntilShown(action, shown: shown) },
            check: { request in
                recorder.record(request)
                return try outcome.get()
            },
            log: { recorder.log($0) }
        )
    }

    /// Lets the work queued so far run, including what it queues next.
    func drain() {
        for _ in 0..<3 {
            queue.sync {}
        }
    }
}

private final class CheckRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var requestValues: [NativeCheckRequest] = []
    private var logValues: [String] = []
    private var waiting: [() -> Void] = []
    private var shownWaitCount = 0

    var requests: [NativeCheckRequest] { locked { requestValues } }
    var logs: [String] { locked { logValues } }
    var shownWaits: Int { locked { shownWaitCount } }

    func record(_ request: NativeCheckRequest) {
        locked { requestValues.append(request) }
    }

    func log(_ line: String) {
        locked { logValues.append(line) }
    }

    func waitUntilShown(_ action: @escaping () -> Void, shown: Bool) {
        locked { shownWaitCount += 1 }
        if shown {
            action()
        } else {
            locked { waiting.append(action) }
        }
    }

    /// The app comes to the foreground.
    func show() {
        let actions = locked { () -> [() -> Void] in
            defer { waiting = [] }
            return waiting
        }
        actions.forEach { $0() }
    }

    /// Whether `count` lines have been logged within a few seconds.
    func waitForLogs(_ count: Int) async -> Bool {
        for _ in 0..<500 where logs.count < count {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return logs.count >= count
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}
#endif
