import Foundation
import React

private func hotUpdaterUncaughtExceptionHandler(_ exception: NSException) {
    HotUpdaterRecoveryManager.shared.handleUncaughtException(exception)
}

@_silgen_name("HotUpdaterInstallSignalHandlers")
private func hotUpdaterInstallSignalHandlersSymbol(_ crashMarkerPath: NSString)

@_silgen_name("HotUpdaterUpdateSignalLaunchState")
private func hotUpdaterUpdateSignalLaunchStateSymbol(
    _ bundleId: NSString?,
    _ shouldRollback: ObjCBool
)

@_silgen_name("HotUpdaterPerformRecoveryReload")
private func hotUpdaterPerformRecoveryReloadSymbol() -> ObjCBool

private func hotUpdaterInstallSignalHandlers(_ crashMarkerPath: String) {
    hotUpdaterInstallSignalHandlersSymbol(crashMarkerPath as NSString)
}

private func hotUpdaterUpdateSignalLaunchState(_ bundleId: String?, shouldRollback: Bool) {
    hotUpdaterUpdateSignalLaunchStateSymbol(bundleId as NSString?, ObjCBool(shouldRollback))
}

private func hotUpdaterPerformRecoveryReload() -> Bool {
    return hotUpdaterPerformRecoveryReloadSymbol().boolValue
}

@objcMembers public class HotUpdaterImpl: NSObject {
    private let bundleStorage: BundleStorageService
    private let preferences: PreferencesService
    private let recoveryManager: HotUpdaterRecoveryManager
    private var currentLaunchSelection: LaunchSelection?

    private static let DEFAULT_CHANNEL = "production"
    private static let CHANNEL_STORAGE_KEY = "HotUpdaterChannel"

    // MARK: - Initialization

    /**
     * Convenience initializer that creates and configures all dependencies.
     */
    public convenience override init() {
        let fileSystem = FileManagerService()
        let isolationKey = HotUpdaterImpl.getIsolationKey()
        let preferences = VersionedPreferencesService()
        let downloadService = URLSessionDownloadService()
        let decompressService = DecompressService()

        let bundleStorage = BundleFileStorageService(
            fileSystem: fileSystem,
            downloadService: downloadService,
            decompressService: decompressService,
            preferences: preferences,
            isolationKey: isolationKey
        )
        let recoveryManager = HotUpdaterRecoveryManager.shared

        self.init(bundleStorage: bundleStorage, preferences: preferences, recoveryManager: recoveryManager)
    }

    /**
     * Primary initializer with dependency injection.
     * @param bundleStorage Service for bundle storage operations
     * @param preferences Service for preference storage
     */
    internal init(bundleStorage: BundleStorageService, preferences: PreferencesService, recoveryManager: HotUpdaterRecoveryManager) {
        self.bundleStorage = bundleStorage
        self.preferences = preferences
        self.recoveryManager = recoveryManager
        super.init()

        // Configure preferences with isolation key
        let isolationKey = HotUpdaterImpl.getIsolationKey()
        (preferences as? VersionedPreferencesService)?.configure(isolationKey: isolationKey)
    }
    
    // MARK: - Static Properties
    
    /**
     * Returns the app version from main bundle info.
     */
    public static var appVersion: String? {
        return Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    }

    /**
     * Returns the app version from main bundle info.
     */
    public static var appChannel: String {
        return Bundle.main.object(forInfoDictionaryKey: "HOT_UPDATER_CHANNEL") as? String ?? Self.DEFAULT_CHANNEL
    }
    
    /**
     * Gets the complete isolation key for preferences storage.
     * @return The isolation key in format: hotupdater_{fingerprintOrVersion}_{channel}_
     */
    public static func getIsolationKey() -> String {
        // Get fingerprint hash from Info.plist
        let fingerprintHash = Bundle.main.object(forInfoDictionaryKey: "HOT_UPDATER_FINGERPRINT_HASH") as? String

        // Get app version and channel
        let appVersion = self.appVersion ?? "unknown"
        let appChannel = self.appChannel

        // Include both fingerprint hash and app version for complete isolation
        let baseKey: String
        if let hash = fingerprintHash, !hash.isEmpty {
            baseKey = "\(hash)_\(appVersion)"
        } else {
            baseKey = appVersion
        }

        return "hotupdater_\(baseKey)_\(appChannel)_"
    }

    // MARK: - Channel Management
    
