import Foundation
import React
import UIKit

private func hotUpdaterUncaughtExceptionHandler(_ exception: NSException) {
    HotUpdaterRecoveryHub.shared.handleUncaughtException(exception)
}

@_silgen_name("HotUpdaterInstallCrashSignalHandlers")
private func hotUpdaterInstallCrashSignalHandlers()

@_silgen_name("HotUpdaterUpdateCrashSlot")
private func hotUpdaterUpdateCrashSlotSymbol(
    _ slot: Int,
    _ crashMarkerPath: NSString,
    _ bundleId: NSString?,
    _ shouldRollback: ObjCBool
)

@_silgen_name("HotUpdaterAttributeCrashToSlot")
private func hotUpdaterAttributeCrashToSlot(_ slot: Int)

@_silgen_name("HotUpdaterCopyImplForRootObject")
private func hotUpdaterCopyImplForRootObjectSymbol(_ object: AnyObject) -> UnsafeMutableRawPointer?

@_silgen_name("HotUpdaterCopyRuntimeImpl")
private func hotUpdaterCopyRuntimeImplSymbol() -> UnsafeMutableRawPointer?

@_silgen_name("HotUpdaterCopyBundleURLForRootObject")
private func hotUpdaterCopyBundleURLForRootObjectSymbol(_ object: AnyObject) -> UnsafeMutableRawPointer?

@_silgen_name("HotUpdaterCopyRuntimeIdentityForRootObject")
private func hotUpdaterCopyRuntimeIdentityForRootObjectSymbol(_ object: AnyObject) -> UnsafeMutableRawPointer?

@_silgen_name("HotUpdaterCopyRuntimeIdentity")
private func hotUpdaterCopyRuntimeIdentitySymbol() -> UnsafeMutableRawPointer?

/// The object standing for the runtime `object` belongs to (its module
/// bridgeless, its bridge in the old architecture), when one told it apart.
private func hotUpdaterRuntimeIdentity(forRootObject object: AnyObject) -> AnyObject? {
    hotUpdaterCopyRuntimeIdentityForRootObjectSymbol(object).map {
        Unmanaged<AnyObject>.fromOpaque($0).takeRetainedValue()
    }
}

/// The object standing for the runtime whose JavaScript thread this is.
private func hotUpdaterRuntimeIdentity() -> AnyObject? {
    hotUpdaterCopyRuntimeIdentitySymbol().map {
        Unmanaged<AnyObject>.fromOpaque($0).takeRetainedValue()
    }
}

@_silgen_name("HotUpdaterCopyRuntimeBundleURL")
private func hotUpdaterCopyRuntimeBundleURLSymbol() -> UnsafeMutableRawPointer?

/// The bundle the runtime `object` belongs to runs.
private func hotUpdaterBundleURL(forRootObject object: AnyObject) -> URL? {
    hotUpdaterCopyBundleURLForRootObjectSymbol(object).flatMap {
        Unmanaged<AnyObject>.fromOpaque($0).takeRetainedValue() as? URL
    }
}

/// The bundle the runtime whose JavaScript thread this is runs.
private func hotUpdaterRuntimeBundleURL() -> URL? {
    hotUpdaterCopyRuntimeBundleURLSymbol().flatMap {
        Unmanaged<AnyObject>.fromOpaque($0).takeRetainedValue() as? URL
    }
}

@_silgen_name("HotUpdaterIsViewShown")
private func hotUpdaterIsViewShownSymbol(_ object: AnyObject) -> ObjCBool

/// Whether a started Fabric surface, or an old-architecture root view, is in
/// a window. Main thread only.
private func hotUpdaterIsViewShown(_ object: AnyObject) -> Bool {
    hotUpdaterIsViewShownSymbol(object).boolValue
}

@_silgen_name("HotUpdaterPerformRecoveryReload")
private func hotUpdaterPerformRecoveryReloadSymbol() -> ObjCBool

@_silgen_name("HotUpdaterMarkFailedRuntime")
private func hotUpdaterMarkFailedRuntime()

@_silgen_name("HotUpdaterIsFailedRuntime")
private func hotUpdaterIsFailedRuntime() -> ObjCBool

@_silgen_name("HotUpdaterInstallRecoveryHooks")
private func hotUpdaterInstallRecoveryHooks()

@_silgen_name("HotUpdaterAfterSurfaceStarts")
private func hotUpdaterAfterSurfaceStarts(_ action: @convention(block) @escaping () -> Void)

@_silgen_name("HotUpdaterCopyMinBundleId")
private func hotUpdaterCopyMinBundleIdSymbol() -> UnsafeMutableRawPointer

@_silgen_name("HotUpdaterCopyBuildFingerprintHash")
private func hotUpdaterCopyBuildFingerprintHashSymbol() -> UnsafeMutableRawPointer?

/// The fingerprint this build embedded: the hash of the native interface it
/// was built from, or nil for an app without one. Named apart from the
/// generated `hotUpdaterBuildFingerprintHash()`, which SwiftPM compiles into
/// this module.
private let embeddedFingerprintHash: String? = hotUpdaterCopyBuildFingerprintHashSymbol()
    .map { Unmanaged<NSString>.fromOpaque($0).takeRetainedValue() as String }

extension HotUpdaterInstanceEnvironment {
    /// Hands the shared config the fingerprint this build embedded, once,
    /// before anything resolves an instance's values.
    static let registerBuildFingerprintHash: Void = {
        HotUpdaterConfig.shared.buildFingerprintHash = embeddedFingerprintHash
    }()
}

/// The impl whose runtime `object` belongs to: a Fabric surface or root
/// view, an RCTInstance or RCTHost, an old-architecture root view or bridge.
/// Nil when no runtime claims it yet.
private func hotUpdaterImpl(forRootObject object: AnyObject) -> HotUpdaterImpl? {
    hotUpdaterCopyImplForRootObjectSymbol(object).flatMap {
        Unmanaged<AnyObject>.fromOpaque($0).takeRetainedValue() as? HotUpdaterImpl
    }
}

/// The impl of the React Native runtime whose JavaScript thread this is.
private func hotUpdaterRuntimeImpl() -> HotUpdaterImpl? {
    hotUpdaterCopyRuntimeImplSymbol().flatMap {
        Unmanaged<AnyObject>.fromOpaque($0).takeRetainedValue() as? HotUpdaterImpl
    }
}

private func hotUpdaterPerformRecoveryReload() -> Bool {
    return hotUpdaterPerformRecoveryReloadSymbol().boolValue
}

private func hotUpdaterGetMinBundleId() -> String {
    Unmanaged<NSString>
        .fromOpaque(hotUpdaterCopyMinBundleIdSymbol())
        .takeRetainedValue() as String
}

@objcMembers public class HotUpdaterImpl: NSObject {
    private let bundleStorage: BundleStorageService
    private let preferences: PreferencesService
    private let cohortService: CohortService
    /// Whose state this impl keeps; see `HotUpdaterInstanceEnvironment`.
    let environment: HotUpdaterInstanceEnvironment
    /// This instance's crash recovery: its marker, its launch's watch, and
    /// its rollback, apart from every other instance's.
    private let recoveryManager: HotUpdaterRecoveryManager
    private let releaseCatalogCache: ReleaseCatalogCacheService
    private let keyValueStorage: KeyValueStorageService
    private let updateLog: UpdateLogService
    /// Main only: the native update check of the first launch with UI after
    /// a crash. None in a development build.
    private let postCrashUpdateCheck: HotUpdaterPostCrashUpdateCheck?

    /// A development build, where a crash is a RedBox during development,
    /// never a reason to check for a fix: main records no crash after its
    /// watch and never checks after one.
    static let isDevelopmentBuild: Bool = {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }()
    // Read by native update checks on other threads while React Native sets it.
    private let launchSelectionLock = NSLock()
    private var launchSelectionValue: LaunchSelection?
    private var currentLaunchSelection: LaunchSelection? {
        get {
            launchSelectionLock.lock()
            defer { launchSelectionLock.unlock() }
            return launchSelectionValue
        }
        set {
            launchSelectionLock.lock()
            launchSelectionValue = newValue
            launchSelectionLock.unlock()
        }
    }
    // The selection React Native runs in this process. A channel reset clears
    // currentLaunchSelection, so React Native's next read picks the default
    // channel's bundle, but the running bundle stays until a reload.
    private var runningLaunchSelectionValue: LaunchSelection?
    private var runningLaunchSelection: LaunchSelection? {
        get {
            launchSelectionLock.lock()
            defer { launchSelectionLock.unlock() }
            return runningLaunchSelectionValue
        }
        set {
            launchSelectionLock.lock()
            runningLaunchSelectionValue = newValue
            launchSelectionLock.unlock()
        }
    }
    // Serializes the launch's bundle selection with the update check's read
    // of it, and with a channel reset or built-in commit, which delete
    // downloaded bundles.
    private let launchPreparationLock = LaunchPreparationLock()
    /// Advanced when this instance's own fatal marks its launch for
    /// rollback; a selection prepared at an older epoch is prepared again.
    private let launchEpoch = HotUpdaterLaunchEpoch()
    // Guarded by launchPreparationLock.
    private var currentLaunchSelectionEpoch = 0
    private var launchStartObservers: [NSObjectProtocol] = []
    // Main thread only: the launch the observers mark started, and the
    // newest launch whose mark ran.
    private var launchStartObserversGeneration: Int?
    private var launchStartGenerations = HotUpdaterLatestGeneration()

    private static let CHANNEL_STORAGE_KEY = "HotUpdaterChannel"

    private static func parseSafeByteSize(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber,
              String(cString: number.objCType) != "c" else {
            return nil
        }
        let doubleValue = number.doubleValue
        guard doubleValue.isFinite,
              doubleValue >= 0,
              doubleValue <= 9_007_199_254_740_991,
              doubleValue.rounded(.towardZero) == doubleValue else {
            return nil
        }
        return Int64(doubleValue)
    }

    // MARK: - Initialization

    /**
     * Convenience initializer that creates and configures all dependencies.
     */
    public convenience override init() {
        self.init(environment: .main)
    }

