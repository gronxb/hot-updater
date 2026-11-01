import Foundation

/// The coordinator's view of the SDK: main's native state, and its server as the
/// app's JavaScript left it after an answered check. No new native API: the check
/// and the update are `HotUpdaterInstance`'s.
final class HotUpdaterSandboxLiveHost: HotUpdaterSandboxHost {
    private var impl: HotUpdaterImpl { HotUpdaterNativeUpdateBridge.sharedImpl }

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

    var isRunningDevServer: Bool {
        HotUpdaterSandboxDevState.running != nil
    }

    /// Set by the bridge, which owns the dev server and the screen.
    @MainActor var exitDevServerAction: () -> Void = {}

    /// The coordinator, on the main actor, is the only caller.
    func exitDevServerForLink() {
        MainActor.assumeIsolated { exitDevServerAction() }
    }

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
        let impl = impl
        return await Task.detached {
            impl.bundleIdForUpdateCheck() ?? HotUpdaterImpl.minBundleId()
        }.value
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
        return .update(bundleId: update.bundleId)
    }
}

/// The sandbox's own defaults: an app's data and the SDK's stores stay as they are.
final class HotUpdaterSandboxDefaults: HotUpdaterSandboxStore {
    private let defaults = UserDefaults(suiteName: "hot-updater-sandbox") ?? .standard

    var pendingLinks: [String] {
        get { defaults.stringArray(forKey: "pendingLinks") ?? [] }
        set { defaults.set(newValue, forKey: "pendingLinks") }
    }

    func recordSelected(_ selection: HotUpdaterSandboxSelection) {
        record("selected", selection)
    }

    func recordOpened(_ selection: HotUpdaterSandboxSelection) {
        record("opened", selection)
    }

    private func record(_ key: String, _ selection: HotUpdaterSandboxSelection) {
        defaults.set(["channel": selection.channel, "bundleId": selection.bundleId], forKey: key)
    }
}