    /**
     * Gets the current update channel.
     * @return The channel name or nil if not set
     */
    public func getChannel() -> String {
        if let savedChannel = try? preferences.getItem(forKey: Self.CHANNEL_STORAGE_KEY),
           !savedChannel.isEmpty {
            return savedChannel
        }

        return Self.appChannel
    }

    public func getDefaultChannel() -> String {
        return Self.appChannel
    }

    /**
     * Gets the current fingerprint hash.
     * @return The fingerprint hash or nil if not set
     */
    public func getFingerprintHash() -> String? {
        return Bundle.main.object(forInfoDictionaryKey: "HOT_UPDATER_FINGERPRINT_HASH") as? String
    }

    // MARK: - Bundle URL Management
    
    /**
     * Gets the URL to the bundle file.
     * @param bundle instance to lookup the JavaScript bundle resource. Defaults to Bundle.main.
     * @return URL to the bundle or nil
     */
    public func bundleURL(bundle: Bundle = Bundle.main) -> URL? {
        return prepareLaunchIfNeeded(bundle: bundle).bundleURL
    }
    
    // MARK: - Bundle Update
    
    /**
     * Updates the bundle from JavaScript bridge.
     * This method acts as the primary error boundary for all bundle operations.
     * @param params Dictionary with bundleId and fileUrl parameters
     * @param resolve Promise resolve callback
     * @param reject Promise reject callback
     */
    public func updateBundle(_ params: NSDictionary?,
                                         resolver resolve: @escaping RCTPromiseResolveBlock,
                                         rejecter reject: @escaping RCTPromiseRejectBlock) {
        
        do {
            // Validate parameters (this runs on calling thread - typically JS thread)
            guard let data = params else {
                let error = NSError(domain: "HotUpdater", code: 0,
                                   userInfo: [NSLocalizedDescriptionKey: "Missing or invalid parameters for updateBundle"])
                reject("UNKNOWN_ERROR", error.localizedDescription, error)
                return
            }

            guard let bundleId = data["bundleId"] as? String, !bundleId.isEmpty else {
                let error = NSError(domain: "HotUpdater", code: 0,
                                   userInfo: [NSLocalizedDescriptionKey: "Missing or empty 'bundleId'"])
                reject("MISSING_BUNDLE_ID", error.localizedDescription, error)
                return
            }

            let fileUrlString = data["fileUrl"] as? String ?? ""

            var fileUrl: URL? = nil
            if !fileUrlString.isEmpty {
                guard let url = URL(string: fileUrlString) else {
                    let error = NSError(domain: "HotUpdater", code: 0,
                                       userInfo: [NSLocalizedDescriptionKey: "Invalid 'fileUrl' provided: \(fileUrlString)"])
                    reject("INVALID_FILE_URL", error.localizedDescription, error)
                    return
                }
                fileUrl = url
            }

            // Extract fileHash if provided
            let fileHash = data["fileHash"] as? String
            let channel = data["channel"] as? String

            // Extract progress callback if provided
            let progressCallback = data["progressCallback"] as? RCTResponseSenderBlock

            NSLog("[HotUpdaterImpl] updateBundle called with bundleId: \(bundleId), fileUrl: \(fileUrl?.absoluteString ?? "nil"), fileHash: \(fileHash ?? "nil")")

            // Heavy work is delegated to bundle storage service with safe error handling
            bundleStorage.updateBundle(bundleId: bundleId, fileUrl: fileUrl, fileHash: fileHash, progressHandler: { progress in
                // Call JS progress callback if provided
                if let callback = progressCallback {
                    DispatchQueue.main.async {
                        callback([progress])
                    }
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
                // Return results on main thread for React Native bridge
                DispatchQueue.main.async {
                    switch result {
                    case .success:
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
                        resolve(true)
                    case .failure(let error):
                        NSLog("[HotUpdaterImpl] Update failed for \(bundleId) - Error: \(error)")

                        let normalizedCode = HotUpdaterImpl.normalizeErrorCode(from: error)
                        let nsError = error as NSError
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

    /**
     * Normalizes native errors to a small, predictable set of JS-facing error codes.
     * Rare or platform-specific codes are collapsed to UNKNOWN_ERROR to reduce surface area.
     */
    private static func normalizeErrorCode(from error: Error) -> String {
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
        "EXTRACTION_FORMAT_ERROR",
        "INVALID_BUNDLE",
        "INSUFFICIENT_DISK_SPACE",
        "SIGNATURE_VERIFICATION_FAILED",
        "MOVE_OPERATION_FAILED",
        "BUNDLE_IN_CRASHED_HISTORY",
        "SELF_DEALLOCATED",
        "UNKNOWN_ERROR",
    ]

    // MARK: - Rollback Support

    /**
     * Returns the native launch report for the current process.
     * This is read-only; startup success and rollback are finalized before JS reads it.
     */
    public func notifyAppReady() -> [String: Any] {
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

    /**
     * Gets the base URL for the current active bundle directory.
     * Returns the file:// URL to the bundle directory with trailing slash.
     * This is used for Expo DOM components to construct full asset paths.
     * @return Base URL string (e.g., "file:///var/.../bundle-store/abc123/") or empty string
     */
    public func getBaseURL() -> String {
        return bundleStorage.getBaseURL()
    }

    /**
     * Gets the current active bundle ID from bundle storage.
     * Reads manifest.json first and falls back to the legacy BUNDLE_ID file.
     * Built-in bundle fallback is handled in JS.
     */
    public func getBundleId() -> String? {
        return bundleStorage.getBundleId()
    }

    /**
     * Gets the current manifest from bundle storage.
     */
    public func getManifest() -> ManifestAssets {
        return bundleStorage.getManifest()
    }

    public func resetLaunchPreparation() {
        currentLaunchSelection = nil
    }

    @objc
    public func resetChannel(_ resolver: @escaping RCTPromiseResolveBlock,
                             rejecter reject: @escaping RCTPromiseRejectBlock) {
        let result = bundleStorage.resetChannel()

        switch result {
        case .success(let success):
            do {
                try preferences.setItem(nil, forKey: Self.CHANNEL_STORAGE_KEY)
            } catch {
                NSLog("[HotUpdaterImpl] Failed to clear channel override: \(error)")
            }
            self.currentLaunchSelection = nil
            resolver(success)
        case .failure(let error):
            let normalizedCode = HotUpdaterImpl.normalizeErrorCode(from: error)
            let nsError = error as NSError
            reject(normalizedCode, nsError.localizedDescription, nsError)
        }
    }

    private func prepareLaunchIfNeeded(bundle: Bundle) -> LaunchSelection {
        if let currentLaunchSelection {
            return currentLaunchSelection
        }

        let pendingRecovery = recoveryManager.consumePendingCrashRecovery()
        let selection = bundleStorage.prepareLaunch(bundle: bundle, pendingRecovery: pendingRecovery)
        recoveryManager.startMonitoring(bundleId: selection.launchedBundleId, shouldRollback: selection.shouldRollbackOnCrash) { [weak self] launchedBundleId in
            self?.bundleStorage.markLaunchCompleted(bundleId: launchedBundleId)
        }
        currentLaunchSelection = selection
        return selection
    }
}

@objcMembers
final class HotUpdaterRecoveryManager: NSObject {
    static let shared = HotUpdaterRecoveryManager()

    private let crashMarkerURL: URL
    private var previousFatalHandler: RCTFatalHandler?
    private var previousFatalExceptionHandler: RCTFatalExceptionHandler?
    private var previousUncaughtExceptionHandler: (@convention(c) (NSException) -> Void)?

    private var signalHandlersInstalled = false
    private var handlersInstalled = false
    private var isMonitoring = false
    private var recoveryRequested = false
    private var currentBundleId: String?
    private var shouldRollbackOnCrash = false
    private var contentAppearedCallback: ((String?) -> Void)?
    private var stopMonitoringWorkItem: DispatchWorkItem?

    private override init() {
        let documentsPath = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        self.crashMarkerURL = documentsPath
            .appendingPathComponent("bundle-store", isDirectory: true)
            .appendingPathComponent("recovery-crash-marker.json")
        super.init()
    }

    func consumePendingCrashRecovery() -> PendingCrashRecovery? {
        guard FileManager.default.fileExists(atPath: crashMarkerURL.path) else {
            return nil
        }

        defer {
            try? FileManager.default.removeItem(at: crashMarkerURL)
        }

        do {
            let data = try Data(contentsOf: crashMarkerURL)
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
            return PendingCrashRecovery.from(json: json)
        } catch {
            NSLog("[HotUpdaterRecovery] Failed to read crash marker: \(error)")
            return nil
        }
    }

    func startMonitoring(
        bundleId: String?,
        shouldRollback: Bool,
        onContentAppeared: @escaping (String?) -> Void
    ) {
        currentBundleId = bundleId
        shouldRollbackOnCrash = shouldRollback
        recoveryRequested = false
        contentAppearedCallback = onContentAppeared
        isMonitoring = true

        stopMonitoringWorkItem?.cancel()
        stopMonitoringWorkItem = nil

        installHandlersIfNeeded()
        registerObservers()
        installSignalHandlersIfNeeded()
        hotUpdaterUpdateSignalLaunchState(bundleId, shouldRollback: shouldRollback)
    }

    func handleUncaughtException(_ exception: NSException) {
        writeCrashMarker()
        if requestRecoveryReloadIfNeeded() {
            return
        }
        previousUncaughtExceptionHandler?(exception)
    }

    private func installHandlersIfNeeded() {
        guard !handlersInstalled else {
            return
        }

        previousFatalHandler = RCTGetFatalHandler()
        previousFatalExceptionHandler = RCTGetFatalExceptionHandler()
        previousUncaughtExceptionHandler = NSGetUncaughtExceptionHandler()

        RCTSetFatalHandler { [weak self] error in
            self?.writeCrashMarker()
            if self?.requestRecoveryReloadIfNeeded() != true {
                self?.previousFatalHandler?(error)
            }
        }

        RCTSetFatalExceptionHandler { [weak self] exception in
            self?.writeCrashMarker()
            if self?.requestRecoveryReloadIfNeeded() != true {
                self?.previousFatalExceptionHandler?(exception)
            }
        }

        NSSetUncaughtExceptionHandler(hotUpdaterUncaughtExceptionHandler)
        handlersInstalled = true
    }

    private func installSignalHandlersIfNeeded() {
        guard !signalHandlersInstalled else {
            return
        }

        try? FileManager.default.createDirectory(
            at: crashMarkerURL.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: nil
        )
        hotUpdaterInstallSignalHandlers(crashMarkerURL.path)
        signalHandlersInstalled = true
    }

    private func registerObservers() {
        unregisterObservers()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleJavaScriptDidFailToLoad),
            name: NSNotification.Name.RCTJavaScriptDidFailToLoad,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleContentDidAppear),
            name: NSNotification.Name.RCTContentDidAppear,
            object: nil
        )
    }

    private func unregisterObservers() {
        NotificationCenter.default.removeObserver(
            self,
            name: NSNotification.Name.RCTJavaScriptDidFailToLoad,
            object: nil
        )
        NotificationCenter.default.removeObserver(
            self,
            name: NSNotification.Name.RCTContentDidAppear,
            object: nil
        )
    }

    @objc private func handleJavaScriptDidFailToLoad() {
        if requestRecoveryReloadIfNeeded() {
            return
        }
        unregisterObservers()
    }

    @objc private func handleContentDidAppear() {
        guard isMonitoring else {
            return
        }

        unregisterObservers()
        contentAppearedCallback?(currentBundleId)
        shouldRollbackOnCrash = false
        hotUpdaterUpdateSignalLaunchState(currentBundleId, shouldRollback: false)

        stopMonitoringWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.finishMonitoring()
        }
        stopMonitoringWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(10), execute: workItem)
    }

    private func finishMonitoring() {
        isMonitoring = false
        recoveryRequested = false
        stopMonitoringWorkItem = nil
        currentBundleId = nil
        shouldRollbackOnCrash = false
        contentAppearedCallback = nil
        hotUpdaterUpdateSignalLaunchState(nil, shouldRollback: false)
    }

    private func requestRecoveryReloadIfNeeded() -> Bool {
        guard isMonitoring, shouldRollbackOnCrash else {
            return false
        }

        objc_sync_enter(self)
        if recoveryRequested {
            objc_sync_exit(self)
            return true
        }
        recoveryRequested = true
        objc_sync_exit(self)

        let bundleId = currentBundleId
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                return
            }

            let started = hotUpdaterPerformRecoveryReload()
            if !started {
                objc_sync_enter(self)
                self.recoveryRequested = false
                objc_sync_exit(self)
                NSLog("[HotUpdaterRecovery] Failed to trigger recovery reload")
            } else {
                NSLog("[HotUpdaterRecovery] Triggered recovery reload for bundleId=\(bundleId ?? "nil")")
            }
        }

        return true
    }

    private func writeCrashMarker() {
        guard isMonitoring else {
            return
        }

        do {
            try FileManager.default.createDirectory(
                at: crashMarkerURL.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: nil
            )

            let payload: [String: Any] = [
                "bundleId": currentBundleId ?? NSNull(),
                "shouldRollback": shouldRollbackOnCrash,
            ]
            let data = try JSONSerialization.data(withJSONObject: payload)
            try data.write(to: crashMarkerURL, options: .atomic)
        } catch {
            NSLog("[HotUpdaterRecovery] Failed to write crash marker: \(error)")
        }
    }
}
