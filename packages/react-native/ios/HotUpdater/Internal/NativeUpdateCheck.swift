import Foundation

// A port of the JavaScript update check (`checkForUpdate.ts`, `httpClient.ts`,
// and `releaseCatalogCache.ts`) for apps that check and stage updates before
// React Native starts. Plugin events it would emit are queued in the native
// key-value store, and the next `HotUpdater.init` replays them.

// MARK: - Public API

/// How the server matches the app to a Release catalog, as the
/// `updateStrategy` of `HotUpdater.init`.
@objc public enum HotUpdaterUpdateStrategy: Int {
    case appVersion
    case fingerprint

    /// The name JavaScript uses in plugin events.
    var name: String {
        switch self {
        case .appVersion: return "appVersion"
        case .fingerprint: return "fingerprint"
        }
    }
}

/// Whether an update moves the app forward or back.
@objc public enum HotUpdaterUpdateStatus: Int {
    case update
    case rollback
}

/// The outcome of `prepare`.
@objc public enum HotUpdaterPrepareStatus: Int {
    /// The bundle this start runs is what the server wants. It may have been
    /// downloaded by an earlier start.
    case upToDate
    /// A required update was staged before React Native read the bundle, so
    /// React Native starts with it.
    case ready
    /// An update is downloading or staged and applies at the first start
    /// after it is staged: this one when it is staged before React Native
    /// reads the bundle.
    case pending
    /// The check or the required update failed; see `error`.
    case failed
}

/// The values the app passes to `HotUpdater.init`.
@objc public final class HotUpdaterCheckOptions: NSObject, @unchecked Sendable {
    @objc public let baseURL: String
    @objc public let updateStrategy: HotUpdaterUpdateStrategy
    @objc public let requestHeaders: [String: String]
    /// Checks this channel instead of the current one. The switch is only
    /// persisted once the returned update is staged.
    @objc public let channel: String?
    /// Seconds each request may take.
    @objc public let requestTimeout: TimeInterval
    /// The bundle that holds the embedded `main.jsbundle` and the
    /// `HOT_UPDATER_*` Info.plist keys, as passed to `HotUpdater.bundleURL(bundle:)`:
    /// a brownfield XCFramework passes its own bundle.
    @objc public let bundle: Bundle

    @objc public init(
        baseURL: String,
        updateStrategy: HotUpdaterUpdateStrategy,
        requestHeaders: [String: String] = [:],
        channel: String? = nil,
        requestTimeout: TimeInterval = 5,
        bundle: Bundle = .main
    ) {
        self.baseURL = baseURL
        self.updateStrategy = updateStrategy
        self.requestHeaders = requestHeaders
        self.channel = channel
        self.requestTimeout = requestTimeout
        self.bundle = bundle
    }
}

/// An update the check found, with the fields of JavaScript's
/// `CheckForUpdateResult`.
@objc public final class HotUpdaterUpdate: NSObject, @unchecked Sendable {
    /// The Release ID, or the bundle ID when the update names no Release.
    @objc(identifier) public let id: String
    @objc public let releaseId: String?
    @objc public let status: HotUpdaterUpdateStatus
    @objc public let shouldForceUpdate: Bool
    @objc public let message: String?

    /// The bundle the update stages.
    let bundleId: String
    /// `INSTALL`, `ADOPT_RELEASE`, or `USE_BUILTIN`.
    let transitionKind: String
    /// The update selects the bundle the app already launches, so staging it
    /// only records the selection.
    let runsCurrentBundle: Bool
    /// The selection the update stages: kind, bundle, Release, and channel,
    /// from one catalog and selection context. A staging already running
    /// joins only the same target.
    let targetKey: String
    /// The options the check ran with; `prepare` joins a staging only from an
    /// equal request.
    let requestKey: String
    private let checker: NativeUpdateChecker
    private let stagedLock = NSLock()
    private var staged = false
    /// Stages the update; the deadline bounds the artifact request.
    let install: (NativeUpdateDeadline?, @escaping (Double) -> Void) async throws -> Bool
    /// Whether the selection this update stages is still the current one.
    let isSelectionCurrent: () -> Bool

    init(
        id: String,
        releaseId: String?,
        status: HotUpdaterUpdateStatus,
        shouldForceUpdate: Bool,
        message: String?,
        bundleId: String,
        transitionKind: String,
        runsCurrentBundle: Bool,
        targetKey: String,
        requestKey: String,
        checker: NativeUpdateChecker,
        install: @escaping (NativeUpdateDeadline?, @escaping (Double) -> Void) async throws -> Bool,
        isSelectionCurrent: @escaping () -> Bool = { true }
    ) {
        self.id = id
        self.releaseId = releaseId
        self.status = status
        self.shouldForceUpdate = shouldForceUpdate
        self.message = message
        self.bundleId = bundleId
        self.transitionKind = transitionKind
        self.runsCurrentBundle = runsCurrentBundle
        self.targetKey = targetKey
        self.requestKey = requestKey
        self.checker = checker
        self.install = install
        self.isSelectionCurrent = isSelectionCurrent
    }

    /// Downloads, verifies, and stages the update for the next launch, or
    /// commits a selection that needs no download. Joins a download of the
    /// same bundle already in progress, returns true at once once this update
    /// is staged, and waits for other native update work without a deadline.
    /// `onProgress` receives 0...1 on the main queue.
    public func updateBundle(onProgress: ((Double) -> Void)? = nil) async throws -> Bool {
        try await checker.updateBundle(self, onProgress: onProgress)
    }

    /// Whether this update was staged in this process.
    var isStaged: Bool {
        stagedLock.lock()
        defer { stagedLock.unlock() }
        return staged
    }

    func markStaged() {
        stagedLock.lock()
        staged = true
        stagedLock.unlock()
    }

    /// `updateBundle(onProgress:)` for Objective-C; completes on the main queue.
    @objc(updateBundleWithProgress:completion:)
    public func updateBundle(
        onProgress: ((Double) -> Void)?,
        completion: @escaping (Bool, Error?) -> Void
    ) {
        Task {
            do {
                let staged = try await checker.updateBundle(self, onProgress: onProgress)
                DispatchQueue.main.async { completion(staged, nil) }
            } catch {
                DispatchQueue.main.async { completion(false, error) }
            }
        }
    }
}

/// What `prepare` found and did.
@objc public final class HotUpdaterPrepareResult: NSObject, @unchecked Sendable {
    @objc public let status: HotUpdaterPrepareStatus
    /// Set for `ready` and `pending`, and for `failed` when the update failed
    /// after it was selected.
    @objc public let update: HotUpdaterUpdate?
    /// Set for `failed`.
    @objc public let error: NSError?

    init(status: HotUpdaterPrepareStatus, update: HotUpdaterUpdate? = nil, error: Error? = nil) {
        self.status = status
        self.update = update
        self.error = error.map { $0 as NSError }
    }
}

// MARK: - Host

/// A response from the update server. Header names are lowercase.
struct NativeUpdateResponse {
    let status: Int
    let headers: [String: String]
    let body: String
    /// The status and headers arrived but the body did not.
    var bodyReadFailed = false
}

/// A 200 whose body could not be read: the request fails, but `response`
/// arrived and is still reported to `onHttpResponse`.
struct NativeUpdateResponseBodyError: Error {
    let response: NativeUpdateResponse
    let underlying: Error
}

protocol NativeUpdateTransport {
    func get(_ url: URL, headers: [String: String], timeout: TimeInterval) async throws -> NativeUpdateResponse
}

/// The native key-value store behind the TurboModule's `getStorageItem`.
protocol NativeUpdateEventStorage: AnyObject {
    func storageItem(_ key: String) -> String?
    func setStorageItem(_ key: String, value: String?)
}

/// The native state and methods the TurboModule exposes to JavaScript, with
/// the same dictionaries.
protocol NativeUpdateHost: NativeUpdateEventStorage {
    var appVersion: String? { get }
    var minBundleId: String { get }
    /// The running bundle, or the one the next launch runs before React Native
    /// has started; nil or the nil UUID for the built-in bundle.
    func bundleId() -> String?
    /// Whether React Native has read the bundle in this process, so a bundle
    /// staged now waits for the next start.
    func isLaunchPrepared() -> Bool
    func channel() -> String
    func defaultChannel() -> String
    func cohort() -> String
    func fingerprintHash() -> String?
    func crashHistory() -> [String]
    func activeUpdateState() -> [String: Any]
    func acceptReleaseCatalog(_ params: [String: Any]) -> Bool
    func isReleaseSelectionCurrent(_ params: [String: Any]) -> Bool
    func commitReleaseSelection(_ params: [String: Any]) async throws -> Bool
    /// Native `updateBundle`; resolves with `{ delivery, patchFallback }`.
    /// Rejects with `NativeUpdateRejection`.
    func updateBundle(_ params: [String: Any], progress: @escaping (Double) -> Void) async throws -> Any?
    func resetChannel() async -> Bool
    func releaseCatalogCache(_ partition: String) -> String?
    func setReleaseCatalogCache(_ partition: String, value: String) -> Bool
    func removeReleaseCatalogCache(_ partition: String)
}