    /**
     * Creates the impl of one instance name, with its own storage, keys, and
     * config. Main's is `HotUpdaterNativeUpdateBridge.sharedImpl`.
     */
    convenience init(environment: HotUpdaterInstanceEnvironment) {
        _ = HotUpdaterInstanceEnvironment.registerBuildFingerprintHash
        // Main is built from one snapshot of its values, which a later main
        // instance must match; nothing below reads HotUpdaterConfig again.
        let environment = environment.isMain ? HotUpdaterMainBundle.shared.implEnvironment() : environment
        let fileSystem = FileManagerService()
        let isolationKey = environment.isolationKey(appVersion: Self.appVersion, minBundleId: Self.minBundleId())
        let preferences = VersionedPreferencesService()
        let downloadService = URLSessionDownloadService(
            backgroundSessionIdentifier: environment.backgroundSessionIdentifier
        )
        let bundleStorage = BundleFileStorageService(
            fileSystem: fileSystem,
            downloadService: downloadService,
            preferences: preferences,
            isolationKey: isolationKey,
            instance: environment,
            builtInBundleIdProvider: { HotUpdaterImpl.minBundleId() },
            updateLog: UpdateLogService.service(in: environment.updateLogDirectory(in: fileSystem))
        )

        self.init(
            bundleStorage: bundleStorage,
            preferences: preferences,
            environment: environment,
            recoveryManager: HotUpdaterRecoveryManager(environment: environment, bundleStorage: bundleStorage),
            releaseCatalogCache: ReleaseCatalogCacheService(
                rootDirectory: environment.releaseCatalogCacheDirectory(in: fileSystem)
            ),
            keyValueStorage: KeyValueStorageService(
                directory: environment.keyValueStorageDirectory(in: fileSystem)
            )
        )
    }

    /**
     * Primary initializer with dependency injection.
     * @param bundleStorage Service for bundle storage operations
     * @param preferences Service for preference storage
     * @param keyValueStorage Persistent key-value store for client plugins
     */
    internal init(
        bundleStorage: BundleStorageService,
        preferences: PreferencesService,
        environment: HotUpdaterInstanceEnvironment = .main,
        recoveryManager: HotUpdaterRecoveryManager,
        releaseCatalogCache: ReleaseCatalogCacheService = ReleaseCatalogCacheService(),
        keyValueStorage: KeyValueStorageService = KeyValueStorageService(
            directory: NoBackupStorage.directory(in: FileManagerService())
        )
    ) {
        self.bundleStorage = bundleStorage
        self.preferences = preferences
        self.cohortService = CohortService()
        self.environment = environment
        self.recoveryManager = recoveryManager
        self.releaseCatalogCache = releaseCatalogCache
        self.keyValueStorage = keyValueStorage
        self.updateLog = UpdateLogService.service(in: environment.updateLogDirectory(in: FileManagerService()))
        self.postCrashUpdateCheck = environment.isMain && !HotUpdaterImpl.isDevelopmentBuild
            ? HotUpdaterPostCrashUpdateCheck(
                storage: keyValueStorage,
                whenShown: HotUpdaterImpl.whenAppIsActive,
                check: HotUpdaterImpl.checkAfterCrash
            )
            : nil
        super.init()
        recoveryManager.onRollbackCharged = { [weak self] in
            self?.invalidateLaunchPreparation()
        }

        // Configure preferences with isolation key
        let isolationKey = environment.isolationKey(appVersion: Self.appVersion, minBundleId: Self.minBundleId())
        (preferences as? VersionedPreferencesService)?.configure(isolationKey: isolationKey)
    }
    
    // MARK: - Static Properties
    
    /**
     * Returns the app version from main bundle info.
     */
    public static var appVersion: String? {
        return HotUpdaterInstanceEnvironment.appVersion
    }

    /**
     * Returns main's default channel.
     */
    public static var appChannel: String {
        return HotUpdaterInstanceEnvironment.main.defaultChannel()
    }

    public static func minBundleId() -> String {
        hotUpdaterGetMinBundleId()
    }
    
    /**
     * Gets the complete isolation key for preferences storage.
     * @return The isolation key in format: hotupdater_{fingerprint}_{minBundleId}_{channel}_
     *   (fingerprint strategy) or hotupdater_{appVersion}_{channel}_
     */
    public static func getIsolationKey() -> String {
        // The deprecated programmatic override is used verbatim.
        _ = HotUpdaterInstanceEnvironment.registerBuildFingerprintHash
        return HotUpdaterInstanceEnvironment.main.isolationKey(appVersion: appVersion, minBundleId: minBundleId())
    }

    // MARK: - Channel Management
    
    /**
     * Gets the current update channel.
     * @return The channel name or nil if not set
     */
    public func getChannel() -> String {
        if let activeSelection = bundleStorage.getActiveUpdateState()["activeSelection"] as? [String: Any],
           let channel = activeSelection["channel"] as? String,
           !channel.isEmpty {
            return channel
        }
        // A runtime channel switch outranks the default channel, which
        // `HotUpdaterOptions.channel` (or the deprecated
        // `configure(channel:)`) only replaces, as on Android.
        if let savedChannel = try? preferences.getItem(forKey: Self.CHANNEL_STORAGE_KEY),
           !savedChannel.isEmpty {
            return savedChannel
        }

        return environment.defaultChannel()
    }

    public func getDefaultChannel() -> String {
        return environment.defaultChannel()
    }

    /**
     * Gets the current fingerprint hash.
     * @return The fingerprint hash or nil if not set
     */
    public func getFingerprintHash() -> String? {
        return environment.fingerprintHash()
    }

    // MARK: - Cohort Management

    public func setCohort(_ cohort: String) {
        cohortService.setCohort(cohort)
    }

    public func getCohort() -> String {
        return cohortService.getCohort()
    }

    // MARK: - Bundle URL Management
    
    /**
     * Gets the URL to the bundle file.
     * @param bundle instance to lookup the JavaScript bundle resource. Defaults to Bundle.main.
     *   Main records it in `HotUpdaterConfig.shared.bundle` for reloads and Info.plist keys;
     *   a named impl reads its own bundle and leaves main's alone.
     * @return URL to the bundle or nil
     */
    public func bundleURL(bundle: Bundle = Bundle.main) -> URL? {
        if environment.isMain {
            HotUpdaterMainBundle.shared.note(bundle)
        }
        let bundleURL = prepareLaunchIfNeeded(bundle: bundle).bundleURL
        // After the launch lock is released: the check reads the launch
        // through it, and never holds up React Native's start.
        if environment.isMain, self === HotUpdaterNativeUpdateBridge.sharedImpl {
            postCrashUpdateCheck?.startIfNeeded()
        }
        if !environment.isMain, let bundleURL {
            // The runtime started with this URL finds this impl by it.
            HotUpdaterNativeUpdateBridge.router.record(launchURL: bundleURL, name: environment.name)
        }
        return bundleURL
    }
    
    // MARK: - Bundle Update
    
    /**
     * Updates the bundle from JavaScript bridge.
     * This method acts as the primary error boundary for all bundle operations.
     * @param params Dictionary with bundleId, manifest, and asset parameters
     * @param resolve Promise resolve callback, called with the staged bundle's
     *   `{ delivery, patchFallback }`
     * @param reject Promise reject callback; download and install failures
     *   carry `stage`, `reason`, and their details in the error's userInfo
     */
    public func updateBundle(_ params: [AnyHashable: Any]?,
                                         resolver resolve: @escaping RCTPromiseResolveBlock,
                                         rejecter reject: @escaping RCTPromiseRejectBlock) {
        updateBundle(params, onProgress: nil, onFilesResponse: nil, resolver: resolve, rejecter: reject)
    }

    /**
     * `updateBundle`, also reporting progress (0 to 1) to `onProgress` on the
     * main thread, and each artifact files response to `onFilesResponse`.
     */
    func updateBundle(_ params: [AnyHashable: Any]?,
                      onProgress: ((Double) -> Void)?,
                      onFilesResponse: ((Int, String?) -> Void)?,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
        // Legacy: artifact protocol v1, where every file comes with its URL.
        // JavaScript from the first protocol v2 SDK also sends `filesUrl`
        // here, with only the Hermes patch in `assets`; its OTA Bundles must
        // still install.
        stage(params, onProgress: onProgress, resolver: resolve, rejecter: reject) { data, reject in
            switch Self.parseFileResolver(data, required: false, onResponse: onFilesResponse) {
            case .failure(let error):
                reject("INVALID_FILE_URL", error.localizedDescription, error)
                return nil
            case .success(let fileResolver):
                return Self.parseAssets(data, requireFileHash: fileResolver == nil, rejecter: reject)
                    .map { ($0, fileResolver) }
            }
        }
    }

    /**
     * Installs a Bundle over artifact protocol v2: native asks `filesUrl` for
     * the files it downloads one by one, after reusing local files and
     * choosing the archive.
     * @param params Dictionary with bundleId, manifest, `filesUrl`, and the
     *   optional Hermes `patch` with its `assetPath`
     * @param resolve Promise resolve callback, called with the staged bundle's
     *   `{ delivery, patchFallback }`
     * @param reject Promise reject callback, as for `updateBundle`
     */
    public func installArtifact(_ params: [AnyHashable: Any]?,
                                resolver resolve: @escaping RCTPromiseResolveBlock,
                                rejecter reject: @escaping RCTPromiseRejectBlock) {
        installArtifact(params, onProgress: nil, onFilesResponse: nil, resolver: resolve, rejecter: reject)
    }

    /**
     * `installArtifact`, also reporting progress (0 to 1) to `onProgress` on
     * the main thread, and each artifact files response to `onFilesResponse`.
     */
    func installArtifact(_ params: [AnyHashable: Any]?,
                         onProgress: ((Double) -> Void)?,
                         onFilesResponse: ((Int, String?) -> Void)?,
                         resolver resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
        stage(params, onProgress: onProgress, resolver: resolve, rejecter: reject) { data, reject in
            Self.parseArtifactInstall(data, onFilesResponse: onFilesResponse, rejecter: reject)
        }
    }

    private typealias StagePlan = (assets: [String: ChangedAssetDescriptor], fileResolver: ArtifactFileResolver?)

