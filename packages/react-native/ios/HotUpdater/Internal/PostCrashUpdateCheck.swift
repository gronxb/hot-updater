import Foundation

/// What main's JavaScript leaves in its key-value store for the native update
/// check after a crash: the server and request settings of its last update
/// check. Without a valid record there is no request at all, since only an
/// app whose JavaScript checked for updates has agreed to talk to a server.
struct HotUpdaterRecoveryCheckConfig {
    static let storageKey = "hot-updater/recovery-check-config"
    static let version = 1
    /// `NativeCheckRequest`'s default, for a record written without one.
    static let defaultRequestTimeoutMs: Double = 5000

    let baseURL: String
    let requestHeaders: [String: String]
    /// Seconds, as `NativeCheckRequest` takes it; JavaScript writes milliseconds.
    let requestTimeout: TimeInterval
    let updateStrategy: HotUpdaterUpdateStrategy

    /// Nil for a missing, unparsable, or wrong-version record, or one without
    /// an absolute HTTP(S) `baseURL`, a known `updateStrategy`, string
    /// headers, or a timeout of at least a millisecond. A record without
    /// headers or a timeout takes none and the default.
    init?(json value: String?) {
        guard let value,
              let data = value.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              Self.number(object["version"]) == Double(Self.version),
              let baseURL = object["baseURL"] as? String,
              (try? NativeUpdateChecker.validatedBaseURL(baseURL)) != nil else {
            return nil
        }
        switch object["updateStrategy"] as? String {
        case "appVersion":
            updateStrategy = .appVersion
        case "fingerprint":
            updateStrategy = .fingerprint
        default:
            return nil
        }
        switch object["requestHeaders"] {
        case nil:
            requestHeaders = [:]
        case let headers as [String: Any]:
            var strings: [String: String] = [:]
            for (name, value) in headers {
                guard let value = value as? String else { return nil }
                strings[name] = value
            }
            requestHeaders = strings
        default:
            return nil
        }
        let timeoutMs: Double
        switch object["requestTimeoutMs"] {
        case nil:
            timeoutMs = Self.defaultRequestTimeoutMs
        case let raw:
            guard let number = Self.number(raw), number.isFinite, number >= 1 else { return nil }
            timeoutMs = number
        }
        self.baseURL = baseURL
        requestTimeout = timeoutMs / 1000
    }

    /// The check of the current channel with these settings.
    var request: NativeCheckRequest {
        NativeCheckRequest(
            baseURL: baseURL,
            updateStrategy: updateStrategy,
            requestHeaders: requestHeaders,
            channel: nil,
            requestTimeout: requestTimeout
        )
    }

    /// A JSON number; a JSON boolean, which Foundation also reads as an
    /// NSNumber, is not one.
    private static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, String(cString: number.objCType) != "c" else {
            return nil
        }
        return number.doubleValue
    }
}

/// Main's native update check at the first launch with UI after a crash. A
/// bundle whose JavaScript update flow crashes after its first content is
/// never rolled back and could never fetch its own fix; this checks for one
/// natively, and stages what it finds for the next launch.
///
/// Consuming any crash marker leaves the check pending in the key-value
/// store. Once launch preparation finished, the check runs at most once per
/// process, when the app is shown and JavaScript left a valid config; the
/// flag is cleared once it finishes, whatever the outcome, so a process that
/// dies during the check, or a launch without UI, leaves it to the next one.
final class HotUpdaterPostCrashUpdateCheck: @unchecked Sendable {
    static let pendingKey = "hot-updater/recovery-check-pending"
    static let pendingValue = "1"

    /// How a check that ran ended, as its log line reports it.
    enum Outcome: Equatable {
        case staged(bundleId: String)
        case noUpdate
        /// The update was found, but another check or reset replaced its
        /// selection before it was staged.
        case superseded
    }

    private let storage: KeyValueStorageService
    private let queue: DispatchQueue
    private let whenShown: (@escaping () -> Void) -> Void
    private let check: (NativeCheckRequest) async throws -> Outcome
    private let log: (String) -> Void
    private let lock = NSLock()
    private var state = State.idle

    private enum State {
        case idle
        /// Pending, until the app is shown.
        case waiting
        /// A check is on its way: nothing starts another in this process.
        case started
    }

    /// - Parameters:
    ///   - storage: main's key-value store, the one JavaScript writes to.
    ///   - whenShown: runs its argument once the app is shown, now or later.
    ///   - check: checks with the request, and stages an update it finds.
    init(
        storage: KeyValueStorageService,
        queue: DispatchQueue = DispatchQueue.global(qos: .utility),
        whenShown: @escaping (@escaping () -> Void) -> Void,
        check: @escaping (NativeCheckRequest) async throws -> Outcome,
        log: @escaping (String) -> Void = { NSLog("[HotUpdaterRecovery] Post-crash update check: \($0)") }
    ) {
        self.storage = storage
        self.queue = queue
        self.whenShown = whenShown
        self.check = check
        self.log = log
    }

    var isPending: Bool {
        storage.getItem(Self.pendingKey) == Self.pendingValue
    }

    /// Consumes main's crash marker with `consume`. A marker that doesn't
    /// ask for rollback means the previous process crashed on a bundle this
    /// launch runs again, so the next launch with UI checks for a fix. One
    /// that asks for rollback is settled locally: the bundle that crashed
    /// before its first content is gone, and the one restored passed its own.
    func consumeMarker(_ consume: () -> PendingCrashRecovery?) -> PendingCrashRecovery? {
        let recovery = consume()
        if let recovery, !recovery.shouldRollback {
            storage.setItem(Self.pendingKey, value: Self.pendingValue)
        }
        return recovery
    }

    /// Call once launch preparation finished. Returns at once: the check runs
    /// on `queue`, after the app is shown, if it is pending, configured, and
    /// none ran in this process.
    func startIfNeeded() {
        queue.async { [self] in
            guard request() != nil, transition(from: .idle, to: .waiting) else { return }
            whenShown { [self] in
                queue.async { [self] in
                    // Read again: JavaScript may have refreshed the config
                    // while the app wasn't shown.
                    guard let request = request() else {
                        _ = transition(from: .waiting, to: .idle)
                        return
                    }
                    guard transition(from: .waiting, to: .started) else { return }
                    log("started")
                    Task { await run(request) }
                }
            }
        }
    }

    /// The request a pending check sends, or nil when none is pending, one
    /// already ran in this process, or JavaScript left no valid config.
    func request() -> NativeCheckRequest? {
        guard !started, isPending else { return nil }
        guard let config = HotUpdaterRecoveryCheckConfig(
            json: storage.getItem(HotUpdaterRecoveryCheckConfig.storageKey)
        ) else {
            log("skipped no config")
            return nil
        }
        return config.request
    }

    /// Runs the check, then clears the flag, whatever the outcome.
    func run(_ request: NativeCheckRequest) async {
        let status: String
        do {
            switch try await check(request) {
            case .staged(let bundleId):
                status = "staged \(bundleId)"
            case .noUpdate:
                status = "no update"
            case .superseded:
                status = "skipped superseded"
            }
        } catch {
            status = "failed \(error.localizedDescription)"
        }
        storage.setItem(Self.pendingKey, value: nil)
        log(status)
    }

    private var started: Bool {
        lock.lock()
        defer { lock.unlock() }
        return state == .started
    }

    private func transition(from current: State, to next: State) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard state == current else { return false }
        state = next
        return true
    }
}