/// A promise rejection from a native method, as JavaScript receives it.
struct NativeUpdateRejection: LocalizedError {
    let code: String?
    let message: String?
    let userInfo: [String: Any]

    var errorDescription: String? { message ?? code }
}

enum NativeUpdateCheckError: LocalizedError {
    case hotUpdater(String)
    case invalidResponse(String)
    case http(status: Int)
    case staleReleaseCatalog

    var errorDescription: String? {
        switch self {
        case .hotUpdater(let message), .invalidResponse(let message):
            return message
        case .http(let status):
            return "Request failed with HTTP \(status)"
        case .staleReleaseCatalog:
            return "Release catalog selection became stale before it was committed"
        }
    }
}

// MARK: - Events

/// Plugin hook calls for the next `HotUpdater.init` to replay, oldest first,
/// as a JSON array of `{ name, payload, occurredAt }`. One lock guards every
/// append and take in the process, so a take never loses an append.
enum NativeUpdateEvents {
    static let storageKey = "hot-updater/native-update-events"
    static let maxEventsPerName = 20

    private static let lock = NSLock()

    /// What an event is reported under: the native build (its app version and
    /// the minimum bundle ID its build generated) and the cohort.
    static func build(appVersion: String?, minBundleId: String, cohort: String) -> String {
        "\(appVersion ?? "")|\(minBundleId)|\(normalizeCohortValue(cohort))"
    }

    /// Appends an event of the native `build` it happened in, dropping the
    /// oldest of the same name beyond `maxEventsPerName`.
    static func append(
        name: String,
        payload: [String: Any],
        occurredAt: Date,
        build: String,
        to storage: NativeUpdateEventStorage
    ) {
        lock.lock()
        defer { lock.unlock() }

        var events = read(storage)
        events.append([
            "name": name,
            "payload": payload,
            "occurredAt": NSNumber(value: Int64((occurredAt.timeIntervalSince1970 * 1000).rounded())),
            "build": build,
        ] as [String: Any])
        let sameName = events.indices.filter { (events[$0] as? [String: Any])?["name"] as? String == name }
        if sameName.count > maxEventsPerName {
            for index in sameName.prefix(sameName.count - maxEventsPerName).reversed() {
                events.remove(at: index)
            }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: events),
              let value = String(data: data, encoding: .utf8) else {
            NSLog("[HotUpdater] Failed to queue \(name)")
            return
        }
        storage.setStorageItem(storageKey, value: value)
    }

    /// The queued events as a JSON array, or nil when there are none; the
    /// queue is cleared either way.
    /// Drops every queued event named `name`.
    static func remove(name: String, from storage: NativeUpdateEventStorage) {
        lock.lock()
        defer { lock.unlock() }
        let kept = read(storage).filter { ($0 as? [String: Any])?["name"] as? String != name }
        guard !kept.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: kept) else {
            storage.setStorageItem(storageKey, value: nil)
            return
        }
        storage.setStorageItem(storageKey, value: String(data: data, encoding: .utf8))
    }

    /// Takes the events of the current native `build` and cohort, clearing the
    /// queue. An event of another, such as the app version before an upgrade
    /// or a cohort set since, is dropped so none is reported against a release
    /// or cohort it did not happen in.
    static func take(from storage: NativeUpdateEventStorage, build: String) -> String? {
        lock.lock()
        defer { lock.unlock() }

        guard let stored = storage.storageItem(storageKey) else {
            return nil
        }
        storage.setStorageItem(storageKey, value: nil)
        let events = (parse(stored) ?? []).filter { ($0 as? [String: Any])?["build"] as? String == build }
        guard !events.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: events) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    private static func read(_ storage: NativeUpdateEventStorage) -> [Any] {
        storage.storageItem(storageKey).flatMap(parse) ?? []
    }

    private static func parse(_ value: String) -> [Any]? {
        try? JSONSerialization.jsonObject(with: Data(value.utf8)) as? [Any]
    }
}

// MARK: - Concurrency

private func nanoseconds(_ seconds: TimeInterval) -> UInt64 {
    guard seconds.isFinite, seconds > 0 else { return 0 }
    return UInt64(min(seconds, Double(UInt64.max / 1_000_000_000)) * 1_000_000_000)
}

/// A staging in progress, from the moment it is published on the gate until
/// it finishes; callers that join it wait for its result.
final class NativeUpdateStaging: @unchecked Sendable {
    let update: HotUpdaterUpdate
    let progress = NativeUpdateProgress()

    private let lock = NSLock()
    private var result: Result<Bool, Error>?
    private var observers: [(Result<Bool, Error>) -> Void] = []

    init(update: HotUpdaterUpdate) {
        self.update = update
    }

    /// Whether the staging has a result.
    var isFinished: Bool {
        lock.lock()
        defer { lock.unlock() }
        return result != nil
    }

    /// Calls `observer` with the result, at once when it is already known.
    func onFinish(_ observer: @escaping (Result<Bool, Error>) -> Void) {
        lock.lock()
        if let result {
            lock.unlock()
            observer(result)
            return
        }
        observers.append(observer)
        lock.unlock()
    }

    func finish(_ result: Result<Bool, Error>) {
        lock.lock()
        self.result = result
        let observers = self.observers
        self.observers = []
        lock.unlock()
        observers.forEach { $0(result) }
    }
}

/// A FIFO async mutex over native update work. Unlike an actor, it stays held
/// across suspension points, so a check and its download run one at a time.
/// The holder can hand the gate to a staging it publishes; while that staging
/// runs, callers that accept it join it instead of queueing, and callers
/// already queued that accept it are woken to join it. The staging and the
/// gate change under one lock, so no caller can see the gate free while a
/// staging is still being handed off, or miss a staging that is running.
final class NativeUpdateGate: @unchecked Sendable {
    enum Entry {
        /// The caller holds the gate and must release it.
        case acquired
        /// The caller joins this staging; it does not hold the gate.
        case joined(NativeUpdateStaging)
        /// The timeout passed or the calling task was cancelled first.
        case stopped
    }

    private final class Waiter {
        let joins: (NativeUpdateStaging) -> Bool
        var continuation: CheckedContinuation<Entry, Never>?
        var isAbandoned = false

        init(joins: @escaping (NativeUpdateStaging) -> Bool) {
            self.joins = joins
        }
    }

    private let lock = NSLock()
    private var isHeld = false
    private var staging: NativeUpdateStaging?
    private var waiters: [Waiter] = []

    /// Joins the running staging when `joins` accepts it, or else waits for
    /// the gate, for at most `timeout` seconds and until the calling task is
    /// cancelled.
    func enter(
        timeout: TimeInterval?,
        joins: @escaping (NativeUpdateStaging) -> Bool = { _ in false }
    ) async -> Entry {
        let waiter = Waiter(joins: joins)
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Entry, Never>) in
                lock.lock()
                if let staging, joins(staging) {
                    lock.unlock()
                    continuation.resume(returning: .joined(staging))
                    return
                }
                if waiter.isAbandoned {
                    lock.unlock()
                    continuation.resume(returning: .stopped)
                    return
                }
                if !isHeld {
                    isHeld = true
                    lock.unlock()
                    continuation.resume(returning: .acquired)
                    return
                }
                waiter.continuation = continuation
                waiters.append(waiter)
                lock.unlock()
                if let timeout {
                    Task {
                        try? await Task.sleep(nanoseconds: nanoseconds(timeout))
                        self.abandon(waiter)
                    }
                }
            }
        } onCancel: {
            abandon(waiter)
        }
    }

    /// Hands the gate the caller holds to `staging`, which releases it with
    /// `release(finishing:)`, and wakes the waiters that join it.
    func publish(_ staging: NativeUpdateStaging) {
        lock.lock()
        self.staging = staging
        let joining = waiters.filter { $0.joins(staging) }
        waiters.removeAll { $0.joins(staging) }
        lock.unlock()
        for waiter in joining {
            let continuation = waiter.continuation
            waiter.continuation = nil
            continuation?.resume(returning: .joined(staging))
        }
    }

    func release(finishing staging: NativeUpdateStaging? = nil) {
        lock.lock()
        if let staging, self.staging === staging {
            self.staging = nil
        }
        if waiters.isEmpty {
            isHeld = false
            lock.unlock()
        } else {
            let next = waiters.removeFirst()
            let continuation = next.continuation
            next.continuation = nil
            lock.unlock()
            continuation?.resume(returning: .acquired)
        }
    }

    private func abandon(_ waiter: Waiter) {
        lock.lock()
        waiter.isAbandoned = true
        guard let index = waiters.firstIndex(where: { $0 === waiter }) else {
            lock.unlock()
            return
        }
        waiters.remove(at: index)
        let continuation = waiter.continuation
        waiter.continuation = nil
        lock.unlock()
        continuation?.resume(returning: .stopped)
    }
}

