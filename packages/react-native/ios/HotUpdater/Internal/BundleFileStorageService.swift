import Foundation

public enum BundleStorageError: Error, CustomNSError {
    case bundleNotFound
    case directoryCreationFailed
    case downloadFailed(Error)
    case extractionFailed(Error)
    case invalidBundle
    case invalidZipFile
    case insufficientDiskSpace
    case hashMismatch
    case moveOperationFailed(Error)
    case copyOperationFailed(Error)
    case fileSystemError(Error)
    case incompleteDownload(expected: Int64, actual: Int64)
    case unknown(Error?)

    // CustomNSError protocol implementation
    public static var errorDomain: String {
        return "com.hotupdater.BundleStorageError"
    }

    public var errorCode: Int {
        switch self {
        case .bundleNotFound: return 1001
        case .directoryCreationFailed: return 1002
        case .downloadFailed: return 1003
        case .extractionFailed: return 1004
        case .invalidBundle: return 1005
        case .invalidZipFile: return 1006
        case .insufficientDiskSpace: return 1007
        case .hashMismatch: return 1008
        case .moveOperationFailed: return 1009
        case .copyOperationFailed: return 1010
        case .fileSystemError: return 1011
        case .incompleteDownload: return 1012
        case .unknown: return 1099
        }
    }

