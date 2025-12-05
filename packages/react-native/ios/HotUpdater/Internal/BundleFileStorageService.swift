import Foundation

public enum BundleStorageError: Error, CustomNSError {
    case directoryCreationFailed
    case downloadFailed(Error)
    case incompleteDownload(expected: Int64, actual: Int64)
    case extractionFormatError(Error)
    case invalidBundle
    case insufficientDiskSpace
    case signatureVerificationFailed(SignatureVerificationError)
    case moveOperationFailed(Error)
    case bundleInCrashedHistory(String)
    case unknown(Error?)

    // CustomNSError protocol implementation
    public static var errorDomain: String {
        return "HotUpdater"
    }

    public var errorCode: Int {
        return 0
    }

    public var errorCodeString: String {
        switch self {
        case .directoryCreationFailed: return "DIRECTORY_CREATION_FAILED"
        case .downloadFailed: return "DOWNLOAD_FAILED"
        case .incompleteDownload: return "INCOMPLETE_DOWNLOAD"
        case .extractionFormatError: return "EXTRACTION_FORMAT_ERROR"
        case .invalidBundle: return "INVALID_BUNDLE"
        case .insufficientDiskSpace: return "INSUFFICIENT_DISK_SPACE"
        case .signatureVerificationFailed: return "SIGNATURE_VERIFICATION_FAILED"
        case .moveOperationFailed: return "MOVE_OPERATION_FAILED"
        case .bundleInCrashedHistory: return "BUNDLE_IN_CRASHED_HISTORY"
        case .unknown: return "UNKNOWN_ERROR"
        }
    }

    public var errorUserInfo: [String: Any] {
        var userInfo: [String: Any] = [:]

        switch self {
        case .directoryCreationFailed:
            userInfo[NSLocalizedDescriptionKey] = "Failed to create required directory for bundle storage"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "Check app permissions and available disk space"

        case .downloadFailed(let underlyingError):
            userInfo[NSLocalizedDescriptionKey] = "Failed to download bundle from server"
            userInfo[NSUnderlyingErrorKey] = underlyingError
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "Check network connection and try again"

        case .incompleteDownload(let expected, let actual):
            userInfo[NSLocalizedDescriptionKey] = "Download incomplete: received \(actual) bytes, expected \(expected) bytes"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "The download was interrupted. Check network connection and try again"

        case .extractionFormatError(let underlyingError):
            userInfo[NSLocalizedDescriptionKey] = "Invalid or corrupted bundle archive format"
            userInfo[NSUnderlyingErrorKey] = underlyingError
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "The bundle archive may be corrupted or in an unsupported format. Try downloading again"

        case .invalidBundle:
            userInfo[NSLocalizedDescriptionKey] = "Bundle missing required platform files (index.ios.bundle or main.jsbundle)"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "Verify the bundle was built correctly with metro bundler"

        case .insufficientDiskSpace:
            userInfo[NSLocalizedDescriptionKey] = "Insufficient disk space to download and extract bundle"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "Free up device storage and try again"

        case .signatureVerificationFailed(let underlyingError):
            userInfo[NSLocalizedDescriptionKey] = "Bundle signature verification failed"
            userInfo[NSUnderlyingErrorKey] = underlyingError
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "The bundle signature is invalid. Update rejected for security"

        case .moveOperationFailed(let underlyingError):
            userInfo[NSLocalizedDescriptionKey] = "Failed to move bundle to final location"
            userInfo[NSUnderlyingErrorKey] = underlyingError
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "Check file system permissions"

        case .bundleInCrashedHistory(let bundleId):
            userInfo[NSLocalizedDescriptionKey] = "Bundle '\(bundleId)' is in crashed history and cannot be applied"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "This bundle previously caused a crash and was blocked for safety"

        case .unknown(let underlyingError):
            userInfo[NSLocalizedDescriptionKey] = "An unknown error occurred during bundle update"
            if let error = underlyingError {
                userInfo[NSUnderlyingErrorKey] = error
            }
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "Please try again or contact support with error details"
        }

        return userInfo
    }
}

/**
 * Protocol for interacting with bundle storage system.
 * `updateBundle` operates asynchronously using a completion handler.
 * Other operations are synchronous.
 */
public protocol BundleStorageService {

    // Bundle URL operations
    func setBundleURL(localPath: String?) -> Result<Void, Error>
    func getCachedBundleURL() -> URL?
    func getFallbackBundleURL() -> URL? // Synchronous as it's lightweight
    func getBundleURL() -> URL?

    // Bundle update
    func updateBundle(bundleId: String, fileUrl: URL?, fileHash: String?, progressHandler: @escaping (Double) -> Void, completion: @escaping (Result<Bool, Error>) -> Void)

    // Rollback support
    func notifyAppReady(bundleId: String) -> [String: Any]
    func getCrashHistory() -> CrashedHistory
    func clearCrashHistory() -> Bool
}

class BundleFileStorageService: BundleStorageService {
    private let fileSystem: FileSystemService
    private let downloadService: DownloadService
    private let decompressService: DecompressService
    private let preferences: PreferencesService

    private let id = Int.random(in: 1..<100)
    
    // Queue for potentially long-running sequences within updateBundle or for explicit background tasks.
    private let fileOperationQueue: DispatchQueue

    private var activeTasks: [URLSessionTask] = []

    // Session-only rollback tracking (in-memory)
    private var sessionRollbackBundleId: String?