/// How a wait for a staging ended.
private enum StagingWait {
    case finished(Result<Bool, Error>)
    /// The deadline passed or the waiting task was cancelled.
    case stopped
}

/// Resumes its waiter with the first outcome it is given.
private final class StagingWaitRace: @unchecked Sendable {
    private let lock = NSLock()
    private var outcome: StagingWait?
    private var waiter: CheckedContinuation<StagingWait, Never>?

    func wait() async -> StagingWait {
        await withCheckedContinuation { (continuation: CheckedContinuation<StagingWait, Never>) in
            lock.lock()
            if let outcome {
                lock.unlock()
                continuation.resume(returning: outcome)
            } else {
                waiter = continuation
                lock.unlock()
            }
        }
    }

    func finish(_ outcome: StagingWait) {
        lock.lock()
        guard self.outcome == nil else {
            lock.unlock()
            return
        }
        self.outcome = outcome
        let waiter = self.waiter
        self.waiter = nil
        lock.unlock()
        waiter?.resume(returning: outcome)
    }
}

/// Relays a staging's progress to its listeners on the main queue, at most
/// every 1% or 100 ms. A listener gets no value once removed; a caller that
/// waited for a finished staging still gets the values reported before, such
/// as the 1 of its download.
final class NativeUpdateProgress: @unchecked Sendable {
    private let lock = NSLock()
    private var listeners: [Int: (Double) -> Void] = [:]
    private var nextListener = 0
    private var lastValue = -1.0
    private var lastTime: TimeInterval = 0

    /// Returns the token that `remove` takes.
    @discardableResult
    func add(_ listener: ((Double) -> Void)?) -> Int? {
        guard let listener else { return nil }
        lock.lock()
        defer { lock.unlock() }
        nextListener += 1
        listeners[nextListener] = listener
        return nextListener
    }

    /// `afterPending` keeps the values already reported for the listener,
    /// such as the 1 of a finished download; otherwise none arrives after this.
    func remove(_ token: Int?, afterPending: Bool = false) {
        guard let token else { return }
        if afterPending {
            DispatchQueue.main.async { [self] in remove(token) }
            return
        }
        lock.lock()
        listeners[token] = nil
        lock.unlock()
    }

    func report(_ progress: Double) {
        let value = progress.isFinite ? min(max(progress, 0), 1) : 0
        let now = ProcessInfo.processInfo.systemUptime
        lock.lock()
        let isComplete = value >= 1 && lastValue < 1
        let isStep = value > lastValue && (value - lastValue >= 0.01 || now - lastTime >= 0.1)
        guard isComplete || isStep else {
            lock.unlock()
            return
        }
        lastValue = value
        lastTime = now
        let tokens = listeners.keys.sorted()
        lock.unlock()
        guard !tokens.isEmpty else { return }
        DispatchQueue.main.async { [self] in
            // A listener removed since, as prepare returns, gets no value.
            for token in tokens {
                lock.lock()
                let listener = listeners[token]
                lock.unlock()
                listener?(value)
            }
        }
    }
}

// MARK: - Transport

final class URLSessionUpdateTransport: NativeUpdateTransport {
    private let protocolClasses: [AnyClass]?

    /// `protocolClasses` replaces the session's URL protocols; tests stub
    /// the network with it.
    init(protocolClasses: [AnyClass]? = nil) {
        self.protocolClasses = protocolClasses
    }

    func get(_ url: URL, headers: [String: String], timeout: TimeInterval) async throws -> NativeUpdateResponse {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "GET"
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        // The catalog cache sends If-None-Match itself; URLCache must not
        // answer a 304 with a stored 200. The resource timeout bounds the
        // whole request, as the JavaScript abort does.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        if let protocolClasses {
            configuration.protocolClasses = protocolClasses
        }
        // A delegate sees the status and headers before the body, so a body
        // that breaks still reports the response that arrived.
        let collector = DataTaskCollector()
        let session = URLSession(configuration: configuration, delegate: collector, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }

        // Cancelling the caller cancels the request, so a cancelled check
        // stops waiting at once instead of at the timeout.
        let running = RunningDataTask()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                collector.onComplete = { data, response, error in
                    if let error {
                        if (error as? URLError)?.code == .cancelled {
                            continuation.resume(throwing: CancellationError())
                        } else if let response {
                            // The status arrived but the body broke: a broken error body
                            // must not hide the HTTP error, and a 200 fails with its
                            // response, as on Android.
                            let partial = NativeUpdateResponse(
                                status: response.statusCode,
                                headers: Self.headers(of: response),
                                body: "",
                                bodyReadFailed: true
                            )
                            if response.statusCode == 200 {
                                continuation.resume(throwing: NativeUpdateResponseBodyError(response: partial, underlying: error))
                            } else {
                                continuation.resume(returning: partial)
                            }
                        } else {
                            continuation.resume(throwing: error)
                        }
                        return
                    }
                    guard let response else {
                        continuation.resume(throwing: URLError(.badServerResponse))
                        return
                    }
                    continuation.resume(returning: NativeUpdateResponse(
                        status: response.statusCode,
                        headers: Self.headers(of: response),
                        body: String(decoding: data, as: UTF8.self)
                    ))
                }
                running.start(session.dataTask(with: request))
            }
        } onCancel: {
            running.cancel()
        }
    }
}

extension URLSessionUpdateTransport {
    fileprivate static func headers(of response: HTTPURLResponse) -> [String: String] {
        var headers = [String: String]()
        for (name, value) in response.allHeaderFields {
            guard let name = name as? String else { continue }
            headers[name.lowercased()] = "\(value)"
        }
        return headers
    }
}

/// Collects one data task's response, body, and completion for its caller.
private final class DataTaskCollector: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var response: HTTPURLResponse?
    private var data = Data()
    private var completion: ((Data, HTTPURLResponse?, Error?) -> Void)?

    var onComplete: ((Data, HTTPURLResponse?, Error?) -> Void)? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return completion
        }
        set {
            lock.lock()
            completion = newValue
            lock.unlock()
        }
    }

    func urlSession(
        _: URLSession,
        dataTask _: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        lock.lock()
        self.response = response as? HTTPURLResponse
        lock.unlock()
        completionHandler(.allow)
    }

    func urlSession(_: URLSession, dataTask _: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        self.data.append(data)
        lock.unlock()
    }

    func urlSession(_: URLSession, task _: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let result = (data, response, completion)
        completion = nil
        lock.unlock()
        result.2?(result.0, result.1, error)
    }
}

/// The data task of one request; cancelling before it starts cancels it as
/// it starts.
private final class RunningDataTask: @unchecked Sendable {
    private let lock = NSLock()
    private var task: URLSessionDataTask?
    private var cancelled = false

    func start(_ task: URLSessionDataTask) {
        lock.lock()
        self.task = task
        let cancelled = self.cancelled
        lock.unlock()
        task.resume()
        if cancelled {
            task.cancel()
        }
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let task = self.task
        lock.unlock()
        task?.cancel()
    }
}

// MARK: - Update check

/// A point on the monotonic clock, so a change of the device's wall clock
/// neither extends nor ends a deadline early.
struct NativeUpdateDeadline {
    private let uptime: TimeInterval

    init(after interval: TimeInterval) {
        uptime = ProcessInfo.processInfo.systemUptime + interval
    }

    var remaining: TimeInterval {
        uptime - ProcessInfo.processInfo.systemUptime
    }
}

final class NativeUpdateChecker {
    private static let nilUUID = "00000000-0000-0000-0000-000000000000"
    private static let maxETagBytes = 1024
    private static let maxCatalogCacheEntryBytes =
        ReleaseCatalogLimits.maxReleaseCatalogWireBytes + maxETagBytes + 3

    private let host: NativeUpdateHost
    private let transport: NativeUpdateTransport
    /// The wall clock, for the times events record; deadlines use the
    /// monotonic clock.
    private let now: () -> Date
    private let gate = NativeUpdateGate()
    private let committedTargetLock = NSLock()
    /// The channel the check or staging holding the gate requests, recorded
    /// with its HTTP responses: an explicit channel is not the runtime one
    /// until the switch commits.
    private var requestChannelValue: String?
    /// The cohort the check or staging holding the gate selected for, which
    /// its events report.
    private var requestCohortValue: String?
    /// The target the last staging committed, for another retained result of
    /// the same target.
    private var lastCommittedTargetKey: String?