    public var errorUserInfo: [String: Any] {
        var userInfo: [String: Any] = [:]

        switch self {
        case .bundleNotFound:
            userInfo[NSLocalizedDescriptionKey] = "Bundle file not found in the downloaded archive"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "Ensure the bundle archive contains index.ios.bundle or main.jsbundle"

        case .directoryCreationFailed:
            userInfo[NSLocalizedDescriptionKey] = "Failed to create required directory for bundle storage"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "Check app permissions and available disk space"

        case .downloadFailed(let underlyingError):
            userInfo[NSLocalizedDescriptionKey] = "Failed to download bundle from server"
            userInfo[NSUnderlyingErrorKey] = underlyingError
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "Check network connection and try again"

        case .extractionFailed(let underlyingError):
            userInfo[NSLocalizedDescriptionKey] = "Failed to extract bundle archive"
            userInfo[NSUnderlyingErrorKey] = underlyingError
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "The downloaded file may be corrupted. Try downloading again"

        case .invalidBundle:
            userInfo[NSLocalizedDescriptionKey] = "Downloaded archive does not contain a valid React Native bundle"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "Verify the bundle was built correctly with metro bundler"

        case .invalidZipFile:
            userInfo[NSLocalizedDescriptionKey] = "Downloaded file is not a valid ZIP archive"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "The file may be corrupted during download"

        case .insufficientDiskSpace:
            userInfo[NSLocalizedDescriptionKey] = "Insufficient disk space to download and extract bundle"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "Free up device storage and try again"

        case .hashMismatch:
            userInfo[NSLocalizedDescriptionKey] = "Downloaded bundle hash does not match expected hash"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "The file may have been corrupted or tampered with. Try downloading again"

        case .moveOperationFailed(let underlyingError):
            userInfo[NSLocalizedDescriptionKey] = "Failed to move bundle to final location"
            userInfo[NSUnderlyingErrorKey] = underlyingError
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "Check file system permissions"

        case .copyOperationFailed(let underlyingError):
            userInfo[NSLocalizedDescriptionKey] = "Failed to copy bundle files"
            userInfo[NSUnderlyingErrorKey] = underlyingError
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "Check available disk space and permissions"

        case .fileSystemError(let underlyingError):
            userInfo[NSLocalizedDescriptionKey] = "File system operation failed"
            userInfo[NSUnderlyingErrorKey] = underlyingError
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "Check app permissions and disk space"

        case .incompleteDownload(let expected, let actual):
            userInfo[NSLocalizedDescriptionKey] = "Download incomplete: received \(actual) bytes but expected \(expected) bytes"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "The download may have been interrupted by iOS due to low memory or battery. Please ensure the app stays in foreground during update and try again"
            userInfo["expectedBytes"] = expected
            userInfo["actualBytes"] = actual

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
}

class BundleFileStorageService: BundleStorageService {
    private let fileSystem: FileSystemService
    private let downloadService: DownloadService
    private let decompressService: DecompressService
    private let preferences: PreferencesService

    // Queue for potentially long-running sequences within updateBundle or for explicit background tasks.
    private let fileOperationQueue: DispatchQueue

    private var activeTasks: [URLSessionTask] = []

    public init(fileSystem: FileSystemService,
                downloadService: DownloadService,
                decompressService: DecompressService,
                preferences: PreferencesService) {

        self.fileSystem = fileSystem
        self.downloadService = downloadService
        self.decompressService = decompressService
        self.preferences = preferences

        self.fileOperationQueue = DispatchQueue(label: "com.hotupdater.fileoperations",
                                               qos: .utility,
                                               attributes: .concurrent)
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
            return .failure(BundleStorageError.fileSystemError(error))
        }
        
        let bundles = contents.compactMap { item -> String? in
            let fullPath = (storeDir as NSString).appendingPathComponent(item)
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
        return getCachedBundleURL() ?? getFallbackBundleURL()
    }
    
    // MARK: - Bundle Update
    
    /**
     * Updates the bundle from the specified URL. This operation is asynchronous.
     * @param bundleId ID of the bundle to update
     * @param fileUrl URL of the bundle file to download (or nil to reset)
     * @param fileHash SHA256 hash of the bundle file for verification (nullable)
     * @param progressHandler Callback for download and extraction progress (0.0 to 1.0)
     * @param completion Callback with result of the operation
     */
    func updateBundle(bundleId: String, fileUrl: URL?, fileHash: String?, progressHandler: @escaping (Double) -> Void, completion: @escaping (Result<Bool, Error>) -> Void) {
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
                        do {
                            let setResult = self.setBundleURL(localPath: bundlePath)
                            switch setResult {
                            case .success:
                                let cleanupResult = self.cleanupOldBundles(currentBundleId: currentBundleId, bundleId: bundleId)
                                switch cleanupResult {
                                case .success:
                                    completion(.success(true))
                                case .failure(let error):
                                    NSLog("[BundleStorage] Warning: Cleanup failed but bundle is set: \(error)")
                                    completion(.failure(error))
                                }
                            case .failure(let error):
                                completion(.failure(error))
                            }
                        } catch let error {
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
                            completion(.failure(BundleStorageError.fileSystemError(error)))
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
     * @param fileHash SHA256 hash of the bundle file for verification (nullable)
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

                    // Check for specific download errors
                    if let downloadError = error as? DownloadError {
                        switch downloadError {
                        case .incompleteDownload(let expected, let actual):
                            NSLog("[BundleStorage] Incomplete download detected: \(actual)/\(expected) bytes")
                            completion(.failure(BundleStorageError.incompleteDownload(expected: expected, actual: actual)))
                            return
                        case .invalidContentLength:
                            break  // Fall through to generic downloadFailed
                        }
                    }
                    completion(.failure(BundleStorageError.downloadFailed(error)))
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
     * @param fileHash SHA256 hash of the bundle file for verification (nullable)
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

        // 1) Ensure the bundle file exists and has content
        guard self.fileSystem.fileExists(atPath: location.path) else {
            logFileSystemDiagnostics(path: location.path, context: "Download Location Missing")
            self.cleanupTemporaryFiles([tempDirectory])
            completion(.failure(BundleStorageError.fileSystemError(NSError(
                domain: "HotUpdaterError",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Source file does not exist atPath: \(location.path)"]
            ))))
            return
        }

        // 1.1) Verify file size is not zero (detect truncated downloads)
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: location.path)
            let fileSize = attributes[.size] as? Int64 ?? 0
            NSLog("[BundleStorage] Downloaded file size: \(fileSize) bytes")

            if fileSize == 0 {
                NSLog("[BundleStorage] Downloaded file is empty")
                self.cleanupTemporaryFiles([tempDirectory])
                completion(.failure(BundleStorageError.incompleteDownload(expected: -1, actual: 0)))
                return
            }
        } catch {
            NSLog("[BundleStorage] Failed to get file attributes: \(error.localizedDescription)")
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

            // 5) Verify file hash if provided
            if let expectedHash = fileHash {
                NSLog("[BundleStorage] Verifying file hash...")
                let tempBundleURL = URL(fileURLWithPath: tempBundleFile)
                guard HashUtils.verifyHash(fileURL: tempBundleURL, expectedHash: expectedHash) else {
                    NSLog("[BundleStorage] Hash mismatch!")
                    try? self.fileSystem.removeItem(atPath: tmpDir)
                    self.cleanupTemporaryFiles([tempDirectory])
                    completion(.failure(BundleStorageError.hashMismatch))
                    return
                }
                NSLog("[BundleStorage] Hash verification passed")
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
                completion(.failure(BundleStorageError.extractionFailed(error)))
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

                    // 12) Set the bundle URL in preferences
                    let setResult = self.setBundleURL(localPath: finalBundlePath)
                    switch setResult {
                    case .success:
                        NSLog("[BundleStorage] Successfully set bundle URL: \(finalBundlePath)")
                        // 13) Clean up the temporary directory
                        self.cleanupTemporaryFiles([tempDirectory])

                        // 14) Clean up old bundles, preserving current and latest
                        let _ = self.cleanupOldBundles(currentBundleId: currentBundleId, bundleId: bundleId)

                        // 15) Complete with success
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
            completion(.failure(BundleStorageError.fileSystemError(error)))
        }
    }
}

// Helper to get the associated error from a Result, if it's a failure
extension Result {
    var failureError: Failure? {
        guard case .failure(let error) = self else { return nil }
        return error
    }
}