    public init(fileSystem: FileSystemService,
                downloadService: DownloadService,
                decompressService: DecompressService,
                preferences: PreferencesService) {

        self.fileSystem = fileSystem
        self.downloadService = downloadService
        self.decompressService = decompressService
        self.preferences = preferences

        // Create queue for file operations
        self.fileOperationQueue = DispatchQueue(label: "com.hotupdater.fileoperations",
                                               qos: .utility,
                                               attributes: .concurrent)
    }

    // MARK: - Metadata File Paths

    private func metadataFileURL() -> URL? {
        guard case .success(let storeDir) = bundleStoreDir() else {
            return nil
        }
        return URL(fileURLWithPath: storeDir).appendingPathComponent(BundleMetadata.metadataFilename)
    }

    private func crashedHistoryFileURL() -> URL? {
        guard case .success(let storeDir) = bundleStoreDir() else {
            return nil
        }
        return URL(fileURLWithPath: storeDir).appendingPathComponent(CrashedHistory.crashedHistoryFilename)
    }

    // MARK: - Metadata Operations

    private func loadMetadataOrNull() -> BundleMetadata? {
        guard let file = metadataFileURL() else {
            return nil
        }
        return BundleMetadata.load(from: file)
    }

    private func saveMetadata(_ metadata: BundleMetadata) -> Bool {
        guard let file = metadataFileURL() else {
            return false
        }
        return metadata.save(to: file)
    }

    // MARK: - Crashed History Operations

    private func loadCrashedHistory() -> CrashedHistory {
        guard let file = crashedHistoryFileURL() else {
            return CrashedHistory()
        }
        return CrashedHistory.load(from: file)
    }

    private func saveCrashedHistory(_ history: CrashedHistory) -> Bool {
        guard let file = crashedHistoryFileURL() else {
            return false
        }
        return history.save(to: file)
    }

    // MARK: - State Machine Methods

    private func isVerificationPending(_ metadata: BundleMetadata) -> Bool {
        return metadata.verificationPending && metadata.stagingBundleId != nil
    }

    private func wasVerificationAttempted(_ metadata: BundleMetadata) -> Bool {
        return metadata.verificationAttemptedAt != nil
    }

    private func markVerificationAttempted() {
        guard var metadata = loadMetadataOrNull() else {
            return
        }
        metadata.verificationAttemptedAt = Date().timeIntervalSince1970 * 1000
        let _ = saveMetadata(metadata)
        NSLog("[BundleStorage] Marked verification attempted for staging bundle: \(metadata.stagingBundleId ?? "nil")")
    }

    private func incrementStagingExecutionCount() {
        guard var metadata = loadMetadataOrNull() else {
            return
        }
        metadata.stagingExecutionCount = (metadata.stagingExecutionCount ?? 0) + 1
        metadata.updatedAt = Date().timeIntervalSince1970 * 1000
        let _ = saveMetadata(metadata)
        NSLog("[BundleStorage] Incremented staging execution count to: \(metadata.stagingExecutionCount ?? 0)")
    }

    private func promoteStagingToStable() {
        guard var metadata = loadMetadataOrNull() else {
            return
        }
        guard let stagingId = metadata.stagingBundleId else {
            NSLog("[BundleStorage] No staging bundle to promote")
            return
        }

        let oldStableId = metadata.stableBundleId
        metadata.stableBundleId = stagingId
        metadata.stagingBundleId = nil
        metadata.verificationPending = false
        metadata.verificationAttemptedAt = nil
        metadata.stagingExecutionCount = nil
        metadata.updatedAt = Date().timeIntervalSince1970 * 1000

        if saveMetadata(metadata) {
            NSLog("[BundleStorage] Promoted staging '\(stagingId)' to stable (old stable: \(oldStableId ?? "nil"))")

            // Clean up old stable bundle
            if let oldId = oldStableId, oldId != stagingId {
                let _ = cleanupOldBundles(currentBundleId: stagingId, bundleId: nil)
            }
        }
    }

    private func rollbackToStable() {
        guard var metadata = loadMetadataOrNull() else {
            return
        }
        guard let stagingId = metadata.stagingBundleId else {
            NSLog("[BundleStorage] No staging bundle to rollback from")
            return
        }

        // Add crashed bundle to history
        var crashedHistory = loadCrashedHistory()
        crashedHistory.addEntry(stagingId)
        let _ = saveCrashedHistory(crashedHistory)
        NSLog("[BundleStorage('\(id)')] Added bundle '\(stagingId)' to crashed history")

        // Save rollback info to session variable (memory only)
        self.sessionRollbackBundleId = stagingId

        // Clear staging
        metadata.stagingBundleId = nil
        metadata.verificationPending = false
        metadata.verificationAttemptedAt = nil
        metadata.stagingExecutionCount = nil
        metadata.updatedAt = Date().timeIntervalSince1970 * 1000

        if saveMetadata(metadata) {
            NSLog("[BundleStorage] Rolled back to stable bundle: \(metadata.stableBundleId ?? "fallback")")

            // Update HotUpdaterBundleURL to point to stable bundle
            if let stableId = metadata.stableBundleId {
                if case .success(let storeDir) = bundleStoreDir() {
                    let stableBundleDir = (storeDir as NSString).appendingPathComponent(stableId)
                    if case .success(let bundlePath) = findBundleFile(in: stableBundleDir), let path = bundlePath {
                        let _ = setBundleURL(localPath: path)
                    }
                }
            } else {
                // Reset to fallback
                let _ = setBundleURL(localPath: nil)
            }

            // Clean up failed staging bundle
            let _ = cleanupOldBundles(currentBundleId: metadata.stableBundleId, bundleId: nil)
        }
    }
    
    // MARK: - Directory Management
    