    /// Validates the common parameters, then stages the Bundle with the
    /// assets and file resolver `plan` returns; `plan` rejects and returns nil
    /// when its own parameters are invalid.
    private func stage(_ params: [AnyHashable: Any]?,
                       onProgress: ((Double) -> Void)?,
                       resolver resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock,
                       plan: ([AnyHashable: Any], RCTPromiseRejectBlock) -> StagePlan?) {
        do {
            // Validate parameters (this runs on calling thread - typically JS thread)
            guard let data = params else {
                let error = NSError(domain: "HotUpdater", code: 0,
                                   userInfo: [NSLocalizedDescriptionKey: "Missing or invalid parameters for updateBundle"])
                reject("UNKNOWN_ERROR", error.localizedDescription, error)
                return
            }

            // Invalid update parameters are an invalid update response.
            guard let bundleId = data["bundleId"] as? String, !bundleId.isEmpty else {
                let error = UpdateFailure.invalidResponse.error(description: "Missing or empty 'bundleId'")
                reject("MISSING_BUNDLE_ID", error.localizedDescription, error)
                return
            }

            guard let manifestFileHash = data["manifestFileHash"] as? String,
                  !manifestFileHash.isEmpty else {
                let error = UpdateFailure.invalidResponse.with(resource: .manifest)
                    .error(description: "Missing manifest file hash")
                reject("INVALID_MANIFEST", error.localizedDescription, error)
                return
            }
            let channel = data["channel"] as? String
            let manifestUrlString = data["manifestUrl"] as? String ?? ""
            guard let manifestUrl = URL(string: manifestUrlString) else {
                let error = UpdateFailure.invalidResponse.with(resource: .manifest).error(
                    description: "Invalid 'manifestUrl' provided: \(manifestUrlString)"
                )
                reject("INVALID_FILE_URL", error.localizedDescription, error)
                return
            }
            let archiveUrl: URL?
            if let archiveUrlString = data["archiveUrl"] as? String {
                guard let parsedArchiveUrl = URL(string: archiveUrlString) else {
                    let error = UpdateFailure.invalidResponse.with(resource: .archive).error(
                        description: "Invalid 'archiveUrl' provided: \(archiveUrlString)"
                    )
                    reject("INVALID_FILE_URL", error.localizedDescription, error)
                    return
                }
                archiveUrl = parsedArchiveUrl
            } else {
                archiveUrl = nil
            }
            guard let planned = plan(data, reject) else {
                return
            }
            let selection = (data["selection"] as? [String: Any]).flatMap(Self.parseSelection)
            if let selection, !bundleStorage.isSelectionCurrent(selection) {
                // Not an update failure, so the rejection carries no stage or reason.
                let error = StaleReleaseSelectionError() as NSError
                reject("UNKNOWN_ERROR", error.localizedDescription, error)
                return
            }

            // Extract progress callback if provided
            let progressCallback = data["progressCallback"] as? RCTResponseSenderBlock

            NSLog("[HotUpdaterImpl] updateBundle called with bundleId: \(bundleId), manifestUrl: \(manifestUrl.absoluteString)")

            // Heavy work is delegated to bundle storage service with safe error handling
            bundleStorage.updateBundle(bundleId: bundleId, manifestUrl: manifestUrl, manifestFileHash: manifestFileHash, archiveUrl: archiveUrl, assets: planned.assets, fileResolver: planned.fileResolver, selection: selection, progressHandler: { payload in
                DispatchQueue.main.async {
                    // The impl as the object: HotUpdater.mm forwards only
                    // main's progress to JavaScript.
                    NotificationCenter.default.post(
                        name: .updateProgressDidChange,
                        object: self,
                        userInfo: payload.userInfo
                    )

                    if let callback = progressCallback {
                        callback([payload.progress])
                    }
                    onProgress?(payload.progress)
                }
            }) { [weak self] result in
                guard let self = self else {
                    let error = NSError(domain: "HotUpdater", code: 0,
                                       userInfo: [NSLocalizedDescriptionKey: "Internal error: self deallocated during update"])
                    DispatchQueue.main.async {
                        reject("SELF_DEALLOCATED", error.localizedDescription, error)
                    }
                    return
                }
                self.logDownload(result, bundleId: bundleId, selection: selection, channel: channel)
                // Return results on main thread for React Native bridge
                DispatchQueue.main.async {
                    switch result {
                    case .success(let delivery):
                        NSLog("[HotUpdaterImpl] Update successful for \(bundleId). Resolving promise.")
                        if let channel, !channel.isEmpty {
                            do {
                                if channel == self.getDefaultChannel() {
                                    try self.preferences.setItem(nil, forKey: Self.CHANNEL_STORAGE_KEY)
                                } else {
                                    try self.preferences.setItem(channel, forKey: Self.CHANNEL_STORAGE_KEY)
                                }
                            } catch {
                                NSLog("[HotUpdaterImpl] Failed to persist channel override: \(error)")
                            }
                        }
                        // { delivery: "patch" | "manifest" | "archive", patchFallback }
                        resolve(delivery.dictionary)
                    case .failure(let error):
                        NSLog("[HotUpdaterImpl] Update failed for \(bundleId) - Error: \(error)")

                        let normalizedCode = HotUpdaterImpl.normalizeErrorCode(from: error)
                        // A classified failure adds stage, reason, and its details to userInfo.
                        let nsError = UpdateFailureError.rejectionError(for: error)
                        reject(normalizedCode, nsError.localizedDescription, nsError)
                    }
                }
            }
        } catch let error {
            // Main error boundary - catch and convert all errors to JS rejection
            let nsError = error as NSError
            NSLog("[HotUpdaterImpl] Error in updateBundleFromJS - Domain: \(nsError.domain), Code: \(nsError.code), Description: \(nsError.localizedDescription)")

            reject("UNKNOWN_ERROR", nsError.localizedDescription, nsError)
        }
    }

    private func logDownload(
        _ result: Result<UpdateDelivery, Error>,
        bundleId: String,
        selection: PersistedSelection?,
        channel: String?
    ) {
        let logChannel = channel.flatMap { $0.isEmpty ? nil : $0 } ?? selection?.channel ?? getChannel()
        var event = UpdateLogEvent(
            type: UpdateLogEvent.download,
            outcome: UpdateLogEvent.staged,
            bundleId: bundleId,
            fromBundleId: runningBundleId() ?? Self.minBundleId(),
            releaseId: selection?.releaseId,
            channel: logChannel
        )
        if case .failure(let error) = result {
            event = UpdateLogEvent(
                type: event.type,
                outcome: UpdateLogEvent.failed,
                bundleId: event.bundleId,
                fromBundleId: event.fromBundleId,
                releaseId: event.releaseId,
                channel: event.channel,
                error: UpdateLogEvent.errorFields(of: error, code: Self.normalizeErrorCode(from: error))
            )
        }
        updateLog.append(event)
    }

    /// Every changed file with its hash and URL or Hermes patch; without
    /// `requireFileHash`, also entries that hold only the Hermes patch.
    private static func parseAssets(_ data: [AnyHashable: Any],
                                    requireFileHash: Bool,
                                    rejecter reject: RCTPromiseRejectBlock) -> [String: ChangedAssetDescriptor]? {
        guard let assetsPayload = data["assets"] as? [String: [String: Any]] else {
            let error = UpdateFailure.invalidResponse.with(resource: .manifest)
                .error(description: "Missing manifest assets")
            reject("INVALID_MANIFEST", error.localizedDescription, error)
            return nil
        }
        return assetsPayload.reduce(into: [String: ChangedAssetDescriptor]()) { partialResult, entry in
            let fileHash = entry.value["fileHash"] as? String ?? ""
            guard !fileHash.isEmpty || !requireFileHash else {
                return
            }

            let patch = (entry.value["patch"] as? [String: Any]).flatMap(parsePatch)
            let filePayload = entry.value["file"] as? [String: Any]
            let fileUrl = (filePayload?["url"] as? String).flatMap { URL(string: $0) }
            let fileCompression = filePayload?["compression"] as? String
            guard fileUrl != nil || patch != nil,
                  !fileHash.isEmpty || fileUrl == nil else {
                return
            }

            partialResult[entry.key] = ChangedAssetDescriptor(
                fileUrl: fileUrl,
                fileHash: fileHash,
                fileCompression: fileCompression,
                patch: patch
            )
        }
    }

    /// The resolver that asks `filesUrl` for the files native downloads one
    /// by one, with the update check's headers and timeout; nil when
    /// `filesUrl` is missing and not `required`.
    private static func parseFileResolver(_ data: [AnyHashable: Any],
                                          required: Bool,
                                          onResponse: ((Int, String?) -> Void)?) -> Result<ArtifactFileResolver?, NSError> {
        let filesUrlString = data["filesUrl"] as? String ?? ""
        if filesUrlString.isEmpty && !required {
            return .success(nil)
        }
        guard !filesUrlString.isEmpty, let filesUrl = URL(string: filesUrlString) else {
            return .failure(UpdateFailure.invalidResponse.with(resource: .file).error(
                description: "Invalid 'filesUrl' provided: \(filesUrlString)"
            ))
        }
        // The update check's headers, which the artifact files request repeats.
        let headers = (data["requestHeaders"] as? [String: Any] ?? [:])
            .compactMapValues { $0 as? String }
        let timeout = (data["requestTimeout"] as? NSNumber).map { $0.doubleValue / 1000 }
            .flatMap { $0 > 0 ? $0 : nil } ?? HTTPArtifactFileResolver.defaultTimeout
        return .success(HTTPArtifactFileResolver(
            filesUrl: filesUrl,
            headers: headers,
            timeout: timeout,
            onResponse: onResponse
        ))
    }

    /// Artifact protocol v2: the Hermes patch as the only planned asset, and
    /// the resolver that asks `filesUrl` for the files native downloads one
    /// by one.
    private static func parseArtifactInstall(_ data: [AnyHashable: Any],
                                             onFilesResponse: ((Int, String?) -> Void)?,
                                             rejecter reject: RCTPromiseRejectBlock) -> StagePlan? {
        let fileResolver: ArtifactFileResolver?
        switch parseFileResolver(data, required: true, onResponse: onFilesResponse) {
        case .failure(let error):
            reject("INVALID_FILE_URL", error.localizedDescription, error)
            return nil
        case .success(let resolver):
            fileResolver = resolver
        }
        var assets: [String: ChangedAssetDescriptor] = [:]
        if let patchPayload = data["patch"] as? [String: Any],
           let assetPath = patchPayload["assetPath"] as? String,
           let patch = parsePatch(patchPayload) {
            assets[assetPath] = ChangedAssetDescriptor(
                fileUrl: nil,
                fileHash: "",
                fileCompression: nil,
                patch: patch
            )
        }
        return (assets, fileResolver)
    }