    init(
        host: NativeUpdateHost,
        transport: NativeUpdateTransport = URLSessionUpdateTransport(),
        now: @escaping () -> Date = Date.init
    ) {
        self.host = host
        self.transport = transport
        self.now = now
    }

    /// The update the app should apply, or nil. A failed check queues
    /// `onUpdateError` and throws. Waits for other native update work
    /// without a deadline.
    func checkForUpdate(_ options: HotUpdaterCheckOptions) async throws -> HotUpdaterUpdate? {
        guard case .acquired = await gate.enter(timeout: nil) else {
            throw CancellationError()
        }
        defer { gate.release() }
        return try await check(options, deadline: nil)
    }

    /// Checks and stages an update within one deadline, `timeout` seconds from
    /// now, that covers waiting for other native update work, the catalog
    /// request, and a required update's download. The deadline and
    /// cancellation end the wait, never the download. A download already
    /// running is joined instead of checking again. Never throws.
    func prepare(
        _ options: HotUpdaterCheckOptions,
        timeout: TimeInterval,
        onProgress: ((Double) -> Void)? = nil
    ) async -> HotUpdaterPrepareResult {
        guard timeout > 0 else {
            return HotUpdaterPrepareResult(
                status: .failed,
                error: NativeUpdateCheckError.hotUpdater("prepare timeout must be greater than 0")
            )
        }
        let deadline = NativeUpdateDeadline(after: timeout)

        // A staging from other options is waited for, then this request is checked.
        let requestKey = Self.requestKey(options, cohort: normalizeCohortValue(host.cohort()))
        var failedStaging: NativeUpdateStaging?
        entering: while true {
            switch await gate.enter(
                timeout: remaining(until: deadline),
                joins: { $0 !== failedStaging && $0.update.requestKey == requestKey }
            ) {
            case .joined(let staging):
                let joined = await finishPrepare(staging, deadline: deadline, onProgress: onProgress)
                // The staging may have failed on its own caller's shorter
                // timeout; this call checks again within its own deadline.
                if joined.status == .failed, remaining(until: deadline) > 0 {
                    failedStaging = staging
                    continue entering
                }
                return joined
            case .stopped:
                let error: Error = Task.isCancelled
                    ? CancellationError()
                    : NativeUpdateCheckError.hotUpdater("Timed out waiting for another update check")
                if !Task.isCancelled {
                    // As the check it never ran would report its own timeout.
                    reportUpdateError(
                        URLError(.timedOut),
                        stage: "check",
                        resource: "catalog",
                        scope: ErrorScope(
                            channel: options.channel.flatMap { $0.isEmpty ? nil : $0 } ?? host.channel(),
                            bundleId: resolveBundleId(host.bundleId()),
                            updateStrategy: options.updateStrategy,
                            targetBundleId: nil,
                            targetReleaseId: nil
                        ),
                        // The waiting prepare's cohort, not the one the check
                        // holding the gate captured.
                        cohort: normalizeCohortValue(host.cohort())
                    )
                }
                NSLog("[HotUpdater] prepare: \(error.localizedDescription)")
                return HotUpdaterPrepareResult(status: .failed, error: error)
            case .acquired:
                break entering
            }
        }

        let update: HotUpdaterUpdate?
        do {
            update = try await check(options, deadline: deadline)
        } catch {
            gate.release()
            NSLog("[HotUpdater] Update check failed: \(error.localizedDescription)")
            return HotUpdaterPrepareResult(status: .failed, error: error)
        }
        guard let update else {
            gate.release()
            return HotUpdaterPrepareResult(status: .upToDate)
        }
        // The deadline ends the wait, not the staging: its requests keep their
        // own timeouts after prepare returns, as on Android.
        let staging = startStaging(update, deadline: nil)
        return await finishPrepare(staging, deadline: deadline, onProgress: onProgress)
    }

    /// Stages `update`, joins its staging already running, or returns true at
    /// once when it was already staged.
    func updateBundle(_ update: HotUpdaterUpdate, onProgress: ((Double) -> Void)?) async throws -> Bool {
        // A reset or a newer catalog can undo a staging; it counts only while current.
        if update.isStaged, update.isSelectionCurrent() {
            return true
        }
        let staging: NativeUpdateStaging
        switch await gate.enter(timeout: nil, joins: { $0.update.targetKey == update.targetKey }) {
        case .joined(let running):
            staging = running
        case .stopped:
            throw CancellationError()
        case .acquired:
            // A staging of the same target may have committed while this call
            // waited, or before it was made; it counts while the selection is current.
            if update.isStaged || committedTarget == update.targetKey {
                let current = update.isSelectionCurrent()
                gate.release()
                guard current else {
                    throw NativeUpdateCheckError.staleReleaseCatalog
                }
                update.markStaged()
                return true
            }
            staging = startStaging(update, deadline: nil)
        }
        let listener = staging.progress.add(onProgress)
        defer { staging.progress.remove(listener, afterPending: staging.isFinished) }
        switch await wait(for: staging, until: nil) {
        case .finished(let result):
            let committed = try result.get()
            // A joined staging of the same target staged this update too.
            if committed { update.markStaged() }
            return committed
        case .stopped:
            throw CancellationError()
        }
    }

    /// Clears the runtime channel once other native update work finishes.
    /// A reset deletes staged bundles, so their queued downloads are dropped
    /// rather than replayed.
    func resetChannel() async -> Bool {
        await whenIdle {
            let reset = await self.host.resetChannel()
            if reset { NativeUpdateEvents.remove(name: "onBundleDownloaded", from: self.host) }
            return reset
        } ?? false
    }

    /// Runs `body` once no check or staging runs, as a channel reset must: a
    /// staging that finished after the reset would save its channel again.
    /// Returns nil when the wait is cancelled.
    @discardableResult
    func whenIdle<T>(_ body: () async -> T) async -> T? {
        guard case .acquired = await gate.enter(timeout: nil) else {
            return nil
        }
        defer { gate.release() }
        // What runs here, such as a reset, can undo what was staged.
        committedTarget = nil
        return await body()
    }

    private var requestChannel: String? {
        get {
            committedTargetLock.lock()
            defer { committedTargetLock.unlock() }
            return requestChannelValue
        }
        set {
            committedTargetLock.lock()
            requestChannelValue = newValue
            committedTargetLock.unlock()
        }
    }

    private var requestCohort: String? {
        get {
            committedTargetLock.lock()
            defer { committedTargetLock.unlock() }
            return requestCohortValue
        }
        set {
            committedTargetLock.lock()
            requestCohortValue = newValue
            committedTargetLock.unlock()
        }
    }

    private var committedTarget: String? {
        get {
            committedTargetLock.lock()
            defer { committedTargetLock.unlock() }
            return lastCommittedTargetKey
        }
        set {
            committedTargetLock.lock()
            lastCommittedTargetKey = newValue
            committedTargetLock.unlock()
        }
    }

    private func finishPrepare(
        _ staging: NativeUpdateStaging,
        deadline: NativeUpdateDeadline,
        onProgress: ((Double) -> Void)?
    ) async -> HotUpdaterPrepareResult {
        // The listener ends with this call; the staging may go on.
        let listener = staging.progress.add(onProgress)
        defer { staging.progress.remove(listener, afterPending: staging.isFinished) }
        let update = staging.update
        // Recording the selection of the bundle this start already runs, such
        // as on the first start after an update, leaves nothing to apply.
        if update.runsCurrentBundle {
            switch await wait(for: staging, until: deadline) {
            case .finished(.success(false)):
                return HotUpdaterPrepareResult(
                    status: .failed,
                    update: update,
                    error: NativeUpdateCheckError.staleReleaseCatalog
                )
            case .finished(.failure(let error)):
                return HotUpdaterPrepareResult(status: .failed, update: update, error: error)
            case .finished(.success(true)), .stopped:
                return HotUpdaterPrepareResult(status: .upToDate)
            }
        }
        // An update that is not required downloads in the background.
        guard update.shouldForceUpdate else {
            return HotUpdaterPrepareResult(status: .pending, update: update)
        }
        switch await wait(for: staging, until: deadline) {
        case .stopped:
            NSLog("[HotUpdater] prepare stopped waiting; the update keeps downloading")
            return HotUpdaterPrepareResult(status: .pending, update: update)
        case .finished(.success(true)):
            // A bundle staged after React Native read the bundle waits for the
            // next start.
            return HotUpdaterPrepareResult(status: host.isLaunchPrepared() ? .pending : .ready, update: update)
        case .finished(.success(false)):
            return HotUpdaterPrepareResult(
                status: .failed,
                update: update,
                error: NativeUpdateCheckError.staleReleaseCatalog
            )
        case .finished(.failure(let error)):
            NSLog("[HotUpdater] Update failed: \(error.localizedDescription)")
            return HotUpdaterPrepareResult(status: .failed, update: update, error: error)
        }
    }