    /**
     * Ensures a directory exists at the specified path. Creates it if necessary.
     * Executes synchronously on the calling thread.
     * @param path The path where directory should exist
     * @return Result with the path or an error
     */
    private func ensureDirectoryExists(path: String) -> Result<String, Error> {
        if !self.fileSystem.fileExists(atPath: path) {
            if !self.fileSystem.createDirectory(atPath: path) {
                return .failure(BundleStorageError.directoryCreationFailed)
            }
        }
        return .success(path)
    }
    
    /**
     * Gets the path to the bundle store directory.
     * Executes synchronously on the calling thread.
     * @return Result with the directory path or error
     */
    func bundleStoreDir() -> Result<String, Error> {
        let path = (fileSystem.documentsPath() as NSString).appendingPathComponent("bundle-store")
        return ensureDirectoryExists(path: path)
    }
    
    /**
     * Gets the path to the temporary directory.
     * Executes synchronously on the calling thread.
     * @return Result with the directory path or error
     */
    func tempDir() -> Result<String, Error> {
        let path = (fileSystem.documentsPath() as NSString).appendingPathComponent("bundle-temp")
        return ensureDirectoryExists(path: path)
    }
    
    /**
     * Cleans up temporary files safely. Executes synchronously on the calling thread.
     * @param paths Array of file/directory paths to clean up
     */
    private func cleanupTemporaryFiles(_ paths: [String]) {
        let workItem = DispatchWorkItem {
            for path in paths {
                do {
                    if self.fileSystem.fileExists(atPath: path) {
                        try self.fileSystem.removeItem(atPath: path)
                        NSLog("[BundleStorage] Cleaned up temporary file: \(path)")
                    }
                } catch {
                    NSLog("[BundleStorage] Failed to clean up temporary file \(path): \(error.localizedDescription)")
                }
            }
        }
        DispatchQueue.global(qos: .background).async(execute: workItem)
    }
    
    // MARK: - Bundle File Operations
    
    /**
     * Finds the bundle file within a directory by checking direct paths.
     * Executes synchronously on the calling thread.
     * @param directoryPath Directory to search in
     * @return Result with path to bundle file or error
     */
    func findBundleFile(in directoryPath: String) -> Result<String?, Error> {
        NSLog("[BundleStorage] Searching for bundle file in directory: \(directoryPath)")
        
        // Check directory contents
        do {
            let contents = try self.fileSystem.contentsOfDirectory(atPath: directoryPath)
            NSLog("[BundleStorage] Directory contents: \(contents)")
            
            // Check for iOS bundle file directly
            let iosBundlePath = (directoryPath as NSString).appendingPathComponent("index.ios.bundle")
            if self.fileSystem.fileExists(atPath: iosBundlePath) {
                NSLog("[BundleStorage] Found iOS bundle atPath: \(iosBundlePath)")
                return .success(iosBundlePath)
            }
            
            // Check for main bundle file
            let mainBundlePath = (directoryPath as NSString).appendingPathComponent("main.jsbundle")
            if self.fileSystem.fileExists(atPath: mainBundlePath) {
                NSLog("[BundleStorage] Found main bundle atPath: \(mainBundlePath)")
                return .success(mainBundlePath)
            }
            
            // Additional search: check all .bundle files
            for file in contents {
                if file.hasSuffix(".bundle") {
                    let bundlePath = (directoryPath as NSString).appendingPathComponent(file)
                    NSLog("[BundleStorage] Found alternative bundle atPath: \(bundlePath)")
                    return .success(bundlePath)
                }
            }
            
            NSLog("[BundleStorage] No bundle file found in directory: \(directoryPath)")
            NSLog("[BundleStorage] Available files: \(contents)")
            return .success(nil)
        } catch let error {
            NSLog("[BundleStorage] Error reading directory contents: \(error.localizedDescription)")
            return .failure(error)
        }
    }
        
    /**
    * Cleans up old bundles, keeping only the current and new bundles.
    * Executes synchronously on the calling thread.
    * @param currentBundleId ID of the current active bundle (optional)
    * @param bundleId ID of the new bundle to keep (optional)
    * @return Result of operation
    */
    func cleanupOldBundles(currentBundleId: String?, bundleId: String?) -> Result<Void, Error> {
        let storeDirResult = bundleStoreDir()
        
        guard case .success(let storeDir) = storeDirResult else {
            return .failure(storeDirResult.failureError ?? BundleStorageError.unknown(nil))
        }
        
        // List only directories that are not .tmp
        let contents: [String]
        do {
            contents = try self.fileSystem.contentsOfDirectory(atPath: storeDir)
        } catch let error {
            NSLog("[BundleStorage] Failed to list contents of bundle store directory: \(storeDir)")
            return .failure(BundleStorageError.unknown(error))
        }
        
        let bundles = contents.compactMap { item -> String? in
            let fullPath = (storeDir as NSString).appendingPathComponent(item)

            // Skip metadata files - DO NOT delete
            if item == "metadata.json" || item == "crashed-history.json" {
                return nil
            }

            return (!item.hasSuffix(".tmp") && self.fileSystem.fileExists(atPath: fullPath)) ? fullPath : nil
        }
        
        // Keep only the specified bundle IDs
        let bundleIdsToKeep = Set([currentBundleId, bundleId].compactMap { $0 })
        
        bundles.forEach { bundlePath in
            let bundleName = (bundlePath as NSString).lastPathComponent
            
            if !bundleIdsToKeep.contains(bundleName) {
                do {
                    try self.fileSystem.removeItem(atPath: bundlePath)
                    NSLog("[BundleStorage] Removing old bundle: \(bundleName)")
                } catch {
                    NSLog("[BundleStorage] Failed to remove old bundle at \(bundlePath): \(error)")
                }
            } else {
                NSLog("[BundleStorage] Keeping bundle: \(bundleName)")
            }
        }
        
        // Remove any leftover .tmp directories
        contents.forEach { item in
            if item.hasSuffix(".tmp") {
                let fullPath = (storeDir as NSString).appendingPathComponent(item)
                do {
                    try self.fileSystem.removeItem(atPath: fullPath)
                    NSLog("[BundleStorage] Removing stale tmp directory: \(item)")
                } catch {
                    NSLog("[BundleStorage] Failed to remove stale tmp directory \(fullPath): \(error)")
                }
            }
        }
        
        return .success(())
    }
    
