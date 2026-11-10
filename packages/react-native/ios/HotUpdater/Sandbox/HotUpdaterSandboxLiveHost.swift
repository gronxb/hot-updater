#if HOT_UPDATER_SANDBOX_LAYER
import Foundation

/// The coordinator's view of the SDK: main's native state, and its server as the
/// app's JavaScript left it after an answered check. No new native API: the check
/// and the update are `HotUpdaterInstance`'s.
final class HotUpdaterSandboxLiveHost: HotUpdaterSandboxHost {
    /// What the previous process's crash left, read before anything can settle it.
    private static var crashMarkerAtStart: PendingCrashRecovery?

    /// Runs at `+load`, before the host's code: settling deletes the marker, and
    /// a launch that skips the screen settles it too.
    static func captureCrashMarker() {
        let documents = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true)[0]
        // Main's store, as `HotUpdaterCrashMarker` documents it.
        let url = URL(fileURLWithPath: documents)
            .appendingPathComponent("bundle-store")
            .appendingPathComponent(HotUpdaterCrashMarker.filename)
        guard let data = try? Data(contentsOf: url),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return
        }
        crashMarkerAtStart = PendingCrashRecovery.from(json: json)
    }

    private var impl: HotUpdaterImpl { HotUpdaterNativeUpdateBridge.sharedImpl }
    private let appIsRunning: () -> Bool

    init(isAppRunning: @escaping () -> Bool) {
        appIsRunning = isAppRunning
    }

    func isAppRunning() -> Bool {
        appIsRunning()
    }

    private func config() -> HotUpdaterRecoveryCheckConfig? {
        HotUpdaterRecoveryCheckConfig(json: impl.getStorageItem(HotUpdaterRecoveryCheckConfig.storageKey))
    }

    private func requireConfig() throws -> HotUpdaterRecoveryCheckConfig {
        guard let config = config() else {
            throw NativeUpdateCheckError.hotUpdater("No update server is known yet")
        }
        return config
    }

    private func instance(_ config: HotUpdaterRecoveryCheckConfig) throws -> HotUpdaterInstance {
        try HotUpdaterInstance(HotUpdaterOptions(
            baseURL: config.baseURL,
            requestHeaders: config.requestHeaders,
            requestTimeout: config.requestTimeout
        ))
    }

    func fingerprintHash() -> String? {
        impl.getFingerprintHash()
    }

    var isInSession: Bool {
        HotUpdaterSandboxDevState.running != nil
    }

    var storedSessionBundleId: String? {
        HotUpdaterSandboxDevState.storedBundleId
    }

    /// Set by the bridge, which owns the sessions and the screen.
    @MainActor var exitSessionAction: () -> Void = {}
    @MainActor var startStoredAction: (HotUpdaterSandboxStoredBundle) -> Void = { _ in }

    /// The coordinator, on the main actor, is the only caller of these three.
    func exitSessionForLink() {
        MainActor.assumeIsolated { exitSessionAction() }
    }

    func exitSession() {
        MainActor.assumeIsolated { exitSessionAction() }
    }

    func startStoredSession(_ bundle: HotUpdaterSandboxStoredBundle) {
        MainActor.assumeIsolated { startStoredAction(bundle) }
    }

    /// The Downloaded list's one shelf, in the caches directory. Only a sandbox with
    /// its own bundle ID stores bundles: one with the store app's ID leaves nothing
    /// behind in the store app's container.
    static let shelf: HotUpdaterSandboxShelf = {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return HotUpdaterSandboxShelf(
            root: caches.appendingPathComponent("hot-updater-sandbox/bundles", isDirectory: true),
            source: URL(fileURLWithPath: HotUpdaterInstanceEnvironment.main.bundleStorePath(documentsPath: FileManagerService().documentsPath())),
            isolationKey: HotUpdaterImpl.getIsolationKey(),
            storesBundles: Bundle.main.bundleIdentifier?.hasSuffix(".sandbox") == true
        )
    }()

    func hasServerConfig() -> Bool {
        config() != nil
    }

    func selection() async -> HotUpdaterSandboxSelection {
        let impl = impl
        return await Task.detached {
            let builtIn = HotUpdaterImpl.minBundleId()
            // Read first: before a launch, it settles what the previous process left.
            let launchBundleId = impl.bundleIdForUpdateCheck()
            let active = impl.getActiveUpdateState()["activeSelection"] as? [String: Any]
            let bundleId = hotUpdaterSandboxNextLaunchBundleId(
                runningBundleId: impl.runningBundleId(),
                launchBundleId: launchBundleId,
                activeBundleId: active?["bundleId"] as? String,
                builtInBundleId: builtIn
            )
            return HotUpdaterSandboxSelection(
                channel: impl.getChannel(),
                defaultChannel: impl.getDefaultChannel(),
                bundleId: bundleId,
                isBuiltIn: bundleId == builtIn
            )
        }.value
    }

    func launchBundleId() async -> String {
        // In a session this process runs no selected bundle: it isn't behind the selection.
        if isInSession {
            return await selection().bundleId
        }
        let impl = impl
        return await Task.detached {
            impl.bundleIdForUpdateCheck() ?? HotUpdaterImpl.minBundleId()
        }.value
    }

    func launchEvidence() -> HotUpdaterSandboxLaunchEvidence {
        let builtIn = HotUpdaterImpl.minBundleId()
        var evidence = HotUpdaterSandboxLaunchEvidence()
        if let marker = Self.crashMarkerAtStart {
            evidence.marker = HotUpdaterSandboxCrashMarker(
                bundleId: marker.launchedBundleId ?? builtIn,
                shouldRollback: marker.shouldRollback
            )
        }
        // The launch report is a read: JavaScript gets the same one after.
        let report = impl.notifyAppReady()
        if report["status"] as? String == "RECOVERED", let from = report["fromBundleId"] as? String {
            evidence.rollback = HotUpdaterSandboxRollback(
                fromBundleId: from,
                toBundleId: report["toBundleId"] as? String ?? builtIn
            )
            // A JavaScript crash can recover inside this process, whose marker came and
            // went after the start. Crash history then names the bundle, where a launch
            // that only ended leaves it waiting for its retry.
            if evidence.marker?.bundleId != from, historyRecordsCrash(of: from) {
                evidence.marker = HotUpdaterSandboxCrashMarker(bundleId: from, shouldRollback: true)
            }
        }
        return evidence
    }

    private func historyRecordsCrash(of bundleId: String) -> Bool {
        let documents = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true)[0]
        let url = URL(fileURLWithPath: documents)
            .appendingPathComponent("bundle-store")
            .appendingPathComponent(CrashedHistory.crashedHistoryFilename)
        let history = CrashedHistory.load(from: url)
        return history.contains(bundleId) && history.interruptedLaunch?.bundleId != bundleId
    }

    func details() -> HotUpdaterSandboxDetails {
        let builtIn = HotUpdaterImpl.minBundleId()
        let state = impl.getActiveUpdateState()
        let active = (state["activeSelection"] as? [String: Any])?["bundleId"] as? String ?? builtIn
        return HotUpdaterSandboxDetails(
            builtInBundleId: builtIn,
            fingerprintHash: impl.getFingerprintHash(),
            pendingBundleId: state["verificationPending"] as? Bool == true ? active : nil
        )
    }

    func preflight(channel: String) async throws -> Bool {
        let config = try requireConfig()
        let impl = impl
        let channelKey = try encodeChannelKey(channel)
        let baseURL = config.baseURL.hasSuffix("/") ? String(config.baseURL.dropLast()) : config.baseURL
        let scope: ReleaseCatalogScope
        let url: String
        switch config.updateStrategy {
        case .appVersion:
            guard let appVersion = HotUpdaterImpl.appVersion.flatMap(canonicalizeAppVersion) else {
                throw NativeUpdateCheckError.hotUpdater("Failed to canonicalize app version")
            }
            scope = ReleaseCatalogScope(platform: .ios, channelKey: channelKey, strategy: .appVersion, fingerprintHash: nil)
            url = "\(baseURL)/release-catalogs/app-version/ios/\(channelKey)/\(NativeUpdateChecker.encodeURIComponent(appVersion))"
        default:
            guard let fingerprintHash = impl.getFingerprintHash(), !fingerprintHash.isEmpty else {
                throw NativeUpdateCheckError.hotUpdater("Fingerprint hash is required")
            }
            scope = ReleaseCatalogScope(platform: .ios, channelKey: channelKey, strategy: .fingerprint, fingerprintHash: fingerprintHash)
            url = "\(baseURL)/release-catalogs/fingerprint/ios/\(channelKey)/\(NativeUpdateChecker.encodeURIComponent(fingerprintHash))"
        }
        guard let requestURL = URL(string: url) else {
            throw NativeUpdateCheckError.hotUpdater("Invalid baseURL: \(baseURL)")
        }
        var headers = NativeUpdateChecker.normalizedHeaders(config.requestHeaders)
        headers["accept"] = "application/json"
        let response = try await URLSessionUpdateTransport().get(requestURL, headers: headers, timeout: config.requestTimeout)
        if response.status == 404,
           response.headers["x-hot-updater-catalog"]?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "none" {
            return false
        }
        guard response.status == 200 else {
            throw NativeUpdateCheckError.http(status: response.status)
        }
        guard let catalog = parseReleaseCatalog(response.body, expectedScope: scope) else {
            throw NativeUpdateCheckError.invalidResponse("Received an invalid Release catalog")
        }
        let builtIn = HotUpdaterImpl.minBundleId()
        // What this device would select once it left its bundles behind.
        let desired = selectDesiredRelease(catalog, input: ReleaseSelectionInput(
            builtInBundleId: builtIn,
            currentBundleId: builtIn,
            activeReleaseId: nil,
            runningReleaseId: .some(nil),
            minimumReleaseId: builtIn,
            cohort: normalizeCohortValue(impl.getCohort()),
            crashedBundleIds: impl.getCrashHistory()
        ))
        return desired != nil && desired?.kind != .builtin
    }

    func reset() async throws -> Bool {
        try await instance(requireConfig()).resetChannel()
    }

    func checkAndStage(
        channel: String,
        onProgress: @escaping (Double) -> Void
    ) async throws -> HotUpdaterSandboxStaged {
        let config = try requireConfig()
        let check = HotUpdaterCheckOptions(updateStrategy: config.updateStrategy, channel: channel)
        guard let update = try await instance(config).checkForUpdate(check) else {
            return .noUpdate
        }
        guard try await update.updateBundle(onProgress: onProgress) else {
            return .superseded
        }
        return .update(bundleId: update.bundleId, message: update.message, releaseId: update.releaseId)
    }
}

/// The sandbox's own defaults: an app's data and the SDK's stores stay as they are.
final class HotUpdaterSandboxDefaults: HotUpdaterSandboxStore {
    private let defaults = UserDefaults(suiteName: "hot-updater-sandbox") ?? .standard

    var pendingLinks: [String] {
        get { defaults.stringArray(forKey: "pendingLinks") ?? [] }
        set { defaults.set(newValue, forKey: "pendingLinks") }
    }

    var lastLaunch: HotUpdaterSandboxLastLaunch? {
        get { read("lastLaunch") }
        set {
            if let newValue {
                write(newValue, "lastLaunch")
            } else {
                defaults.removeObject(forKey: "lastLaunch")
            }
        }
    }

    private func read<T: Decodable>(_ key: String) -> T? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }

    private func write<T: Encodable>(_ value: T, _ key: String) {
        defaults.set(try? JSONEncoder().encode(value), forKey: key)
    }
}
#endif