    private func remaining(until deadline: NativeUpdateDeadline) -> TimeInterval {
        deadline.remaining
    }

    /// Hands the gate the caller holds to a staging of `update`, published
    /// before it starts, which releases the gate when it finishes.
    private func startStaging(_ update: HotUpdaterUpdate, deadline: NativeUpdateDeadline?) -> NativeUpdateStaging {
        let staging = NativeUpdateStaging(update: update)
        gate.publish(staging)
        Task { [self] in
            let result: Result<Bool, Error>
            do {
                result = .success(try await update.install(deadline, staging.progress.report))
            } catch {
                result = .failure(error)
            }
            if case .success(true) = result {
                update.markStaged()
                committedTarget = update.targetKey
            }
            staging.finish(result)
            gate.release(finishing: staging)
        }
        return staging
    }

    /// Waits for a staging until `deadline` or cancellation, which leave the
    /// staging running.
    private func wait(for staging: NativeUpdateStaging, until deadline: NativeUpdateDeadline?) async -> StagingWait {
        let race = StagingWaitRace()
        staging.onFinish { race.finish(.finished($0)) }
        if let deadline {
            let timeout = remaining(until: deadline)
            Task {
                try? await Task.sleep(nanoseconds: nanoseconds(timeout))
                race.finish(.stopped)
            }
        }
        return await withTaskCancellationHandler {
            await race.wait()
        } onCancel: {
            race.finish(.stopped)
        }
    }

    // MARK: checkForUpdate

    private func check(_ options: HotUpdaterCheckOptions, deadline: NativeUpdateDeadline?) async throws -> HotUpdaterUpdate? {
        let baseURL = try Self.validatedBaseURL(options.baseURL)
        let currentAppVersion = host.appVersion
        let currentBundleId = resolveBundleId(host.bundleId())
        let minimumReleaseId = host.minBundleId
        let defaultChannel = host.defaultChannel()
        let nativeChannel = host.channel()
        let isSwitched = nativeChannel != defaultChannel
        let currentChannel = isSwitched ? nativeChannel : defaultChannel
        let explicitChannel = options.channel.flatMap { $0.isEmpty ? nil : $0 }
        let targetChannel = explicitChannel ?? currentChannel
        let cohort = try Self.normalizeAndValidateCohort(host.cohort())

        guard let currentAppVersion, !currentAppVersion.isEmpty else {
            throw NativeUpdateCheckError.hotUpdater("Failed to get app version")
        }

        if isSwitched, let explicitChannel, explicitChannel != currentChannel {
            throw NativeUpdateCheckError.hotUpdater(
                "Runtime channel is already switched to \"\(currentChannel)\". Call hotUpdater.resetChannel() before checking \"\(explicitChannel)\"."
            )
        }

        let fingerprintHash = host.fingerprintHash()
        requestChannel = targetChannel
        requestCohort = cohort

        let update: HotUpdaterUpdate?
        do {
            update = try await checkReleaseCatalog(
                options: options,
                baseURL: baseURL,
                deadline: deadline,
                currentAppVersion: currentAppVersion,
                currentBundleId: currentBundleId,
                minimumReleaseId: minimumReleaseId,
                currentChannel: currentChannel,
                targetChannel: targetChannel,
                explicitChannel: explicitChannel,
                cohort: cohort,
                fingerprintHash: fingerprintHash
            )
        } catch {
            reportUpdateError(
                error,
                stage: "check",
                resource: "catalog",
                scope: ErrorScope(
                    channel: targetChannel,
                    bundleId: currentBundleId,
                    updateStrategy: options.updateStrategy,
                    targetBundleId: nil,
                    targetReleaseId: nil
                )
            )
            throw error
        }
        if update == nil {
            // The app keeps its bundle, as checkForUpdate.ts reports it.
            let releaseId = runningReleaseId(bundleId: currentBundleId, channel: currentChannel)
            queueUnchanged(channel: currentChannel, bundleId: currentBundleId, releaseId: releaseId, previousReleaseId: releaseId)
        }
        return update
    }