    /**
     * Sets the current bundle URL in preferences.
     * Executes synchronously on the calling thread.
     * @param localPath Path to the bundle file (or nil to reset)
     * @return Result of operation
     */
    func setBundleURL(localPath: String?) -> Result<Void, Error> {
        do {
            NSLog("[BundleStorage] Setting bundle URL to: \(localPath ?? "nil")")
            try self.preferences.setItem(localPath, forKey: "HotUpdaterBundleURL")
            return .success(())
        } catch let error {
            return .failure(error)
        }
    }
    
    /**
     * Gets the URL to the cached bundle file if it exists.
     */
    func getCachedBundleURL() -> URL? {
        do {
            guard let savedURLString = try self.preferences.getItem(forKey: "HotUpdaterBundleURL"),
                  let bundleURL = URL(string: savedURLString),
                  self.fileSystem.fileExists(atPath: bundleURL.path) else {
                return nil
            }
            return bundleURL
        } catch {
            NSLog("[BundleStorage] Error getting cached bundle URL: \(error.localizedDescription)")
            return nil
        }
    }
    
    /**
     * Gets the URL to the fallback bundle included in the app.
     * @return URL to the fallback bundle or nil if not found
     */
    func getFallbackBundleURL() -> URL? {
        return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
    }
    
    public func getBundleURL() -> URL? {
        // Try to load metadata
        let metadata = loadMetadataOrNull()

        // If no metadata exists, use legacy behavior (backwards compatible)
        guard let metadata = metadata else {
            let cached = getCachedBundleURL()
            return cached ?? getFallbackBundleURL()
        }

        // Check if we need to handle crash recovery
        if isVerificationPending(metadata) {
            let executionCount = metadata.stagingExecutionCount ?? 0

            if executionCount == 0 {
                // First execution - give staging bundle a chance
                NSLog("[BundleStorage] First execution of staging bundle, incrementing counter")
                incrementStagingExecutionCount()
                // Don't mark verificationAttempted yet!
            } else if wasVerificationAttempted(metadata) {
                // Already executed once and verificationAttempted is set → crash!
                NSLog("[BundleStorage] Crash detected: staging bundle executed but didn't call notifyAppReady")
                rollbackToStable()
            } else {
                // Second execution - now mark verification attempted
                NSLog("[BundleStorage] Second execution of staging bundle, marking verification attempted")
                markVerificationAttempted()
            }
        }

        // Reload metadata after potential rollback
        guard let currentMetadata = loadMetadataOrNull() else {
            return getCachedBundleURL() ?? getFallbackBundleURL()
        }

        // If verification is pending, return staging bundle URL
        if isVerificationPending(currentMetadata), let stagingId = currentMetadata.stagingBundleId {
            if case .success(let storeDir) = bundleStoreDir() {
                let stagingBundleDir = (storeDir as NSString).appendingPathComponent(stagingId)
                if case .success(let bundlePath) = findBundleFile(in: stagingBundleDir), let path = bundlePath {
                    NSLog("[BundleStorage] Returning staging bundle URL: \(path)")
                    return URL(fileURLWithPath: path)
                }
            }
        }

        // Return stable bundle URL
        if let stableId = currentMetadata.stableBundleId {
            if case .success(let storeDir) = bundleStoreDir() {
                let stableBundleDir = (storeDir as NSString).appendingPathComponent(stableId)
                if case .success(let bundlePath) = findBundleFile(in: stableBundleDir), let path = bundlePath {
                    NSLog("[BundleStorage] Returning stable bundle URL: \(path)")
                    return URL(fileURLWithPath: path)
                }
            }
        }

        // Fallback to app bundle
        return getFallbackBundleURL()
    }
    
    // MARK: - Bundle Update
    