    private static func parsePatch(_ payload: [String: Any]) -> BsdiffPatchDescriptor? {
        guard let algorithm = payload["algorithm"] as? String,
              let baseBundleId = payload["baseBundleId"] as? String,
              let baseFileHash = payload["baseFileHash"] as? String,
              let patchFileHash = payload["patchFileHash"] as? String,
              let patchUrlString = payload["patchUrl"] as? String,
              let patchUrl = URL(string: patchUrlString)
        else {
            return nil
        }

        return BsdiffPatchDescriptor(
            algorithm: algorithm,
            baseBundleId: baseBundleId,
            baseFileHash: baseFileHash,
            patchFileHash: patchFileHash,
            patchUrl: patchUrl,
            byteSize: parseSafeByteSize(payload["byteSize"])
        )
    }

    private static func parseSelection(_ data: [String: Any]) -> PersistedSelection? {
        guard let kind = data["kind"] as? String,
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

    public func acceptReleaseCatalog(_ params: [AnyHashable: Any]?) -> Bool {
        guard let data = params as? [String: Any],
              let catalogId = data["catalogId"] as? String,
              let scopeKey = data["scopeKey"] as? String,
              let generation = data["generation"] as? NSNumber,
              let catalogHash = data["catalogHash"] as? String,
              let channel = data["channel"] as? String,
              let selectionContextHash = data["selectionContextHash"] as? String else {
            return false
        }
        return bundleStorage.acceptReleaseCatalog(
            catalogId: catalogId,
            scopeKey: scopeKey,
            generation: generation.int64Value,
            catalogHash: catalogHash,
            channel: channel,
            selectionContextHash: selectionContextHash
        )
    }

    public func getActiveUpdateState() -> [String: Any] {
        bundleStorage.getActiveUpdateState()
    }

    public func getReleaseCatalogCache(
        _ partition: String,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter _: @escaping RCTPromiseRejectBlock
    ) {
        DispatchQueue.global(qos: .utility).async {
            guard let value = self.releaseCatalogCache.get(partition: partition) else {
                resolve(NSNull())
                return
            }
            resolve(value)
        }
    }

    public func setReleaseCatalogCache(
        _ partition: String,
        payload: String,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter _: @escaping RCTPromiseRejectBlock
    ) {
        DispatchQueue.global(qos: .utility).async {
            resolve(self.releaseCatalogCache.set(partition: partition, value: payload))
        }
    }

    public func removeReleaseCatalogCache(
        _ partition: String,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter _: @escaping RCTPromiseRejectBlock
    ) {
        DispatchQueue.global(qos: .utility).async {
            resolve(self.releaseCatalogCache.remove(partition: partition))
        }
    }

    public func isReleaseSelectionCurrent(_ params: [AnyHashable: Any]?) -> Bool {
        guard let data = params as? [String: Any],
              let catalogId = data["catalogId"] as? String,
              let scopeKey = data["scopeKey"] as? String,
              let generation = data["generation"] as? NSNumber,
              let catalogHash = data["catalogHash"] as? String,
              let channel = data["channel"] as? String,
              let selectionContextHash = data["selectionContextHash"] as? String else {
            return false
        }
        return bundleStorage.isReleaseSelectionCurrent(
            catalogId: catalogId,
            scopeKey: scopeKey,
            generation: generation.int64Value,
            catalogHash: catalogHash,
            channel: channel,
            selectionContextHash: selectionContextHash
        )
    }

    public func commitReleaseSelection(
        _ params: [AnyHashable: Any]?,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard let data = params?["selection"] as? [String: Any],
              let selection = Self.parseSelection(data) else {
            let error = NSError(
                domain: "HotUpdater",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: "Invalid Release selection"]
            )
            reject("INVALID_SELECTION", error.localizedDescription, error)
            return
        }
        // A built-in commit deletes every downloaded bundle, so it runs under
        // the launch lock as a channel reset does.
        resolve(launchPreparationLock.commitReleaseSelection(selection, in: bundleStorage) {
            self.currentLaunchSelection = nil
        })
    }

    /**
     * Normalizes native errors to a small, predictable set of JS-facing error codes.
     * Rare or platform-specific codes are collapsed to UNKNOWN_ERROR to reduce surface area.
     */
    private static func normalizeErrorCode(from error: Error) -> String {
        // Classification wraps an error without changing its code.
        let error = UpdateFailureError.unwrap(error)
        let baseCode: String

        if let storageError = error as? BundleStorageError {
            // Collapse signature sub-errors into a single public code
            if case .signatureVerificationFailed = storageError {
                baseCode = "SIGNATURE_VERIFICATION_FAILED"
            } else {
                baseCode = storageError.errorCodeString
            }
        } else if error is SignatureVerificationError {
            baseCode = "SIGNATURE_VERIFICATION_FAILED"
        } else {
            baseCode = "UNKNOWN_ERROR"
        }

        return userFacingErrorCodes.contains(baseCode) ? baseCode : "UNKNOWN_ERROR"
    }

    // Error codes we intentionally expose to JS callers.
    private static let userFacingErrorCodes: Set<String> = [
        "MISSING_BUNDLE_ID",
        "INVALID_FILE_URL",
        "DIRECTORY_CREATION_FAILED",
        "DOWNLOAD_FAILED",
        "INCOMPLETE_DOWNLOAD",
        "INVALID_BUNDLE",
        "INSUFFICIENT_DISK_SPACE",
        "SIGNATURE_VERIFICATION_FAILED",
        "MOVE_OPERATION_FAILED",
        "BUNDLE_IN_CRASHED_HISTORY",
        "SELF_DEALLOCATED",
        "UNKNOWN_ERROR",
    ]

    // MARK: - Rollback Support

    public func notifyAppReady() -> [String: Any] {
        // A failed runtime can finish queued native calls while recovery starts.
        // Keep its readiness loop from consuming the new launch's report.
        if hotUpdaterIsFailedRuntime().boolValue {
            return ["status": "PENDING"]
        }
        return bundleStorage.notifyAppReady()
    }

    /**
     * Gets the crashed bundle history.
     * @return Array of crashed bundle IDs
     */
    public func getCrashHistory() -> [String] {
        return bundleStorage.getCrashHistory().bundles.map { $0.bundleId }
    }

    /**
     * Clears the crashed bundle history.
     * @return true if clearing was successful
     */
    public func clearCrashHistory() -> Bool {
        return bundleStorage.clearCrashHistory()
    }

    public func getInstallId() -> String {
        return bundleStorage.getInstallId()
    }

    // MARK: - Client Plugin Storage

    /**
     * Reads a value from the persistent key-value store for client plugins.
     * @return The stored value or nil when the key has none
     */
    public func getStorageItem(_ key: String) -> String? {
        return keyValueStorage.getItem(key)
    }

    /**
     * Writes a value to the persistent key-value store; nil removes the key.
     */
    public func setStorageItem(_ key: String, value: String?) {
        keyValueStorage.setItem(key, value: value)
    }

    /**
     * Gets the base URL for the current active bundle directory.
     * Returns the file:// URL to the bundle directory with trailing slash.
     * This is used for Expo DOM components to construct full asset paths.
     * @return Base URL string (e.g., "file:///var/.../bundle-store/abc123/") or nil
     */
    public func getBaseURL() -> String? {
        if let currentLaunchSelection {
            let baseURL = bundleStorage.getBaseURL(forBundleId: currentLaunchSelection.launchedBundleId)
            return baseURL.isEmpty ? nil : baseURL
        }

        return nil
    }

    /**
     * Gets the current active bundle ID from bundle storage.
     * Reads the required OTA manifest.json.
     * Built-in bundle fallback is handled in JS.
     */
    public func getBundleId() -> String? {
        if let currentLaunchSelection {
            return currentLaunchSelection.launchedBundleId
        }

        return nil
    }

    /// The bundle this process runs. A channel reset clears
    /// currentLaunchSelection for the next launch, but the running bundle
    /// stays until React Native reloads.
    func runningBundleId() -> String? {
        (currentLaunchSelection ?? runningLaunchSelection)?.launchedBundleId
    }

    /// The bundle this runtime runs and, when the next launch runs another,
    /// that bundle; no launch selection on either side is the built-in bundle.
    /// Under the launch lock, so a channel reset or a launch being selected
    /// never shows half done. Reads the state as it is: settling the previous
    /// launch here would consume what its launch reports.
    func runningBundles() -> (bundleId: String, pendingBundleId: String?) {
        launchPreparationLock.withLock {
            let minBundleId = Self.minBundleId()
            let running = runningBundleId() ?? minBundleId
            let next = bundleStorage.peekLaunchBundleId() ?? minBundleId
            return (running, next == running ? nil : next)
        }
    }

    /// `runningBundles` as JSON for JavaScript, off the JavaScript thread.
    @objc
    public func getUpdateStatus(
        _ resolver: @escaping RCTPromiseResolveBlock,
        rejecter _: @escaping RCTPromiseRejectBlock
    ) {
        DispatchQueue.global(qos: .utility).async {
            let bundles = self.runningBundles()
            let status: [String: Any] = [
                "bundleId": bundles.bundleId,
                "pendingBundleId": bundles.pendingBundleId ?? NSNull(),
            ]
            let data = (try? JSONSerialization.data(withJSONObject: status)) ?? Data()
            resolver(String(decoding: data, as: UTF8.self))
        }
    }

    /// The retained update log as a JSON array, oldest first.
    @objc
    public func getUpdateLogs(
        _ resolver: @escaping RCTPromiseResolveBlock,
        rejecter _: @escaping RCTPromiseRejectBlock
    ) {
        DispatchQueue.global(qos: .utility).async {
            resolver(self.updateLog.read())
        }
    }