    private func checkReleaseCatalog(
        options: HotUpdaterCheckOptions,
        baseURL: String,
        deadline: NativeUpdateDeadline?,
        currentAppVersion: String,
        currentBundleId: String,
        minimumReleaseId: String,
        currentChannel: String,
        targetChannel: String,
        explicitChannel: String?,
        cohort: String,
        fingerprintHash: String?
    ) async throws -> HotUpdaterUpdate? {
        let channelKey = try encodeChannelKey(targetChannel)
        let strategy: ReleaseStrategy = options.updateStrategy == .appVersion ? .appVersion : .fingerprint
        let canonicalAppVersion = canonicalizeAppVersion(currentAppVersion)
        if strategy == .appVersion && canonicalAppVersion == nil {
            throw NativeUpdateCheckError.hotUpdater("Failed to canonicalize app version")
        }
        let fingerprintHash = fingerprintHash.flatMap { $0.isEmpty ? nil : $0 }
        if strategy == .fingerprint && fingerprintHash == nil {
            throw NativeUpdateCheckError.hotUpdater("Fingerprint hash is required")
        }
        let strategyValue = strategy == .appVersion ? canonicalAppVersion! : fingerprintHash!
        let expectedScope = ReleaseCatalogScope(
            platform: .ios,
            channelKey: channelKey,
            strategy: strategy,
            fingerprintHash: strategy == .fingerprint ? fingerprintHash : nil
        )
        let strategyPath = strategy == .fingerprint ? "fingerprint" : "app-version"
        let catalogURL = "\(baseURL)/release-catalogs/\(strategyPath)/ios/\(channelKey)/\(Self.encodeURIComponent(strategyValue))"
        // The server says this scope has no catalog yet: no update, not a failure.
        guard let catalog = try await fetchReleaseCatalog(
            baseURL: baseURL,
            url: catalogURL,
            expectedScope: expectedScope,
            options: options,
            deadline: deadline
        ) else {
            return nil
        }
        let catalogId = catalog.catalogId
        let scopeKey = catalog.scopeKey

        let crashedBundleIds = host.crashHistory()
        let activeState = host.activeUpdateState()
        let active = Self.parseSelection(activeState["activeSelection"])
        let stable = Self.parseSelection(activeState["stableSelection"])
        let explicitScopeSwitch = explicitChannel != nil && explicitChannel != currentChannel
        let activeInTargetScope = active.flatMap { active in
            active.catalogId.jsEquals(catalogId) && active.scopeKey.jsEquals(scopeKey) ? active : nil
        }
        let hasAuthenticatedActive = active.map {
            $0.catalogId != nil && $0.scopeKey != nil && $0.generation != nil
        } ?? false
        if hasAuthenticatedActive && activeInTargetScope == nil && !explicitScopeSwitch {
            throw NativeUpdateCheckError.hotUpdater("Release transition rejected: UNSOLICITED_SCOPE")
        }
        let selectorCurrentBundleId =
            activeInTargetScope != nil || (!hasAuthenticatedActive && !explicitScopeSwitch)
                ? currentBundleId
                : minimumReleaseId
        let selectionContextHash = createReleaseSelectionContextHash(ReleaseSelectionContext(
            activeBundleId: selectorCurrentBundleId,
            activeReleaseId: activeInTargetScope?.releaseId,
            cohort: cohort,
            minimumReleaseId: minimumReleaseId,
            strategy: strategy,
            strategyValue: strategyValue,
            crashedBundleIds: crashedBundleIds
        ))
        let guardParams: [String: Any] = [
            "catalogId": catalogId,
            "catalogHash": catalog.catalogHash,
            "channel": targetChannel,
            "generation": NSNumber(value: catalog.generation),
            "scopeKey": scopeKey,
            "selectionContextHash": selectionContextHash,
        ]
        guard host.acceptReleaseCatalog(guardParams) else {
            throw NativeUpdateCheckError.invalidResponse("Rejected a stale or inconsistent Release catalog")
        }
        let stableInTargetScope = stable.flatMap { stable in
            stable.catalogId.jsEquals(catalogId) && stable.scopeKey.jsEquals(scopeKey) ? stable : nil
        }
        // A staged update is active but not running yet; force decisions count
        // from the Release the app runs.
        let runningReleaseId = [activeInTargetScope, stableInTargetScope]
            .first { $0?.bundleId.jsEquals(selectorCurrentBundleId) == true }??
            .releaseId
        guard let desired = selectDesiredRelease(catalog, input: ReleaseSelectionInput(
            builtInBundleId: minimumReleaseId,
            currentBundleId: selectorCurrentBundleId,
            activeReleaseId: activeInTargetScope?.releaseId,
            runningReleaseId: .some(runningReleaseId),
            minimumReleaseId: minimumReleaseId,
            cohort: cohort,
            crashedBundleIds: crashedBundleIds
        )) else {
            return nil
        }

        if desired.kind == .builtin,
           currentBundleId.jsEquals(minimumReleaseId),
           active == nil || active?.kind.jsEquals(SelectionKind.builtin.rawValue) == true {
            return nil
        }

        let receipt = PersistedSelection(
            kind: desired.kind.rawValue,
            releaseId: desired.releaseId,
            bundleId: desired.bundleId,
            catalogId: catalogId,
            scopeKey: scopeKey,
            generation: catalog.generation,
            catalogHash: catalog.catalogHash,
            channel: targetChannel,
            selectionContextHash: selectionContextHash
        )
        if let active, Self.sameReceipt(active, receipt) {
            return nil
        }

        let authorization = authorizeReleaseTransition(
            active: active,
            desired: receipt,
            explicitScopeSwitch: explicitScopeSwitch
        )
        if !authorization.authorized {
            if authorization.reason == .emptyTargetScope {
                return nil
            }
            throw NativeUpdateCheckError.hotUpdater("Release transition rejected: \(authorization.reason.rawValue)")
        }

        let release = desired.release
        let transitionKind: String
        if desired.kind == .builtin {
            transitionKind = "USE_BUILTIN"
        } else if active?.bundleId.jsEquals(desired.bundleId) == true {
            transitionKind = "ADOPT_RELEASE"
        } else {
            transitionKind = "INSTALL"
        }
        let fromReleaseId: String?
        if let active, active.bundleId.jsEquals(currentBundleId) {
            fromReleaseId = active.releaseId
        } else if let stable, stable.bundleId.jsEquals(currentBundleId) {
            fromReleaseId = stable.releaseId
        } else {
            fromReleaseId = nil
        }
        let errorScope = ErrorScope(
            channel: targetChannel,
            bundleId: currentBundleId,
            updateStrategy: options.updateStrategy,
            targetBundleId: desired.bundleId,
            targetReleaseId: desired.releaseId
        )

        let installSelection = { [self] (deadline: NativeUpdateDeadline?, progress: @escaping (Double) -> Void) async throws -> Bool in
            requestChannel = targetChannel
            requestCohort = cohort
            guard host.isReleaseSelectionCurrent(guardParams) else {
                throw NativeUpdateCheckError.staleReleaseCatalog
            }

            if transitionKind != "INSTALL" {
                let committed = try await host.commitReleaseSelection([
                    "guard": guardParams,
                    "selection": receipt.dictionary,
                ])
                if committed, transitionKind == "USE_BUILTIN" {
                    // The built-in bundle replaced every staged one: their downloads are void.
                    NativeUpdateEvents.remove(name: "onBundleDownloaded", from: host)
                }
                if committed, transitionKind == "ADOPT_RELEASE" {
                    // The running bundle is now selected as a newer Release.
                    queueUnchanged(
                        channel: receipt.channel,
                        bundleId: receipt.bundleId,
                        releaseId: receipt.releaseId,
                        previousReleaseId: active?.releaseId
                    )
                }
                return committed
            }

            let artifact = try await resolveArtifact(
                baseURL: baseURL,
                currentBundleId: currentBundleId,
                targetBundleId: desired.bundleId,
                options: options,
                deadline: deadline
            )
            guard host.isReleaseSelectionCurrent(guardParams) else {
                throw NativeUpdateCheckError.staleReleaseCatalog
            }
            var params: [String: Any] = [
                "assets": artifact.assets,
                "bundleId": desired.bundleId,
                "channel": targetChannel,
                "manifestFileHash": artifact.manifestFileHash,
                "manifestUrl": artifact.manifestUrl,
                "selection": receipt.dictionary,
            ]
            if let archiveUrl = artifact.archiveUrl {
                params["archiveUrl"] = archiveUrl
            }
            let staged = try await host.updateBundle(params, progress: progress)
            if let delivery = Self.readBundleDelivery(staged),
               !desired.bundleId.jsEquals(currentBundleId) {
                var payload: [String: Any] = [
                    "channel": targetChannel,
                    "fromBundleId": currentBundleId,
                    "fromReleaseId": fromReleaseId ?? NSNull(),
                    "toBundleId": desired.bundleId,
                    "toReleaseId": desired.releaseId ?? NSNull(),
                    "updateStrategy": options.updateStrategy.name,
                ]
                payload.merge(delivery) { _, delivery in delivery }
                queueEvent("onBundleDownloaded", payload)
            }
            return true
        }
        let updateBundleForSelection = { [self] (deadline: NativeUpdateDeadline?, progress: @escaping (Double) -> Void) async throws -> Bool in
            do {
                return try await installSelection(deadline, progress)
            } catch {
                reportUpdateError(error, stage: "download", resource: "artifact", scope: errorScope)
                throw error
            }
        }

        // Adopting the bundle the app already runs needs no reload; adopting a
        // staged one does when the selector forces it.
        let shouldForceUpdate = desired.bundleId.jsEquals(currentBundleId) ? false : desired.shouldForceUpdate
        queueEvent("onUpdateCheck", [
            "status": "UPDATE_AVAILABLE",
            "channel": targetChannel,
            "fromBundleId": currentBundleId,
            "fromReleaseId": fromReleaseId ?? NSNull(),
            "toBundleId": desired.bundleId,
            "toReleaseId": desired.releaseId ?? NSNull(),
            "transitionKind": transitionKind,
            "updateStatus": desired.status.rawValue,
            "shouldForceUpdate": shouldForceUpdate,
            "updateStrategy": options.updateStrategy.name,
        ])

        return HotUpdaterUpdate(
            id: desired.releaseId ?? desired.bundleId,
            releaseId: desired.releaseId,
            status: desired.status == .rollback ? .rollback : .update,
            shouldForceUpdate: shouldForceUpdate,
            message: release?.message,
            bundleId: desired.bundleId,
            transitionKind: transitionKind,
            runsCurrentBundle: desired.bundleId.jsEquals(currentBundleId),
            // JSON, so no field can spell another, such as a channel with a colon.
            targetKey: Self.jsonKey([
                desired.kind.rawValue, desired.bundleId, desired.releaseId ?? NSNull(), targetChannel,
                catalogId, catalog.generation, catalog.catalogHash, selectionContextHash,
            ]),
            requestKey: Self.requestKey(options, cohort: cohort),
            checker: self,
            install: updateBundleForSelection,
            isSelectionCurrent: { [host] in host.isReleaseSelectionCurrent(guardParams) }
        )
    }

    // MARK: State

    /// What a check reads: the server, the strategy, the channel it asks for,
    /// the cohort it selects for, and the headers, which can name the
    /// credentials or tenant.
    private static func requestKey(_ options: HotUpdaterCheckOptions, cohort: String) -> String {
        var baseURL = options.baseURL
        while baseURL.hasSuffix("/") { baseURL.removeLast() }
        // The headers the transport sends, so two options that send the same
        // headers share a key, as the catalog cache partition does.
        let headers = normalizedHeaders(options.requestHeaders)
            .sorted { $0.key < $1.key }
            .map { [$0.key, $0.value] }
        // JSON, so no field can spell another, such as a channel with a newline.
        return jsonKey([baseURL, options.updateStrategy.name, options.channel ?? "", cohort, headers])
    }

