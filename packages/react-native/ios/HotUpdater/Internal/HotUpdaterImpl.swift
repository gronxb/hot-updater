import Foundation
import React

@objcMembers public class HotUpdaterImpl: NSObject {
    private let bundleStorage: BundleStorageService
    private let preferences: PreferencesService

    private static let DEFAULT_CHANNEL = "production"

    // MARK: - Initialization
    
    /**
     * Convenience initializer that creates and configures all dependencies.
     */
    public convenience override init() {
        let fileSystem = FileManagerService()
        let preferences = VersionedPreferencesService()
        let downloadService = URLSessionDownloadService()
        let unzipService = SSZipArchiveUnzipService()
        
        let bundleStorage = BundleFileStorageService(
            fileSystem: fileSystem,
            downloadService: downloadService,
            unzipService: unzipService,
            preferences: preferences
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
        
        // Use fingerprint if available, otherwise use app version
        let baseKey = (fingerprintHash != nil && !fingerprintHash!.isEmpty) ? fingerprintHash! : appVersion
        
        // Build complete isolation key
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
                throw NSError(domain: "HotUpdaterError", code: 101, 
                             userInfo: [NSLocalizedDescriptionKey: "Missing params dictionary"])
            }
            
            guard let bundleId = data["bundleId"] as? String, !bundleId.isEmpty else {
                throw NSError(domain: "HotUpdaterError", code: 102, 
                             userInfo: [NSLocalizedDescriptionKey: "Missing or empty 'bundleId'"])
            }
            
            let fileUrlString = data["fileUrl"] as? String ?? ""
            
            var fileUrl: URL? = nil
            if !fileUrlString.isEmpty {
                guard let url = URL(string: fileUrlString) else {
                    throw NSError(domain: "HotUpdaterError", code: 103, 
                                 userInfo: [NSLocalizedDescriptionKey: "Invalid 'fileUrl' provided: \(fileUrlString)"])
                }
                fileUrl = url
            }
            
            NSLog("[HotUpdaterImpl] updateBundle called with bundleId: \(bundleId), fileUrl: \(fileUrl?.absoluteString ?? "nil")")
            
            // Heavy work is delegated to bundle storage service with safe error handling
            bundleStorage.updateBundle(bundleId: bundleId, fileUrl: fileUrl) { [weak self] result in
                guard self != nil else {
                    let error = NSError(domain: "HotUpdaterError", code: 998, 
                                       userInfo: [NSLocalizedDescriptionKey: "Self deallocated during update"])
                    DispatchQueue.main.async {
                        reject("UPDATE_ERROR", error.localizedDescription, error)
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
                        NSLog("[HotUpdaterImpl] Update failed for \(bundleId): \(error.localizedDescription). Rejecting promise.")
                        reject("UPDATE_ERROR", error.localizedDescription, error)
                    }
                }
            }
        } catch let error {
            // Main error boundary - catch and convert all errors to JS rejection
            NSLog("[HotUpdaterImpl] Error in updateBundleFromJS: \(error.localizedDescription)")
            reject("UPDATE_ERROR", error.localizedDescription, error)
        }
    }
}