    /// Deletes the update log.
    @objc
    public func clearUpdateLogs(
        _ resolver: @escaping RCTPromiseResolveBlock,
        rejecter _: @escaping RCTPromiseRejectBlock
    ) {
        DispatchQueue.global(qos: .utility).async {
            resolver(self.updateLog.clear())
        }
    }

    /// Appends a check or download JavaScript ran to the update log.
    @objc
    public func appendUpdateLog(_ entry: String) {
        updateLog.appendJson(entry)
    }

    /// Appends a check native code ran to the update log.
    func appendUpdateLog(_ event: UpdateLogEvent) {
        updateLog.append(event)
    }

    /// The retained update log, oldest first, for the native instance.
    func readUpdateLogEntries() -> [[String: Any]] {
        guard let data = updateLog.read().data(using: .utf8),
              let entries = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else {
            return []
        }
        return entries
    }

    /// Deletes the update log, for the native instance.
    func clearUpdateLogEntries() -> Bool {
        updateLog.clear()
    }

    /**
     * Gets the current manifest from bundle storage.
     */
    public func getManifest() -> ManifestAssets {
        if let currentLaunchSelection {
            return bundleStorage.getManifest(forBundleId: currentLaunchSelection.launchedBundleId)
        }

        return [:]
    }

    public func resetLaunchPreparation() {
        currentLaunchSelection = nil
        runningLaunchSelection = nil
    }

    /// This named instance's own fatal marked its launch for rollback, and
    /// the process may live on: the host's next `bundleURL()` prepares the
    /// launch again, consuming the marker, instead of returning the bundle
    /// that failed. The running bundle stays what React Native runs, as
    /// after a channel reset.
    ///
    /// Takes no lock: a crash can reach here on a thread that holds the
    /// launch lock. A preparation already running keeps the epoch it started
    /// with, so its selection is prepared again at the next `bundleURL()`.
    func invalidateLaunchPreparation() {
        launchEpoch.invalidate()
    }

    // MARK: - Native Update Check

    /**
     * The bundle the native update check counts as running: the launched one,
     * or before React Native starts, the one its launch would pick. Preparing
     * the launch here would keep a forced update staged before React Native
     * starts from applying in this session.
     */
    func bundleIdForUpdateCheck() -> String? {
        launchPreparationLock.withLock {
            if let launchSelection = currentLaunchSelection ?? runningLaunchSelection {
                return launchSelection.launchedBundleId
            }
            // Settles what the previous process left first, so the check reads the
            // selection, launch state, and crash history this launch will use.
            // Each instance consumes only its own crash marker.
            bundleStorage.settlePreviousLaunch(pendingRecovery: { self.consumePendingCrashRecovery() })
            return bundleStorage.peekLaunchBundleId()
        }
    }

    func releaseCatalogCacheValue(_ partition: String) -> String? {
        releaseCatalogCache.get(partition: partition)
    }

    func setReleaseCatalogCacheValue(_ partition: String, value: String) -> Bool {
        releaseCatalogCache.set(partition: partition, value: value)
    }

    func removeReleaseCatalogCacheValue(_ partition: String) {
        releaseCatalogCache.remove(partition: partition)
    }

    @objc
    public func resetChannel(_ resolver: @escaping RCTPromiseResolveBlock,
                             rejecter reject: @escaping RCTPromiseRejectBlock) {
        // Under the launch lock, so React Native never selects a bundle the
        // reset is about to delete.
        let result = launchPreparationLock.resetChannel(in: bundleStorage) {
            do {
                try preferences.setItem(nil, forKey: Self.CHANNEL_STORAGE_KEY)
            } catch {
                NSLog("[HotUpdaterImpl] Failed to clear channel override: \(error)")
            }
            self.currentLaunchSelection = nil
        }

        switch result {
        case .success(let success):
            resolver(success)
        case .failure(let error):
            let normalizedCode = HotUpdaterImpl.normalizeErrorCode(from: error)
            let nsError = error as NSError
            reject(normalizedCode, nsError.localizedDescription, nsError)
        }
    }

    /// Resets the channel while the Release selection `params` names is
    /// current, as `resetChannel` does; resolves false for a stale one.
    @objc
    public func resetChannelIfSelectionCurrent(
        _ params: [AnyHashable: Any]?,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard let guardParams = ReleaseSelectionGuardParams(params) else {
            resolver(false)
            return
        }
        let result = launchPreparationLock.resetChannelIfSelectionCurrent(guardParams, in: bundleStorage) {
            do {
                try preferences.setItem(nil, forKey: Self.CHANNEL_STORAGE_KEY)
            } catch {
                NSLog("[HotUpdaterImpl] Failed to clear channel override: \(error)")
            }
            self.currentLaunchSelection = nil
        }

        switch result {
        case .success(let success):
            resolver(success)
        case .failure(let error):
            let normalizedCode = HotUpdaterImpl.normalizeErrorCode(from: error)
            let nsError = error as NSError
            reject(normalizedCode, nsError.localizedDescription, nsError)
        }
    }

    private func prepareLaunchIfNeeded(bundle: Bundle) -> LaunchSelection {
        launchPreparationLock.withLock { prepareLaunchLocked(bundle: bundle) }
    }

    private func prepareLaunchLocked(bundle: Bundle) -> LaunchSelection {
        if let currentLaunchSelection, launchEpoch.isCurrent(currentLaunchSelectionEpoch) {
            return currentLaunchSelection
        }

        // The epoch is read before the marker is consumed, and checked again
        // once this launch's monitoring replaced the running one's, after
        // which that launch can no longer mark a rollback: a rollback marked
        // meanwhile prepares again, consuming it. Monitoring is registered
        // before the foreground mark, so another instance's fatal that stops
        // every started launch also sees this one; starting it again on a
        // retry replaces it.
        let (selection, generation, epoch) = launchEpoch.prepareCurrent(
            prepare: {
                let pendingRecovery = consumePendingCrashRecovery()
                return bundleStorage.prepareLaunch(bundle: bundle, pendingRecovery: pendingRecovery)
            },
            startMonitoring: { selection in
                // The same bundle again (a named instance): its launch goes on.
                if !environment.isMain, let generation = recoveryManager.continuingLaunch(
                    bundleId: selection.launchedBundleId,
                    launchURL: selection.bundleURL
                ) {
                    return generation
                }
                return recoveryManager.startMonitoring(
                    bundleId: selection.launchedBundleId,
                    shouldRollback: selection.shouldRollbackOnCrash,
                    launchURL: selection.bundleURL
                )
            }
        )
        // A named runtime may be warmed up without UI, so its launch starts
        // only once one of its views is shown (HotUpdaterRecoveryHub), and
        // only its own first content verifies it.
        if environment.isMain {
            markLaunchStartedInForeground(selection, generation: generation)
        }
        runningLaunchSelection = selection
        currentLaunchSelection = selection
        currentLaunchSelectionEpoch = epoch
        return selection
    }

    /// Keeps a native check's request the server answered for main's check
    /// after a crash, as JavaScript's checks do; an app that checks only
    /// natively has no other. Nothing for a named instance or in a
    /// development build, which have no such check.
    func recordRecoveryRequest(_ request: NativeCheckRequest) {
        guard postCrashUpdateCheck != nil, let json = HotUpdaterRecoveryCheckConfig.json(for: request) else { return }
        keyValueStorage.setItem(HotUpdaterRecoveryCheckConfig.storageKey, value: json)
    }

    /// This instance's crash marker; for main outside a development build,
    /// a marker that doesn't roll back also leaves the post-crash update
    /// check pending.
    private func consumePendingCrashRecovery() -> PendingCrashRecovery? {
        let recovery: PendingCrashRecovery?
        if let postCrashUpdateCheck {
            recovery = postCrashUpdateCheck.consumeMarker { recoveryManager.consumePendingCrashRecovery() }
        } else {
            recovery = recoveryManager.consumePendingCrashRecovery()
        }
        // A rollback is recorded by the storage that makes it.
        if let recovery, !recovery.shouldRollback {
            updateLog.append(UpdateLogEvent(
                type: UpdateLogEvent.crashRecovery,
                outcome: UpdateLogEvent.keptAfterCrash,
                bundleId: recovery.launchedBundleId ?? Self.minBundleId(),
                channel: getChannel()
            ))
        }
        return recovery
    }

    /// Runs `action` once the app is active: a launch without UI, such as a
    /// silent push, leaves the post-crash check to a later foreground.
    private static func whenAppIsActive(_ action: @escaping () -> Void) {
        DispatchQueue.main.async {
            if UIApplication.shared.applicationState == .active {
                action()
                return
            }
            NSLog("[HotUpdaterRecovery] Post-crash update check: skipped until the app becomes active")
            // Boxed: the observer block may not capture a mutable variable.
            let registration = HotUpdaterObserverRegistration()
            registration.token = NotificationCenter.default.addObserver(
                forName: UIApplication.didBecomeActiveNotification,
                object: nil,
                queue: .main
            ) { _ in
                guard let token = registration.token else { return }
                NotificationCenter.default.removeObserver(token)
                registration.token = nil
                action()
            }
        }
    }

    /// Main's native check of the current channel, which stages an update it
    /// finds for the next launch; no reload.
    private static func checkAfterCrash(
        _ request: NativeCheckRequest
    ) async throws -> HotUpdaterPostCrashUpdateCheck.Outcome {
        let checker = HotUpdaterNativeUpdateBridge.checker(impl: HotUpdaterNativeUpdateBridge.sharedImpl)
        guard let update = try await checker.checkForUpdate(request) else {
            return .noUpdate
        }
        return try await update.updateBundle() ? .staged(bundleId: update.bundleId) : .superseded
    }