    /**
     * Updates the bundle from the specified URL. This operation is asynchronous.
     * @param bundleId ID of the bundle to update
     * @param fileUrl URL of the bundle file to download (or nil to reset)
     * @param fileHash Combined hash string for verification (sig:<signature> or <hex_hash>)
     * @param progressHandler Callback for download and extraction progress (0.0 to 1.0)
     * @param completion Callback with result of the operation
     */
    func updateBundle(bundleId: String, fileUrl: URL?, fileHash: String?, progressHandler: @escaping (Double) -> Void, completion: @escaping (Result<Bool, Error>) -> Void) {
        // Check if bundle is in crashed history
        let crashedHistory = loadCrashedHistory()
        if crashedHistory.contains(bundleId) {
            NSLog("[BundleStorage] Bundle '\(bundleId)' is in crashed history, rejecting update")
            completion(.failure(BundleStorageError.bundleInCrashedHistory(bundleId)))
            return
        }

        // Get the current bundle ID from the cached bundle URL (exclude fallback bundles)
        let currentBundleId = self.getCachedBundleURL()?.deletingLastPathComponent().lastPathComponent

        guard let validFileUrl = fileUrl else {
            NSLog("[BundleStorage] fileUrl is nil, resetting bundle URL.")
            // Dispatch the sequence to the file operation queue to ensure completion is called asynchronously
            // and to keep file operations off the calling thread if it's the main thread.
            fileOperationQueue.async {
                let setResult = self.setBundleURL(localPath: nil)
                switch setResult {
                case .success:
                    let cleanupResult = self.cleanupOldBundles(currentBundleId: currentBundleId, bundleId: bundleId)
                    switch cleanupResult {
                    case .success:
                        completion(.success(true))
                    case .failure(let error):
                        NSLog("[BundleStorage] Error during cleanup after reset: \(error)")
                        completion(.failure(error))
                    }
                case .failure(let error):
                    NSLog("[BundleStorage] Error resetting bundle URL: \(error)")
                    completion(.failure(error))
                }
            }
            return
        }
        
        // Start the bundle update process on a background queue
        fileOperationQueue.async {

            let storeDirResult = self.bundleStoreDir()
            guard case .success(let storeDir) = storeDirResult else {
                completion(.failure(storeDirResult.failureError ?? BundleStorageError.unknown(nil)))
                return
            }
            
            let finalBundleDir = (storeDir as NSString).appendingPathComponent(bundleId)
            
            if self.fileSystem.fileExists(atPath: finalBundleDir) {
                let findResult = self.findBundleFile(in: finalBundleDir)
                switch findResult {
                case .success(let existingBundlePath):
                    if let bundlePath = existingBundlePath {
                        NSLog("[BundleStorage] Using cached bundle at path: \(bundlePath)")
                        let setResult = self.setBundleURL(localPath: bundlePath)
                        switch setResult {
                        case .success:
                            // Set staging metadata for rollback support
                            var metadata = self.loadMetadataOrNull() ?? BundleMetadata()
                            metadata.stagingBundleId = bundleId
                            metadata.verificationPending = true
                            metadata.verificationAttemptedAt = nil
                            metadata.stagingExecutionCount = 0
                            metadata.updatedAt = Date().timeIntervalSince1970 * 1000
                            let _ = self.saveMetadata(metadata)
                            NSLog("[BundleStorage] Set staging bundle (cached): \(bundleId), verificationPending: true")

                            // Clean up old bundles, preserving stable and new staging
                            let stableId = metadata.stableBundleId
                            let bundleIdsToKeep = [stableId, bundleId].compactMap { $0 }
                            if bundleIdsToKeep.count > 0 {
                                let _ = self.cleanupOldBundles(currentBundleId: bundleIdsToKeep.first, bundleId: bundleIdsToKeep.count > 1 ? bundleIdsToKeep[1] : nil)
                            }

                            completion(.success(true))
                        case .failure(let error):
                            completion(.failure(error))
                        }
                        return
                    } else {
                        NSLog("[BundleStorage] Cached directory exists but invalid, removing: \(finalBundleDir)")
                        do {
                            try self.fileSystem.removeItem(atPath: finalBundleDir)
                            // Continue with download process on success
                            self.prepareAndDownloadBundle(bundleId: bundleId, fileUrl: validFileUrl, fileHash: fileHash, storeDir: storeDir, progressHandler: progressHandler, completion: completion)
                        } catch let error {
                            NSLog("[BundleStorage] Failed to remove invalid bundle dir: \(error.localizedDescription)")
                            completion(.failure(BundleStorageError.unknown(error)))
                        }
                    }
                case .failure(let error):
                    completion(.failure(error))
                }
            } else {
                self.prepareAndDownloadBundle(bundleId: bundleId, fileUrl: validFileUrl, fileHash: fileHash, storeDir: storeDir, progressHandler: progressHandler, completion: completion)
            }
        }
    }
    
