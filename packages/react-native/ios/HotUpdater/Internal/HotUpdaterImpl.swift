import Foundation
import React

@objcMembers public class HotUpdaterImpl: NSObject {
    private let bundleStorage: BundleStorageService
    private let preferences: PreferencesService
    private let deviceIdService: DeviceIdService

    private static let DEFAULT_CHANNEL = "production"

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

        self.init(bundleStorage: bundleStorage, preferences: preferences)
    }

    /**
     * Primary initializer with dependency injection.
     * @param bundleStorage Service for bundle storage operations
     * @param preferences Service for preference storage
     */
    internal init(bundleStorage: BundleStorageService, preferences: PreferencesService) {
        self.bundleStorage = bundleStorage
        self.preferences = preferences
        self.deviceIdService = DeviceIdService()
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
        return Bundle.main.object(forInfoDictionaryKey: "HOT_UPDATER_CHANNEL") as? String ?? Self.DEFAULT_CHANNEL
    }

    /**
     * Gets the current fingerprint hash.
     * @return The fingerprint hash or nil if not set
     */
    public func getFingerprintHash() -> String? {
        return Bundle.main.object(forInfoDictionaryKey: "HOT_UPDATER_FINGERPRINT_HASH") as? String
    }

    // MARK: - User ID Management

    public func setUserId(_ customId: String) {
        deviceIdService.setUserId(customId)
    }

    public func getUserId() -> String {
        return deviceIdService.getUserId()
    }

    // MARK: - Bundle URL Management
    
    /**
     * Gets the URL to the bundle file.
     * @return URL to the bundle or nil
     */
    public func bundleURL() -> URL? {
        return bundleStorage.getBundleURL()
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
                guard self != nil else {
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
     * Notifies the system that the app has successfully started with the given bundle.
     * If the bundle matches the staging bundle, it promotes to stable.
     * @param bundleId The ID of the currently running bundle
     * @return true if promotion was successful or no action was needed
     */
    public func notifyAppReady(bundleId: String) -> [String: Any] {
        return bundleStorage.notifyAppReady(bundleId: bundleId)
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
}