    // A background launch, such as a silent push, may never render. Only a
    // launch in the foreground may leave an unfinished launch for the next
    // process to roll back.
    // Through crash recovery, which refuses a later launch's, one whose
    // content appeared, and holds it while another instance's fatal is on
    // its way.
    private func markLaunchStartedInForeground(_ selection: LaunchSelection, generation: Int) {
        let bundleId = selection.shouldRollbackOnCrash ? selection.launchedBundleId : nil
        let mark = { [weak self] in
            guard let self else { return }
            // Queued for an older launch, behind a newer launch's mark: the
            // newer launch's observers stay.
            guard self.launchStartGenerations.admit(generation) else { return }
            self.removeLaunchStartObservers(before: generation + 1)
            guard bundleId != nil else { return }
            guard UIApplication.shared.applicationState == .background else {
                self.recoveryManager.markMainLaunchStarted(generation: generation)
                return
            }
            self.launchStartObserversGeneration = generation
            self.launchStartObservers = [
                UIApplication.willEnterForegroundNotification,
                UIApplication.didBecomeActiveNotification,
            ].map { name in
                NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    self?.removeLaunchStartObservers(before: generation + 1)
                    self?.recoveryManager.markMainLaunchStarted(generation: generation)
                }
            }
        }
        // UIApplication is read on the main thread.
        if Thread.isMainThread {
            mark()
        } else {
            DispatchQueue.main.async(execute: mark)
        }
    }

    /// Removes the observers if a launch before `generation` installed
    /// them. Main thread only.
    private func removeLaunchStartObservers(before generation: Int) {
        guard let installed = launchStartObserversGeneration, installed < generation else { return }
        launchStartObservers.forEach { NotificationCenter.default.removeObserver($0) }
        launchStartObservers = []
        launchStartObserversGeneration = nil
    }
}

/// A one-shot notification observer's token, which its own block removes.
/// Main thread only.
private final class HotUpdaterObserverRegistration {
    var token: NSObjectProtocol?
}

/// One instance's crash recovery: consumes its marker at launch, watches its
/// launch until 10 seconds after its first content, and for main, reloads
/// in-process when its JavaScript fails before first content. The state lives
/// in `HotUpdaterRecoveryHub.shared.coordinator`; the process-wide handlers in
/// the hub dispatch to the instance a crash or content belongs to.
@objcMembers
final class HotUpdaterRecoveryManager: NSObject {
    let name: String
    private let crashMarkerURL: URL
    private let hub: HotUpdaterRecoveryHub
    /// Set by the impl: invalidates its launch preparation.
    var onRollbackCharged: (() -> Void)?
    private var stopMonitoringWorkItem: DispatchWorkItem?
    // Main thread only: a named launch whose view started in the background
    // starts once the app comes to the foreground.
    private var armObservers: [NSObjectProtocol] = []
    // The launch the observers start.
    private var armGeneration: Int?
    private let backgroundViewStarts = HotUpdaterBackgroundViewStarts()

    init(environment: HotUpdaterInstanceEnvironment, bundleStorage: BundleStorageService) {
        name = environment.name
        if environment.isMain {
            // Main's path as it always was: Documents/bundle-store.
            let documentsPath = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
            crashMarkerURL = HotUpdaterCrashMarker.url(for: environment, documentsPath: documentsPath.path)
        } else {
            crashMarkerURL = HotUpdaterCrashMarker.url(
                for: environment,
                documentsPath: FileManagerService().documentsPath()
            )
        }
        hub = .shared
        super.init()
        hub.coordinator.register(name: name, markerURL: crashMarkerURL, storage: bundleStorage)
        hub.register(self)
    }

    private var isMain: Bool { name == HotUpdaterInstanceEnvironment.mainName }

    func consumePendingCrashRecovery() -> PendingCrashRecovery? {
        HotUpdaterCrashMarker.consume(at: crashMarkerURL)
    }

    @discardableResult
    func startMonitoring(bundleId: String?, shouldRollback: Bool, launchURL: URL?) -> Int {
        objc_sync_enter(self)
        defer { objc_sync_exit(self) }

        // Under this manager's lock, as are the content and grace callbacks
        // that check the generation, so none acts on a launch it wasn't for.
        let generation = hub.coordinator.startMonitoring(
            name: name,
            bundleId: bundleId,
            shouldRollback: shouldRollback,
            launchURL: launchURL
        )
        stopMonitoringWorkItem?.cancel()
        stopMonitoringWorkItem = nil
        if !isMain {
            DispatchQueue.main.async { [weak self] in self?.removeArmObservers(before: generation) }
        }

        hub.installIfNeeded()
        return generation
    }

    /// The generation of the launch a preparation of the same bundle
    /// continues, if any.
    func continuingLaunch(bundleId: String?, launchURL: URL?) -> Int? {
        hub.coordinator.continuingLaunch(name: name, bundleId: bundleId, launchURL: launchURL)
    }

    /// Main only: its launch of `generation` is in the foreground.
    func markMainLaunchStarted(generation: Int) {
        hub.coordinator.markMainLaunchStarted(generation: generation)
    }

    /// This instance's first content: its monitoring ends after a grace period.
    func contentAppeared(generation: Int) {
        objc_sync_enter(self)
        defer { objc_sync_exit(self) }
        // A launch started since then has its own grace period.
        guard hub.coordinator.isCurrent(name: name, generation: generation) else { return }

        stopMonitoringWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.finishMonitoring(generation: generation)
        }
        stopMonitoringWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(10), execute: workItem)
        if !isMain {
            DispatchQueue.main.async { [weak self] in self?.removeArmObservers(before: generation + 1) }
        }
    }

    private func finishMonitoring(generation: Int) {
        objc_sync_enter(self)
        defer { objc_sync_exit(self) }
        guard hub.coordinator.isCurrent(name: name, generation: generation) else { return }

        stopMonitoringWorkItem = nil
        hub.coordinator.finishMonitoring(name: name, generation: generation)
    }

    /// A view of this named instance's runtime started. Only a launch in the
    /// foreground may leave an unfinished launch for the next process to roll
    /// back, as for main. `generation` is the launch the view started in.
    /// Main thread only.
    func viewStarted(_ view: AnyObject, inForeground: Bool, generation: Int, runtimeBundleURL: URL?) {
        guard !isMain else { return }
        // A view of a runtime of an earlier launch, such as one torn down
        // while its host is recreated, starts nothing.
        guard hub.coordinator.isCurrentRuntime(name: name, runtimeBundleURL: runtimeBundleURL) else { return }
        switch HotUpdaterBackgroundViewStarts.viewStart(inForeground: inForeground, isShown: { hotUpdaterIsViewShown(view) }) {
        case .arm:
            removeArmObservers(before: generation + 1)
            hub.coordinator.arm(name: name, generation: generation, runtimeBundleURL: runtimeBundleURL)
            return
        case .waitForAttachment:
            // Started for pre-rendering: its attachment to a window is
            // reported as another start.
            return
        case .waitForForeground:
            break
        }
        // Views of an earlier launch never start this one, nor remove what
        // a later launch installed.
        if let armGeneration {
            if generation < armGeneration {
                return
            }
            removeArmObservers(before: generation)
        }
        // Only if the view is still shown when the app comes back.
        backgroundViewStarts.add(view)
        guard armObservers.isEmpty else { return }
        armGeneration = generation
        armObservers = [
            UIApplication.willEnterForegroundNotification,
            UIApplication.didBecomeActiveNotification,
        ].map { notificationName in
            NotificationCenter.default.addObserver(forName: notificationName, object: nil, queue: .main) { [weak self] _ in
                guard let self else { return }
                // willEnterForeground may come before the view is in its
                // window; didBecomeActive decides.
                let final = notificationName == UIApplication.didBecomeActiveNotification
                let isShown = self.backgroundViewStarts.takeAnyShown({ hotUpdaterIsViewShown($0) }, final: final)
                guard isShown || final else { return }
                self.removeArmObservers(before: generation + 1)
                if isShown {
                    self.hub.coordinator.arm(name: self.name, generation: generation, runtimeBundleURL: runtimeBundleURL)
                }
            }
        }
    }

    /// Drops the foreground observers if they were for a launch before
    /// `generation`. Main thread only.
    private func removeArmObservers(before generation: Int) {
        guard let armGeneration, armGeneration < generation else { return }
        armObservers.forEach { NotificationCenter.default.removeObserver($0) }
        armObservers = []
        self.armGeneration = nil
        backgroundViewStarts.removeAll()
    }

    /// Main only: its fatal before first content reloads it in-process with
    /// the bundle its marker rolls back to.
    func requestRecoveryReloadIfNeeded(onFailure: @escaping () -> Void) -> Bool {
        guard isMain else { return false }
        let request = hub.coordinator.requestRecovery(name: name)
        if request == .notNeeded {
            return false
        }

        hotUpdaterMarkFailedRuntime()
        guard case .requested(let generation, let bundleId) = request else {
            return true
        }

        hotUpdaterAfterSurfaceStarts { [weak self] in
            guard let self else {
                return
            }

            guard self.hub.coordinator.isCurrent(name: self.name, generation: generation) else { return }

            let started = hotUpdaterPerformRecoveryReload()
            if !started {
                self.hub.coordinator.recoveryReloadFailed(name: self.name, generation: generation)
                NSLog("[HotUpdaterRecovery] Failed to trigger recovery reload")
                onFailure()
            } else {
                NSLog("[HotUpdaterRecovery] Triggered recovery reload for bundleId=\(bundleId ?? "nil")")
            }
        }

        return true
    }
}

/// HotUpdater.mm's signal-safe crash slots.
private final class HotUpdaterSignalCrashSlots: HotUpdaterCrashSlotSink {
    func updateSlot(_ slot: Int, markerPath: String, bundleId: String?, shouldRollback: Bool) {
        hotUpdaterUpdateCrashSlotSymbol(slot, markerPath as NSString, bundleId as NSString?, ObjCBool(shouldRollback))
    }

    func attributeCrash(toSlot slot: Int) {
        hotUpdaterAttributeCrashToSlot(slot)
    }
}

/// The process-wide side of crash recovery. React Native's fatal handlers,
/// the uncaught exception handler, the signal handler, and the content and
/// load-failure observers exist once per process; each event goes to the
/// instance whose runtime it comes from, found through the runtime's
/// TurboModule (see HotUpdater.mm). An event no runtime claims is main's, as
/// it always was, except that a crash then also counts against every named
/// launch that is unverified.
@objcMembers
final class HotUpdaterRecoveryHub: NSObject {
    static let shared = HotUpdaterRecoveryHub()