    /**
     * Prepares directories and starts the download process.
     * This method is part of the asynchronous `updateBundle` flow.
     * @param bundleId ID of the bundle to update
     * @param fileUrl URL of the bundle file to download
     * @param fileHash Combined hash string for verification (sig:<signature> or <hex_hash>)
     * @param storeDir Path to the bundle-store directory
     * @param progressHandler Callback for download and extraction progress
     * @param completion Callback with result of the operation
     */
    private func prepareAndDownloadBundle(
        bundleId: String,
        fileUrl: URL,
        fileHash: String?,
        storeDir: String,
        progressHandler: @escaping (Double) -> Void,
        completion: @escaping (Result<Bool, Error>) -> Void
    ) {
        // 1) Prepare temp directory for download
        let tempDirResult = tempDir()
        guard case .success(let tempDirectory) = tempDirResult else {
            completion(.failure(tempDirResult.failureError ?? BundleStorageError.unknown(nil)))
            return
        }
        
        // 2) Clean up any previous temp dir
        try? self.fileSystem.removeItem(atPath: tempDirectory)
        
        // 3) Create temp dir
        if !self.fileSystem.createDirectory(atPath: tempDirectory) {
            completion(.failure(BundleStorageError.directoryCreationFailed))
            return
        }

        // 4) Determine bundle filename from URL
        let bundleFileName = fileUrl.lastPathComponent.isEmpty ? "bundle.zip" : fileUrl.lastPathComponent
        let tempBundleFile = (tempDirectory as NSString).appendingPathComponent(bundleFileName)

        NSLog("[BundleStorage] Checking file size and disk space...")

        // 5) Check file size and disk space before download
        self.downloadService.getFileSize(from: fileUrl) { [weak self] sizeResult in
            guard let self = self else { return }

            if case .success(let fileSize) = sizeResult {
                // Check available disk space
                do {
                    let attributes = try FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory())
                    if let freeSize = attributes[.systemFreeSize] as? Int64 {
                        let requiredSpace = fileSize * 2  // ZIP + extracted files

                        NSLog("[BundleStorage] File size: \(fileSize) bytes, Available: \(freeSize) bytes, Required: \(requiredSpace) bytes")

                        if freeSize < requiredSpace {
                            NSLog("[BundleStorage] Insufficient disk space")
                            self.cleanupTemporaryFiles([tempDirectory])
                            completion(.failure(BundleStorageError.insufficientDiskSpace))
                            return
                        }
                    }
                } catch {
                    NSLog("[BundleStorage] Failed to check disk space: \(error.localizedDescription)")
                    // Continue with download despite disk check failure
                }
            } else {
                NSLog("[BundleStorage] Unable to determine file size, proceeding with download")
            }

            NSLog("[BundleStorage] Starting download from \(fileUrl)")

            // 6) DownloadService handles its own threading for the download task.
            // The completion handler for downloadService.downloadFile is then dispatched to fileOperationQueue.
            let task = self.downloadService.downloadFile(from: fileUrl,
                                                         to: tempBundleFile,
                                                         progressHandler: { downloadProgress in
                                                             // Map download progress to 0.0 - 0.8
                                                             progressHandler(downloadProgress * 0.8)
                                                         },
                                                         completion: { [weak self] result in
            guard let self = self else {
                let error = NSError(domain: "HotUpdaterError", code: 998,
                                    userInfo: [NSLocalizedDescriptionKey: "Self deallocated during download"])
                completion(.failure(error))
                return
            }

            // Dispatch the processing of the downloaded file to the file operation queue
            let workItem = DispatchWorkItem {
                switch result {
                case .success(let location):
                    self.processDownloadedFileWithTmp(location: location,
                                                      tempBundleFile: tempBundleFile,
                                                      fileHash: fileHash,
                                                      storeDir: storeDir,
                                                      bundleId: bundleId,
                                                      tempDirectory: tempDirectory,
                                                      progressHandler: progressHandler,
                                                      completion: completion)
                case .failure(let error):
                    NSLog("[BundleStorage] Download failed: \(error.localizedDescription)")
                    self.cleanupTemporaryFiles([tempDirectory]) // Sync cleanup

                    // Map DownloadError.incompleteDownload to BundleStorageError.incompleteDownload
                    if let downloadError = error as? DownloadError,
                       case .incompleteDownload(let expected, let actual) = downloadError {
                        completion(.failure(BundleStorageError.incompleteDownload(expected: expected, actual: actual)))
                    } else {
                        completion(.failure(BundleStorageError.downloadFailed(error)))
                    }
                }
            }
            self.fileOperationQueue.async(execute: workItem)
        })

            if let task = task {
                self.activeTasks.append(task) // Manage active tasks
            }
        }
    }
    
    /**
     * Logs detailed diagnostic information about a file system path.
     * @param path The path to diagnose
     * @param context Additional context for logging
     */
    private func logFileSystemDiagnostics(path: String, context: String) {
        let fileManager = FileManager.default

        // Check if path exists
        let exists = fileManager.fileExists(atPath: path)
        NSLog("[BundleStorage] [\(context)] Path exists: \(exists) - \(path)")

        if exists {
            do {
                let attributes = try fileManager.attributesOfItem(atPath: path)
                let size = attributes[.size] as? Int64 ?? 0
                let permissions = attributes[.posixPermissions] as? Int ?? 0
                NSLog("[BundleStorage] [\(context)] Size: \(size) bytes, Permissions: \(String(permissions, radix: 8))")
            } catch {
                NSLog("[BundleStorage] [\(context)] Failed to get attributes: \(error.localizedDescription)")
            }
        }

        // Check parent directory
        let parentPath = (path as NSString).deletingLastPathComponent
        let parentExists = fileManager.fileExists(atPath: parentPath)
        NSLog("[BundleStorage] [\(context)] Parent directory exists: \(parentExists) - \(parentPath)")
    }

    /**
     * Processes a downloaded bundle file using the "tmp" rename approach.
     * This method is part of the asynchronous `updateBundle` flow and is expected to run on a background thread.
     * @param location URL of the downloaded file
     * @param tempBundleFile Path to store the downloaded bundle file
     * @param fileHash Combined hash string for verification (sig:<signature> or <hex_hash>)
     * @param storeDir Path to the bundle-store directory
     * @param bundleId ID of the bundle being processed
     * @param tempDirectory Temporary directory for processing
     * @param progressHandler Callback for extraction progress (0.8 to 1.0)
     * @param completion Callback with result of the operation
     */
    private func processDownloadedFileWithTmp(
        location: URL,
        tempBundleFile: String,
        fileHash: String?,
        storeDir: String,
        bundleId: String,
        tempDirectory: String,
        progressHandler: @escaping (Double) -> Void,
        completion: @escaping (Result<Bool, Error>) -> Void
    ) {
        let currentBundleId = self.getCachedBundleURL()?.deletingLastPathComponent().lastPathComponent
        NSLog("[BundleStorage] Processing downloaded file atPath: \(location.path)")

        // 1) Ensure the bundle file exists
        guard self.fileSystem.fileExists(atPath: location.path) else {
            logFileSystemDiagnostics(path: location.path, context: "Download Location Missing")
            self.cleanupTemporaryFiles([tempDirectory])
            completion(.failure(BundleStorageError.downloadFailed(NSError(
                domain: "HotUpdaterError",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Downloaded file does not exist atPath: \(location.path)"]
            ))))
            return
        }

        // 2) Define tmpDir and realDir
        let tmpDir = (storeDir as NSString).appendingPathComponent("\(bundleId).tmp")
        let realDir = (storeDir as NSString).appendingPathComponent(bundleId)

        do {
            // 3) Remove any existing tmpDir
            if self.fileSystem.fileExists(atPath: tmpDir) {
                try self.fileSystem.removeItem(atPath: tmpDir)
                NSLog("[BundleStorage] Removed existing tmpDir: \(tmpDir)")
            }

            // 4) Create tmpDir
            try self.fileSystem.createDirectory(atPath: tmpDir)
            NSLog("[BundleStorage] Created tmpDir: \(tmpDir)")
            logFileSystemDiagnostics(path: tmpDir, context: "TmpDir Created")

            // 5) Verify bundle integrity (hash or signature based on fileHash format)
            NSLog("[BundleStorage] Verifying bundle integrity...")
            let tempBundleURL = URL(fileURLWithPath: tempBundleFile)
            let verificationResult = SignatureVerifier.verifyBundle(fileURL: tempBundleURL, fileHash: fileHash)
            switch verificationResult {
            case .success:
                NSLog("[BundleStorage] Bundle verification completed successfully")
            case .failure(let error):
                NSLog("[BundleStorage] Bundle verification failed: \(error)")
                try? self.fileSystem.removeItem(atPath: tmpDir)
                self.cleanupTemporaryFiles([tempDirectory])
                completion(.failure(BundleStorageError.signatureVerificationFailed(error)))
                return
            }

            // 6) Unzip directly into tmpDir with progress tracking (0.8 - 1.0)
            NSLog("[BundleStorage] Extracting \(tempBundleFile) → \(tmpDir)")
            logFileSystemDiagnostics(path: tempBundleFile, context: "Before Extraction")
            do {
                try self.decompressService.unzip(file: tempBundleFile, to: tmpDir, progressHandler: { unzipProgress in
                    // Map unzip progress (0.0 - 1.0) to overall progress (0.8 - 1.0)
                    progressHandler(0.8 + (unzipProgress * 0.2))
                })
                NSLog("[BundleStorage] Extraction complete at \(tmpDir)")
                logFileSystemDiagnostics(path: tmpDir, context: "After Extraction")
            } catch {
                let nsError = error as NSError
                NSLog("[BundleStorage] Extraction failed - Domain: \(nsError.domain), Code: \(nsError.code), Description: \(nsError.localizedDescription)")
                logFileSystemDiagnostics(path: tmpDir, context: "Extraction Failed")
                try? self.fileSystem.removeItem(atPath: tmpDir)
                self.cleanupTemporaryFiles([tempDirectory])
                completion(.failure(BundleStorageError.extractionFormatError(error)))
                return
            }

            // 7) Remove the downloaded bundle file
            try? self.fileSystem.removeItem(atPath: tempBundleFile)

            // 8) Verify that a valid bundle file exists inside tmpDir
            switch self.findBundleFile(in: tmpDir) {
            case .success(let maybeBundlePath):
                if let bundlePathInTmp = maybeBundlePath {
                    NSLog("[BundleStorage] Found valid bundle in tmpDir: \(bundlePathInTmp)")
                    logFileSystemDiagnostics(path: bundlePathInTmp, context: "Bundle Found")

                    // 9) Remove any existing realDir
                    if self.fileSystem.fileExists(atPath: realDir) {
                        try self.fileSystem.removeItem(atPath: realDir)
                        NSLog("[BundleStorage] Removed existing realDir: \(realDir)")
                    }

                    // 10) Rename (move) tmpDir → realDir
                    do {
                        try self.fileSystem.moveItem(atPath: tmpDir, toPath: realDir)
                        NSLog("[BundleStorage] Renamed tmpDir to realDir: \(realDir)")
                        logFileSystemDiagnostics(path: realDir, context: "After Move")
                    } catch {
                        let nsError = error as NSError
                        NSLog("[BundleStorage] Move operation failed - Domain: \(nsError.domain), Code: \(nsError.code), Description: \(nsError.localizedDescription)")
                        logFileSystemDiagnostics(path: tmpDir, context: "Move Failed - Source")
                        logFileSystemDiagnostics(path: realDir, context: "Move Failed - Destination")
                        throw BundleStorageError.moveOperationFailed(error)
                    }

                    // 11) Construct final bundlePath for preferences
                    let finalBundlePath = (realDir as NSString).appendingPathComponent((bundlePathInTmp as NSString).lastPathComponent)

                    // 12) Set the bundle URL in preferences (for backwards compatibility)
                    let setResult = self.setBundleURL(localPath: finalBundlePath)
                    switch setResult {
                    case .success:
                        NSLog("[BundleStorage] Successfully set bundle URL: \(finalBundlePath)")

                        // 13) Set staging metadata for rollback support
                        var metadata = self.loadMetadataOrNull() ?? BundleMetadata()
                        metadata.stagingBundleId = bundleId
                        metadata.verificationPending = true
                        metadata.verificationAttemptedAt = nil
                        metadata.stagingExecutionCount = 0
                        metadata.updatedAt = Date().timeIntervalSince1970 * 1000
                        let _ = self.saveMetadata(metadata)
                        NSLog("[BundleStorage] Set staging bundle: \(bundleId), verificationPending: true")

                        // 14) Clean up the temporary directory
                        self.cleanupTemporaryFiles([tempDirectory])

                        // 15) Clean up old bundles, preserving current, stable, and new staging
                        let stableId = metadata.stableBundleId
                        let bundleIdsToKeep = [stableId, bundleId].compactMap { $0 }
                        if bundleIdsToKeep.count > 0 {
                            let _ = self.cleanupOldBundles(currentBundleId: bundleIdsToKeep.first, bundleId: bundleIdsToKeep.count > 1 ? bundleIdsToKeep[1] : nil)
                        }

                        // 16) Complete with success
                        completion(.success(true))
                    case .failure(let err):
                        let nsError = err as NSError
                        NSLog("[BundleStorage] Failed to set bundle URL - Domain: \(nsError.domain), Code: \(nsError.code), Description: \(nsError.localizedDescription)")
                        // Preferences save failed → remove realDir and clean up
                        try? self.fileSystem.removeItem(atPath: realDir)
                        self.cleanupTemporaryFiles([tempDirectory])
                        completion(.failure(err))
                    }
                } else {
                    // No valid .jsbundle found → delete tmpDir and fail
                    NSLog("[BundleStorage] No valid bundle file found in tmpDir")
                    logFileSystemDiagnostics(path: tmpDir, context: "Invalid Bundle")
                    try? self.fileSystem.removeItem(atPath: tmpDir)
                    self.cleanupTemporaryFiles([tempDirectory])
                    completion(.failure(BundleStorageError.invalidBundle))
                }
            case .failure(let findError):
                let nsError = findError as NSError
                NSLog("[BundleStorage] Error finding bundle file - Domain: \(nsError.domain), Code: \(nsError.code), Description: \(nsError.localizedDescription)")
                // Error scanning tmpDir → delete tmpDir and fail
                try? self.fileSystem.removeItem(atPath: tmpDir)
                self.cleanupTemporaryFiles([tempDirectory])
                completion(.failure(findError))
            }
        } catch let error {
            // Any failure during unzip or rename → clean tmpDir and fail
            let nsError = error as NSError
            NSLog("[BundleStorage] Error during tmpDir processing - Domain: \(nsError.domain), Code: \(nsError.code), Description: \(nsError.localizedDescription)")
            logFileSystemDiagnostics(path: tmpDir, context: "Processing Error")
            try? self.fileSystem.removeItem(atPath: tmpDir)
            self.cleanupTemporaryFiles([tempDirectory])

            // Re-throw specific BundleStorageError if it is one, otherwise wrap as unknown
            if let bundleError = error as? BundleStorageError {
                completion(.failure(bundleError))
            } else {
                completion(.failure(BundleStorageError.unknown(error)))
            }
        }
    }

    // MARK: - Rollback Support

    /**
     * Notifies the system that the app has successfully started with the given bundle.
     * If the bundle matches the staging bundle, promotes it to stable.
     * @param bundleId The ID of the currently running bundle
     * @return true if promotion was successful or no action was needed
     */
    func notifyAppReady(bundleId: String) -> [String: Any] {
        NSLog("[BundleStorage('\(id)'] notifyAppReady: Called with bundleId '\(bundleId)'")
        guard var metadata = loadMetadataOrNull() else {
            // No metadata exists - legacy mode, nothing to do
            NSLog("[BundleStorage] notifyAppReady: No metadata exists (legacy mode)")
            return ["status": "STABLE"]
        }

        // Check if there was a recent rollback (session variable)
        if let crashedBundleId = self.sessionRollbackBundleId {
            NSLog("[BundleStorage] notifyAppReady: Detected rollback recovery from '\(crashedBundleId)'")

            // Clear rollback info (one-time read)
            self.sessionRollbackBundleId = nil

            return [
                "status": "RECOVERED",
                "crashedBundleId": crashedBundleId
            ]
        }

        // Check if the bundle matches the staging bundle (promotion case)
        if let stagingId = metadata.stagingBundleId, stagingId == bundleId, metadata.verificationPending {
            NSLog("[BundleStorage] notifyAppReady: Bundle '\(bundleId)' matches staging, promoting to stable")
            promoteStagingToStable()
            return ["status": "PROMOTED"]
        }

        // Check if the bundle matches the stable bundle
        if let stableId = metadata.stableBundleId, stableId == bundleId {
            // Already stable, clear any pending verification state
            if metadata.verificationPending {
                metadata.verificationPending = false
                metadata.verificationAttemptedAt = nil
                metadata.updatedAt = Date().timeIntervalSince1970 * 1000
                let _ = saveMetadata(metadata)
                NSLog("[BundleStorage] notifyAppReady: Bundle '\(bundleId)' is stable, cleared pending verification")
            } else {
                NSLog("[BundleStorage] notifyAppReady: Bundle '\(bundleId)' is already stable")
            }
            return ["status": "STABLE"]
        }

        // Bundle doesn't match staging or stable - might be fallback or unknown
        NSLog("[BundleStorage] notifyAppReady: Bundle '\(bundleId)' doesn't match staging or stable")
        return ["status": "STABLE"]
    }

    /**
     * Returns the crashed bundle history.
     * @return The crashed history object
     */
    func getCrashHistory() -> CrashedHistory {
        return loadCrashedHistory()
    }

    /**
     * Clears the crashed bundle history.
     * @return true if clearing was successful
     */
    func clearCrashHistory() -> Bool {
        var history = loadCrashedHistory()
        history.clear()
        return saveCrashedHistory(history)
    }
}

// Helper to get the associated error from a Result, if it's a failure
extension Result {
    var failureError: Failure? {
        guard case .failure(let error) = self else { return nil }
        return error
    }
}