    private static func jsonKey(_ fields: [Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: fields)) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }

    private func queueUnchanged(channel: String, bundleId: String, releaseId: String?, previousReleaseId: String?) {
        queueEvent("onUpdateCheck", [
            "status": "UNCHANGED",
            "channel": channel,
            "bundleId": bundleId,
            "releaseId": releaseId ?? NSNull(),
            "previousReleaseId": previousReleaseId ?? NSNull(),
        ])
    }

    private func resolveBundleId(_ bundleId: String?) -> String {
        guard let bundleId, !bundleId.isEmpty, bundleId != Self.nilUUID else {
            return host.minBundleId
        }
        return bundleId
    }

    private func runningReleaseId(bundleId: String, channel: String) -> String? {
        let state = host.activeUpdateState()
        return [state["activeSelection"], state["stableSelection"]]
            .compactMap(Self.parseSelection)
            .first { $0.bundleId.jsEquals(bundleId) && $0.channel.jsEquals(channel) }?
            .releaseId
    }

    private static func parseSelection(_ value: Any?) -> PersistedSelection? {
        guard let data = value as? [String: Any],
              let kind = data["kind"] as? String,
              let bundleId = data["bundleId"] as? String,
              let channel = data["channel"] as? String else {
            return nil
        }
        return PersistedSelection(
            kind: kind,
            releaseId: data["releaseId"] as? String,
            bundleId: bundleId,
            catalogId: data["catalogId"] as? String,
            scopeKey: data["scopeKey"] as? String,
            generation: (data["generation"] as? NSNumber)?.int64Value,
            catalogHash: data["catalogHash"] as? String,
            channel: channel,
            selectionContextHash: data["selectionContextHash"] as? String
        )
    }

    private static func sameReceipt(_ first: PersistedSelection, _ second: PersistedSelection) -> Bool {
        first.kind.jsEquals(second.kind)
            && first.releaseId.jsEquals(second.releaseId)
            && first.bundleId.jsEquals(second.bundleId)
            && first.catalogId.jsEquals(second.catalogId)
            && first.scopeKey.jsEquals(second.scopeKey)
            && first.generation == second.generation
            && first.catalogHash.jsEquals(second.catalogHash)
            && first.channel.jsEquals(second.channel)
            && first.selectionContextHash.jsEquals(second.selectionContextHash)
    }

    private static func normalizeAndValidateCohort(_ cohort: String) throws -> String {
        let normalized = normalizeCohortValue(cohort)
        let isNumeric = Int(normalized).map { (1...ReleaseCatalogLimits.numericCohortSize).contains($0) } ?? false
        guard isNumeric || isCustomCohort(normalized) else {
            throw NativeUpdateCheckError.hotUpdater(
                "Invalid cohort. Use 1-1000 or a lowercase slug without spaces, up to \(ReleaseCatalogLimits.maxCohortLength) characters."
            )
        }
        return normalized
    }

    private static func readBundleDelivery(_ value: Any?) -> [String: Any]? {
        guard let value = value as? [String: Any],
              let delivery = value["delivery"] as? String,
              ["patch", "manifest", "archive"].contains(delivery) else {
            return nil
        }
        return ["delivery": delivery, "patchFallback": value["patchFallback"] as? Bool == true]
    }

    // MARK: HTTP

    /// `baseURL` without trailing slashes; it must be an absolute HTTP(S) URL.
    private static func validatedBaseURL(_ baseURL: String) throws -> String {
        var value = baseURL
        while value.hasSuffix("/") {
            value.removeLast()
        }
        guard let url = URL(string: value),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              url.host?.isEmpty == false else {
            throw NativeUpdateCheckError.hotUpdater("Invalid baseURL: \(baseURL)")
        }
        return value
    }

    private static let uriComponentAllowed = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
    )

    static func encodeURIComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: uriComponentAllowed) ?? value
    }

    /// Header names lowercased, as `new Headers(requestHeaders)` stores them.
    private static func normalizedHeaders(_ headers: [String: String]) -> [String: String] {
        var normalized = [String: String]()
        for (name, value) in headers {
            normalized[name.lowercased()] = value
        }
        return normalized
    }

    /// Requests `url` with `requestTimeout`, cut to what is left before `deadline`.
    private func get(
        _ url: String,
        resource: String,
        headers: [String: String],
        options: HotUpdaterCheckOptions,
        deadline: NativeUpdateDeadline?
    ) async throws -> NativeUpdateResponse {
        guard let requestURL = URL(string: url) else {
            throw URLError(.badURL)
        }
        var timeout = options.requestTimeout
        if let deadline {
            let remaining = deadline.remaining
            guard remaining > 0 else {
                throw URLError(.timedOut)
            }
            timeout = min(timeout, remaining)
        }
        do {
            let response = try await transport.get(requestURL, headers: headers, timeout: timeout)
            queueHttpResponse(requestURL, resource: resource, response)
            return response
        } catch let error as NativeUpdateResponseBodyError {
            // Reported with a null body, as fetchUpdateResponse.ts does, and the
            // request fails as it did.
            queueHttpResponse(requestURL, resource: resource, error.response)
            throw error.underlying
        }
    }

    /// The longest response body queued: the queue lives in the key-value store.
    private static let httpResponseBodyLimit = 4_096

    /// Queues a catalog or artifact response for `onHttpResponse`, as
    /// fetchUpdateResponse.ts reports it. `resource` is "catalog" or "artifact".
    private func queueHttpResponse(_ url: URL, resource: String, _ response: NativeUpdateResponse) {
        let path = url.path.isEmpty ? "/" : url.path
        let truncated = response.body.count > Self.httpResponseBodyLimit
        var payload: [String: Any] = [
            "resource": resource,
            "path": path,
            "status": response.status,
            "body": response.bodyReadFailed
                ? NSNull()
                : truncated ? String(response.body.prefix(Self.httpResponseBodyLimit)) : response.body,
            "bodyTruncated": truncated,
        ]
        if let requestChannel { payload["channel"] = requestChannel }
        queueEvent("onHttpResponse", payload)
    }

    private struct Artifact {
        let assets: [String: Any]
        let manifestUrl: String
        let manifestFileHash: String
        let archiveUrl: String?
    }

    private func resolveArtifact(
        baseURL: String,
        currentBundleId: String,
        targetBundleId: String,
        options: HotUpdaterCheckOptions,
        deadline: NativeUpdateDeadline?
    ) async throws -> Artifact {
        var headers = Self.normalizedHeaders(options.requestHeaders)
        if headers["accept"] == nil {
            headers["accept"] = "application/json"
        }
        let response = try await get(
            "\(baseURL)/artifacts/v1/\(Self.encodeURIComponent(targetBundleId))/from/\(Self.encodeURIComponent(currentBundleId))",
            resource: "artifact",
            headers: headers,
            options: options,
            deadline: deadline
        )
        guard response.status == 200 else {
            throw NativeUpdateCheckError.http(status: response.status)
        }
        guard let object = try? JSONSerialization.jsonObject(with: Data(response.body.utf8), options: [.fragmentsAllowed]),
              let info = object as? [String: Any] else {
            throw NativeUpdateCheckError.invalidResponse("Received an invalid artifact response")
        }
        try Self.requireArtifactProtocolV1(info)
        try Self.requireArtifactUrls(info)
        return Artifact(
            assets: info["assets"] as! [String: Any],
            manifestUrl: info["manifestUrl"] as! String,
            manifestFileHash: info["manifestFileHash"] as! String,
            archiveUrl: (info["archiveUrl"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        )
    }

    private static func requireArtifactProtocolV1(_ info: [String: Any]) throws {
        let unsupported = NativeUpdateCheckError.invalidResponse("Server does not support artifact protocol 1.")
        guard let version = info["artifactProtocolVersion"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(),
              version.doubleValue == 1,
              let assets = info["assets"] as? [String: Any],
              let manifestUrl = info["manifestUrl"] as? String, !manifestUrl.isEmpty,
              let manifestFileHash = info["manifestFileHash"] as? String, !manifestFileHash.isEmpty else {
            throw unsupported
        }
        if let archiveUrl = info["archiveUrl"], !(archiveUrl is String) {
            throw unsupported
        }
        for asset in assets.values {
            let asset = asset as? [String: Any]
            let file = asset?["file"] as? [String: Any]
            guard let url = file?["url"] as? String, !url.isEmpty,
                  let fileHash = asset?["fileHash"] as? String, !fileHash.isEmpty else {
                throw NativeUpdateCheckError.invalidResponse(
                    "Artifact protocol 1 requires an original file for every asset."
                )
            }
        }
    }

    /// A URL the device downloads from: the server returns each one absolute.
    private static func requireArtifactUrl(_ value: String) throws {
        guard value.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil else {
            throw NativeUpdateCheckError.invalidResponse("Artifact URLs must be absolute HTTP(S) URLs.")
        }
        // Foundation parses a hostless "https://"; a download needs a host.
        guard let url = URL(string: value), url.host?.isEmpty == false else {
            throw NativeUpdateCheckError.invalidResponse("Invalid artifact URL: \(value)")
        }
    }

    private static func requireArtifactUrls(_ info: [String: Any]) throws {
        try requireArtifactUrl(info["manifestUrl"] as? String ?? "")
        if let archiveUrl = info["archiveUrl"] as? String, !archiveUrl.isEmpty {
            try requireArtifactUrl(archiveUrl)
        }
        for asset in (info["assets"] as? [String: Any] ?? [:]).values {
            let asset = asset as? [String: Any]
            try requireArtifactUrl((asset?["file"] as? [String: Any])?["url"] as? String ?? "")
            // A patch is an object, or null, false or absent for none, as
            // JavaScript and Android read it.
            switch asset?["patch"] {
            case nil, is NSNull:
                break
            case let patch as [String: Any]:
                try requireArtifactUrl(patch["patchUrl"] as? String ?? "")
            case let flag as Bool where !flag:
                break
            default:
                throw NativeUpdateCheckError.invalidResponse("Artifact patch descriptors must be objects.")
            }
        }
    }

    // MARK: Release catalog cache

    private struct CachedCatalog {
        let catalog: ReleaseCatalog
        let etag: String
    }

    private static func isValidETag(_ value: String?) -> Bool {
        guard let value else { return false }
        return !value.isEmpty
            && !value.contains("\r")
            && !value.contains("\n")
            && getUtf8ByteLength(value) <= maxETagBytes
    }

    private static func catalogCachePartition(
        baseURL: String,
        url: String,
        headers: [String: String]
    ) -> String {
        let headerLines = normalizedHeaders(headers)
            .sorted { $0.key < $1.key }
            .map { "\($0.key):\($0.value)" }
        return (["native:\(baseURL)", url] + headerLines).joined(separator: "\n")
    }

    private func readValidatedCache(partition: String, expectedScope: ReleaseCatalogScope) -> CachedCatalog? {
        guard let value = host.releaseCatalogCache(partition) else {
            return nil
        }
        let parts = value.split(separator: "\n", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "1", Self.isValidETag(String(parts[1])),
              let catalog = parseReleaseCatalog(String(parts[2]), expectedScope: expectedScope) else {
            host.removeReleaseCatalogCache(partition)
            return nil
        }
        return CachedCatalog(catalog: catalog, etag: String(parts[1]))
    }

    private func fetchCatalogResponse(
        url: String,
        etag: String?,
        options: HotUpdaterCheckOptions,
        deadline: NativeUpdateDeadline?
    ) async throws -> NativeUpdateResponse {
        var headers = Self.normalizedHeaders(options.requestHeaders)
        headers["accept"] = "application/json"
        headers["if-none-match"] = etag
        return try await get(url, resource: "catalog", headers: headers, options: options, deadline: deadline)
    }

    /// The scope's catalog, or nil when the server answers that the scope has
    /// none (a 404 with `x-hot-updater-catalog: none`).
    private func fetchReleaseCatalog(
        baseURL: String,
        url: String,
        expectedScope: ReleaseCatalogScope,
        options: HotUpdaterCheckOptions,
        deadline: NativeUpdateDeadline?
    ) async throws -> ReleaseCatalog? {
        let partition = Self.catalogCachePartition(baseURL: baseURL, url: url, headers: options.requestHeaders)
        let cached = readValidatedCache(partition: partition, expectedScope: expectedScope)
        let response = try await fetchCatalogResponse(url: url, etag: cached?.etag, options: options, deadline: deadline)

        if response.status == 304 {
            if let cached {
                return cached.catalog
            }
            let repairResponse = try await fetchCatalogResponse(url: url, etag: nil, options: options, deadline: deadline)
            return try consumeCatalogResponse(repairResponse, expectedScope: expectedScope, partition: partition)
        }
        return try consumeCatalogResponse(response, expectedScope: expectedScope, partition: partition)
    }

    private func consumeCatalogResponse(
        _ response: NativeUpdateResponse,
        expectedScope: ReleaseCatalogScope,
        partition: String
    ) throws -> ReleaseCatalog? {
        // The server marks the 404 of a scope that has no catalog yet: no
        // update, not a failure. Any other 404 is a wrong baseURL or route.
        if response.status == 404,
           response.headers["x-hot-updater-catalog"]?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "none" {
            return nil
        }
        guard response.status == 200 else {
            throw NativeUpdateCheckError.http(status: response.status)
        }
        guard let catalog = parseReleaseCatalog(response.body, expectedScope: expectedScope) else {
            host.removeReleaseCatalogCache(partition)
            throw NativeUpdateCheckError.invalidResponse("Received an invalid Release catalog")
        }

        let etag = response.headers["etag"]
        if let etag, Self.isValidETag(etag) {
            let serialized = "1\n\(etag)\n\(response.body)"
            if getUtf8ByteLength(serialized) > Self.maxCatalogCacheEntryBytes {
                host.removeReleaseCatalogCache(partition)
            } else {
                _ = host.setReleaseCatalogCache(partition, value: serialized)
            }
        } else {
            host.removeReleaseCatalogCache(partition)
        }
        return catalog
    }

    // MARK: Events

    private struct ErrorScope {
        let channel: String
        let bundleId: String
        let updateStrategy: HotUpdaterUpdateStrategy
        let targetBundleId: String?
        let targetReleaseId: String?
    }

    private static let stages: Set<String> = ["check", "download", "install"]
    private static let reasons: Set<String> = [
        "network", "http", "invalid_response", "hash_mismatch", "signature",
        "patch", "extract", "storage", "unknown",
    ]
    private static let resources: Set<String> = ["catalog", "artifact", "manifest", "file", "patch", "archive"]
    private static let transports: Set<String> = ["timeout", "dns", "tls", "connection", "offline", "cancelled"]

    /// Where and why an update failed, or nil when the error is not an update
    /// failure, as JavaScript's `classifyUpdateError`.
    static func classifyUpdateError(_ error: Error, stage: String, resource: String?) -> [String: Any]? {
        if let rejection = error as? NativeUpdateRejection {
            let userInfo = rejection.userInfo
            // Native classifies every failure of its download and install; a
            // rejection without it, such as a stale selection, is not one.
            guard let stage = userInfo["stage"] as? String, stages.contains(stage),
                  let reason = userInfo["reason"] as? String, reasons.contains(reason) else {
                return nil
            }
            var classification: [String: Any] = ["stage": stage, "reason": reason]
            if let resource = userInfo["resource"] as? String, resources.contains(resource) {
                classification["resource"] = resource
            }
            if reason == "http", let status = userInfo["httpStatus"] as? NSNumber,
               status.doubleValue.rounded(.towardZero) == status.doubleValue {
                classification["httpStatus"] = status.intValue
            }
            if reason == "http", let originCode = userInfo["originCode"] as? String,
               originCode.range(of: "^[A-Za-z0-9._-]{1,64}$", options: .regularExpression) != nil {
                classification["originCode"] = originCode
            }
            if reason == "network", let transport = userInfo["transport"] as? String,
               transports.contains(transport) {
                classification["transport"] = transport
            }
            return classification
        }

        var classification: [String: Any] = ["stage": stage]
        if let resource {
            classification["resource"] = resource
        }
        switch error {
        case NativeUpdateCheckError.staleReleaseCatalog:
            // A selection that became stale is a race between checks.
            return nil
        case NativeUpdateCheckError.http(let status):
            classification["reason"] = "http"
            classification["httpStatus"] = status
        case NativeUpdateCheckError.invalidResponse:
            classification["reason"] = "invalid_response"
        case let error as URLError:
            classification["reason"] = "network"
            if let transport = UpdateFailureTransport(error.code) {
                classification["transport"] = transport.rawValue
            }
        default:
            classification["reason"] = "unknown"
        }
        return classification
    }

    /// `cohort` tags the event when it happened under another cohort than the
    /// running check's.
    private func reportUpdateError(
        _ error: Error,
        stage: String,
        resource: String?,
        scope: ErrorScope,
        cohort: String? = nil
    ) {
        // A caller that cancels its wait has not seen the update fail.
        if error is CancellationError { return }
        guard var payload = Self.classifyUpdateError(error, stage: stage, resource: resource) else {
            return
        }
        payload["channel"] = scope.channel
        payload["bundleId"] = scope.bundleId
        payload["releaseId"] = runningReleaseId(bundleId: scope.bundleId, channel: host.channel()) ?? NSNull()
        payload["updateStrategy"] = scope.updateStrategy.name
        if let targetBundleId = scope.targetBundleId {
            payload["targetBundleId"] = targetBundleId
        }
        if let targetReleaseId = scope.targetReleaseId {
            payload["targetReleaseId"] = targetReleaseId
        }
        payload["message"] = error.localizedDescription
        queueEvent("onUpdateError", payload, cohort: cohort)
    }

    private func queueEvent(_ name: String, _ payload: [String: Any], cohort: String? = nil) {
        NativeUpdateEvents.append(
            name: name,
            payload: payload,
            occurredAt: now(),
            build: NativeUpdateEvents.build(
                appVersion: host.appVersion,
                minBundleId: host.minBundleId,
                cohort: cohort ?? requestCohort ?? host.cohort()
            ),
            to: host
        )
    }
}