    let coordinator = HotUpdaterRecoveryCoordinator(
        sink: HotUpdaterSignalCrashSlots(),
        recordsCrashesAfterWatch: !HotUpdaterImpl.isDevelopmentBuild
    )
    /// The launch each runtime runs, by its module.
    private let runtimeLaunches = HotUpdaterRuntimeLaunches()
    /// Content that appeared in the background, until the foreground.
    private let backgroundContent = HotUpdaterBackgroundContent()
    private var backgroundContentObservers: [NSObjectProtocol] = []

    override init() {
        super.init()
        coordinator.onRollbackCharged = { [weak self] name in
            self?.manager(named: name)?.onRollbackCharged?()
        }
        // Off the main queue, which a blocked fatal handler may hold.
        coordinator.onClaimStarted = { [weak self] in
            DispatchQueue.global(qos: .utility).asyncAfter(
                deadline: .now() + HotUpdaterRecoveryCoordinator.claimFailSafe + 0.1
            ) {
                self?.coordinator.releaseStaleClaims()
            }
        }
    }
    private let pendingSurfaceStarts = HotUpdaterPendingSurfaceStarts()
    private let managersLock = NSLock()
    private var managers: [String: HotUpdaterRecoveryManager] = [:]

    private var previousFatalHandler: RCTFatalHandler?
    private var previousFatalExceptionHandler: RCTFatalExceptionHandler?
    private var previousUncaughtExceptionHandler: (@convention(c) (NSException) -> Void)?
    private var isInstalled = false

    private static let surfaceWillStartNotification = Notification.Name("HotUpdaterSurfaceWillStart")
    private static let runtimeDidResolveNotification = Notification.Name("HotUpdaterRuntimeDidResolve")
    /// The bridgeless runtime's JavaScript thread, where RCTFatal reports its
    /// JavaScript fatals.
    private static let runtimeThreadName = "com.facebook.react.runtime.JavaScript"

    func register(_ manager: HotUpdaterRecoveryManager) {
        managersLock.lock()
        managers[manager.name] = manager
        managersLock.unlock()
    }

    private func manager(named name: String) -> HotUpdaterRecoveryManager? {
        managersLock.lock()
        defer { managersLock.unlock() }
        return managers[name]
    }

    private var mainName: String { HotUpdaterInstanceEnvironment.mainName }

    /// Once per process, at the first launch of any instance: a process that
    /// runs only named instances never launches main.
    func installIfNeeded() {
        objc_sync_enter(self)
        defer { objc_sync_exit(self) }
        guard !isInstalled else {
            return
        }
        isInstalled = true

        installFatalHandlers()
        hotUpdaterInstallRecoveryHooks()
        registerObservers()
        hotUpdaterInstallCrashSignalHandlers()
    }

    func handleUncaughtException(_ exception: NSException) {
        coordinator.chargeUncaughtException()
        // An uncaught native exception cannot safely continue in this process.
        // Preserve the marker so the next launch can select the safe bundle.
        previousUncaughtExceptionHandler?(exception)
    }

    // MARK: - Attribution

    private func owner(of object: AnyObject?) -> String? {
        guard let object else { return nil }
        return hotUpdaterImpl(forRootObject: object)?.environment.name
    }

    /// The instance whose JavaScript thread is failing; a fatal right after a
    /// load failure already attributed belongs to the same instance. Else
    /// the instance whose bundle every frame of its JavaScript stack is in.
    /// Else, on a JavaScript thread whose runtime has no module yet, the one
    /// launch that can have thrown it, if there is exactly one.
    /// With the owner, the bundle its failing runtime runs when known, which
    /// tells a runtime of an earlier launch from the current one.
    private func fatalOwner(stack: Any?) -> (
        name: String,
        runtimeBundleURL: URL?,
        attribution: HotUpdaterRecoveryCoordinator.FatalAttribution
    )? {
        let module = hotUpdaterRuntimeImpl().map { ($0.environment.name, hotUpdaterRuntimeBundleURL()) }
        let stackOwner = HotUpdaterJSStackOwner.owner(of: stack, resolve: {
            HotUpdaterNativeUpdateBridge.impl(forBundleURL: $0).environment.name
        }).map { ($0, HotUpdaterJSStackOwner.bundleURLs(in: stack).first) }
        return HotUpdaterRecoveryCoordinator.fatalOwner(
            module: module,
            stack: stackOwner,
            claim: coordinator.attributedOwner,
            inference: {
                guard Thread.current.name == Self.runtimeThreadName else { return nil }
                return self.coordinator.inferredFatalOwner()
            }
        )
    }

    // MARK: - Fatal errors

    private func installFatalHandlers() {
        previousFatalHandler = RCTGetFatalHandler()
        previousFatalExceptionHandler = RCTGetFatalExceptionHandler()
        previousUncaughtExceptionHandler = NSGetUncaughtExceptionHandler()

        RCTSetFatalHandler { [weak self] error in
            guard !hotUpdaterIsFailedRuntime().boolValue else { return }
            let stack = (error as NSError?)?.userInfo[RCTJSStackTraceKey]
            self?.handleFatal(stack: stack) { self?.forwardFatalError(error) }
        }

        RCTSetFatalExceptionHandler { [weak self] exception in
            guard !hotUpdaterIsFailedRuntime().boolValue else { return }
            let stack = exception?.userInfo?[RCTJSStackTraceKey]
            self?.handleFatal(stack: stack) { self?.forwardFatalException(exception) }
        }

        NSSetUncaughtExceptionHandler(hotUpdaterUncaughtExceptionHandler)
    }

    private func handleFatal(stack: Any?, forward: @escaping () -> Void) {
        var attributed = fatalOwner(stack: stack)
        // A fatal of a module-less runtime (by stack, inference, or none)
        // takes a deferred load failure; one of a runtime with a module, or
        // of a claimed crash, leaves it to the runtime that failed.
        let loadFailure = coordinator.takeDeferredLoadFailure(
            for: attributed?.attribution ?? .none,
            owner: attributed?.name
        )
        var afterLoadFailure = false
        if attributed == nil, loadFailure != nil {
            afterLoadFailure = true
            // RCTInstance reports a load failure's fatal on the main thread.
            attributed = coordinator.inferredFatalOwner().map { ($0, nil, .inference) }
        }
        let owner = attributed?.name
        if owner == nil, let claim = coordinator.earlierRuntimeClaim {
            // The fatal of a runtime of an earlier launch: no launch is charged.
            forward()
            coordinator.clearAttribution(claim: claim)
            return
        }
        // A load failure no runtime claimed may be a named runtime's: then
        // main doesn't recover in-process, and the crash counts against
        // every unverified launch.
        if owner == mainName || (owner == nil && !afterLoadFailure), let main = manager(named: mainName) {
            // Main's fatal, or one no runtime claims: with only main, main
            // recovers in-process as it always has (never beside a named
            // instance, see HotUpdaterRecoveryCoordinator.requestRecovery).
            if main.requestRecoveryReloadIfNeeded(onFailure: { [weak self] in
                let claim = owner.flatMap { self?.coordinator.attribute(to: $0) }
                forward()
                if let claim {
                    self?.coordinator.clearAttribution(claim: claim)
                }
            }) {
                if owner == nil {
                    // Main lives on, but the fatal may have been a named
                    // runtime's: a named launch it leaves unverified rolls back.
                    coordinator.chargeUnverifiedNamedLaunches()
                }
                return
            }
        }
        if owner == nil, afterLoadFailure {
            let claim = coordinator.chargeUnclaimedLoadFailure(loadFailure)
            forward()
            coordinator.clearAttribution(claim: claim)
            return
        }
        // A named instance never reloads in-process: it applies updates and
        // rollbacks at its next start, and main's host must not reload for
        // another instance's fatal. React Native's default crashes the
        // process, and the crash is this instance's alone. The claim is
        // released only once the forwarded handler returns.
        // By its runtime, the launch it was recorded for, when the module told
        // it apart.
        let runtimeGeneration = attributed?.attribution == .runtimeModule
            ? runtimeLaunches.generation(of: hotUpdaterRuntimeIdentity())
            : nil
        let claim = coordinator.chargeFatal(
            owner: owner,
            runtimeBundleURL: attributed?.runtimeBundleURL,
            runtimeGeneration: runtimeGeneration
        )
        forward()
        if let claim {
            coordinator.clearAttribution(claim: claim)
        }
    }

    private func forwardFatalError(_ error: Error?) {
        if let previousFatalHandler {
            previousFatalHandler(error)
        } else {
            let handler = RCTGetFatalHandler()
            RCTSetFatalHandler(nil)
            RCTFatal(error)
            // React Native's DEBUG default handler can return.
            if RCTGetFatalHandler() == nil {
                RCTSetFatalHandler(handler)
            }
        }
    }

    private func forwardFatalException(_ exception: NSException?) {
        if let previousFatalExceptionHandler {
            previousFatalExceptionHandler(exception)
        } else {
            let handler = RCTGetFatalExceptionHandler()
            RCTSetFatalExceptionHandler(nil)
            RCTFatalException(exception)
            if RCTGetFatalExceptionHandler() == nil {
                RCTSetFatalExceptionHandler(handler)
            }
        }
    }

    // MARK: - Observers

    private func registerObservers() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleJavaScriptDidFailToLoad(_:)),
            name: NSNotification.Name.RCTJavaScriptDidFailToLoad,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleContentDidAppear(_:)),
            name: NSNotification.Name.RCTContentDidAppear,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleSurfaceWillStart(_:)),
            name: Self.surfaceWillStartNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleRuntimeDidResolve(_:)),
            name: Self.runtimeDidResolveNotification,
            object: nil
        )
    }

    @objc private func handleJavaScriptDidFailToLoad(_ notification: Notification) {
        let error = notification.userInfo?["error"] as? NSError ?? NSError(
            domain: "HotUpdaterRecovery",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "JavaScript bundle failed to load"]
        )
        // Old architecture: the bridge, whose bundle URL names the instance.
        // Bridgeless: the RCTInstance, whose runtime has no module when its
        // bundle didn't load, so it is unattributed and main's, as before.
        let owner = self.owner(of: notification.object as AnyObject?)
            ?? self.owner(of: notification.userInfo?["bridge"] as AnyObject?)

        // A named runtime that has no module yet may have failed: leave it to
        // the fatal RCTInstance reports next, which also reads its stack.
        if owner == nil, coordinator.deferUnclaimedLoadFailure() {
            return
        }

        if let owner, owner != mainName {
            let runtimeBundleURL = (notification.object as AnyObject?).flatMap(hotUpdaterBundleURL(forRootObject:))
                ?? (notification.userInfo?["bridge"] as AnyObject?).flatMap(hotUpdaterBundleURL(forRootObject:))
            let runtime = (notification.object as AnyObject?).flatMap(hotUpdaterRuntimeIdentity(forRootObject:))
                ?? (notification.userInfo?["bridge"] as AnyObject?).flatMap(hotUpdaterRuntimeIdentity(forRootObject:))
            let runtimeGeneration = runtimeLaunches.generation(of: runtime)
            // A runtime of an earlier launch fails, not the current one: the
            // fatal that follows charges no launch.
            guard coordinator.isCurrentRuntime(
                name: owner,
                runtimeBundleURL: runtimeBundleURL,
                runtimeGeneration: runtimeGeneration
            ) else {
                chargeLoadFailure(owner: owner, runtimeBundleURL: runtimeBundleURL, runtimeGeneration: runtimeGeneration)
                return
            }
            guard let generation = coordinator.awaitingContentGeneration(name: owner) else { return }
            // React Native's fatal follows and crashes the process: charge
            // this instance alone, so that fatal is attributed to it too.
            chargeLoadFailure(owner: owner, runtimeBundleURL: runtimeBundleURL, runtimeGeneration: runtimeGeneration)
            coordinator.stopAwaitingContent(name: owner, generation: generation)
            releaseHeldContent()
            return
        }

        guard let main = manager(named: mainName),
              let generation = coordinator.awaitingContentGeneration(name: mainName) else {
            return
        }
        if main.requestRecoveryReloadIfNeeded(onFailure: { [weak self] in
            self?.forwardFatalError(error)
        }) {
            return
        }
        if coordinator.hasNamedInstance {
            // No in-process reload beside named instances: the fatal React
            // Native reports next is main's, and main rolls back at its next
            // start.
            chargeLoadFailure(owner: mainName, runtimeBundleURL: nil, runtimeGeneration: nil)
        }
        coordinator.stopAwaitingContent(name: mainName, generation: generation)
    }

    /// Charges a load failure; its claim is the one the fatal React Native
    /// reports next takes over and releases. Without that fatal, the claim
    /// ends when the instance launches again or once the bound passes.
    private func chargeLoadFailure(owner: String, runtimeBundleURL: URL?, runtimeGeneration: Int?) {
        coordinator.chargeLoadFailure(
            owner: owner,
            runtimeBundleURL: runtimeBundleURL,
            runtimeGeneration: runtimeGeneration
        )
        DispatchQueue.main.asyncAfter(
            deadline: .now() + HotUpdaterRecoveryCoordinator.loadFailureClaimBound + 0.1
        ) { [weak self] in
            self?.coordinator.releaseExpiredLoadFailureClaims()
        }
    }

    @objc private func handleContentDidAppear(_ notification: Notification) {
        let view = notification.object as AnyObject?
        // React Native posts content on the main thread, where UIApplication
        // is read. Content the app shows in the background verifies nothing
        // until the app comes to the foreground (`HotUpdaterBackgroundContent`).
        if Thread.isMainThread, UIApplication.shared.applicationState == .background {
            holdUntilForeground(view)
            return
        }
        contentAppeared(view)
    }

    private func contentAppeared(_ view: AnyObject?) {
        let owner = owner(of: view)
        // A view no runtime claims is main's, as it always was, unless a
        // named runtime that has no module yet may have shown it.
        if owner == nil, let view, coordinator.holdUnclaimedContent(view) {
            // Main's at the latest once the bound passes.
            DispatchQueue.main.asyncAfter(
                deadline: .now() + HotUpdaterRecoveryCoordinator.heldContentBound + 0.1
            ) { [weak self] in
                self?.releaseHeldContent()
            }
            return
        }
        // Content of a runtime of an earlier launch verifies nothing, and
        // is not main's either.
        let runtimeBundleURL = owner == nil ? nil : view.flatMap(hotUpdaterBundleURL(forRootObject:))
        // The launch the view's runtime runs: content of a runtime torn down
        // after its host started a replacement with the same bundle verifies
        // nothing. Unknown (its runtime not told apart yet): by name and
        // bundle alone, as before.
        let runtimeGeneration = owner == nil
            ? nil
            : runtimeLaunches.generation(of: view.flatMap(hotUpdaterRuntimeIdentity(forRootObject:)))
        guard let verified = coordinator.contentAppeared(
            owner: owner,
            runtimeBundleURL: runtimeBundleURL,
            runtimeGeneration: runtimeGeneration
        ) else {
            return
        }
        manager(named: verified.launch.name)?.contentAppeared(generation: verified.generation)
        if verified.launch.name != mainName {
            releaseHeldContent()
        }
    }

    /// Main thread only.
    private func holdUntilForeground(_ view: AnyObject?) {
        guard backgroundContent.hold(view) else { return }
        backgroundContentObservers = [
            UIApplication.willEnterForegroundNotification,
            UIApplication.didBecomeActiveNotification,
        ].map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                guard let self else { return }
                self.backgroundContentObservers.forEach { NotificationCenter.default.removeObserver($0) }
                self.backgroundContentObservers = []
                for view in self.backgroundContent.takeAll() {
                    self.contentAppeared(view)
                }
            }
        }
    }

    /// Credits the content held for runtimes that had no module yet. Main
    /// thread only.
    private func releaseHeldContent() {
        for verified in coordinator.releaseHeldContent(
            owner: { self.owner(of: $0) },
            runtimeBundleURL: { hotUpdaterBundleURL(forRootObject: $0) },
            runtimeGeneration: { self.runtimeLaunches.generation(of: hotUpdaterRuntimeIdentity(forRootObject: $0)) }
        ) {
            manager(named: verified.launch.name)?.contentAppeared(generation: verified.generation)
        }
    }

    /// Posted by HotUpdaterRecoveryHooks.mm on the thread that shows a view:
    /// once a Fabric surface started and whenever its view moves into a
    /// window, or, in the old architecture, when an RCTRootView moves into a
    /// window. The launch starts only once a view is shown.
    @objc private func handleSurfaceWillStart(_ notification: Notification) {
        guard let surface = notification.object as AnyObject? else { return }
        // The launches the view started in, read now on the thread that
        // starts it: by the time the main queue runs `handle`, its host may
        // have started a replacement launch with the same bundle.
        let generations = coordinator.generations()
        let handle = { [weak self] in
            guard let self else { return }
            let inForeground = UIApplication.shared.applicationState != .background
            // Kept from its first start for its later ones.
            let firstGenerations = self.runtimeLaunches.generationsOfFirstStart(surface, current: generations)
            if let owner = self.owner(of: surface) {
                self.viewStarted(
                    owner: owner,
                    view: surface,
                    inForeground: inForeground,
                    generation: self.launchOfView(surface, owner: owner, firstGenerations: firstGenerations)
                )
            } else {
                // The surface starts before its bundle runs, so before the
                // runtime's module that tells whose it is.
                self.pendingSurfaceStarts.add(surface, inForeground: inForeground, generations: generations)
            }
        }
        // UIApplication is read on the main thread.
        if Thread.isMainThread {
            handle()
        } else {
            DispatchQueue.main.async(execute: handle)
        }
    }

    /// Posted by HotUpdater.mm when a runtime's module knows its instance.
    @objc private func handleRuntimeDidResolve(_ notification: Notification) {
        if let impl = notification.userInfo?["impl"] as? HotUpdaterImpl {
            let name = impl.environment.name
            let runtimeBundleURL = notification.userInfo?["bundleURL"] as? URL
            coordinator.runtimeResolved(name: name, runtimeBundleURL: runtimeBundleURL)
            // The launch this runtime runs: the current one, when its bundle
            // is that launch's. A runtime of an earlier launch gets none.
            // Keyed by the runtime's identity: its module, or in the old
            // architecture its bridge, which root views also reach.
            if let runtime = (notification.userInfo?["runtime"] ?? notification.object) as AnyObject?,
               coordinator.isCurrentRuntime(name: name, runtimeBundleURL: runtimeBundleURL),
               let generation = coordinator.generations()[name] {
                runtimeLaunches.record(runtime: runtime, generation: generation)
            }
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            // Content first: a launch whose content already appeared is
            // verified, and a surface start then no longer starts it.
            self.releaseHeldContent()
            // Decided by the app's state now, and whether the surface is
            // shown now: the app may have come to the foreground, and the
            // surface may have been attached, since it started.
            let inForegroundNow = UIApplication.shared.applicationState != .background
            for started in self.pendingSurfaceStarts.resolve({ self.owner(of: $0) }) {
                self.viewStarted(
                    owner: started.name,
                    view: started.surface,
                    inForeground: inForegroundNow,
                    generation: self.launchOfView(
                        started.surface,
                        owner: started.name,
                        firstGenerations: self.runtimeLaunches.generationsOfFirstStart(started.surface, current: [:])
                    ) ?? started.generation
                )
            }
        }
    }

    /// The launch a view started for: the one its runtime was recorded for,
    /// else the one current at its first start, so its later attachment
    /// after a replacement launch began starts nothing. Main thread only.
    private func launchOfView(_ view: AnyObject, owner: String, firstGenerations: [String: Int]) -> Int? {
        runtimeLaunches.generation(of: hotUpdaterRuntimeIdentity(forRootObject: view)) ?? firstGenerations[owner]
    }

    private func viewStarted(owner: String, view: AnyObject, inForeground: Bool, generation: Int?) {
        // Main's launch starts when it is selected, as it always has; a view
        // that started before its instance launched starts nothing.
        guard owner != mainName, let generation else { return }
        manager(named: owner)?.viewStarted(
            view,
            inForeground: inForeground,
            generation: generation,
            runtimeBundleURL: hotUpdaterBundleURL(forRootObject: view)
        )
    }
}
