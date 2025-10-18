import Foundation

public enum BundleStorageError: Error {
    case bundleNotFound
    case directoryCreationFailed
    case downloadFailed(Error)
    case extractionFailed(Error)
    case invalidBundle
    case moveOperationFailed(Error)
    case copyOperationFailed(Error)
    case fileSystemError(Error)
    case unknown(Error?)
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
    func updateBundle(bundleId: String, fileUrl: URL?, completion: @escaping (Result<Bool, Error>) -> Void)
}

class BundleFileStorageService: BundleStorageService {
    private let fileSystem: FileSystemService
    private let downloadService: DownloadService
    private let unzipService: UnzipService?
    private let preferences: PreferencesService

    // Queue for potentially long-running sequences within updateBundle or for explicit background tasks.
    private let fileOperationQueue: DispatchQueue

    private var activeTasks: [URLSessionTask] = []

    public init(fileSystem: FileSystemService,
                downloadService: DownloadService,
                unzipService: UnzipService,
                preferences: PreferencesService) {

        self.fileSystem = fileSystem
        self.downloadService = downloadService
        self.unzipService = unzipService
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
     * @param completion Callback with result of the operation
     */
    func updateBundle(bundleId: String, fileUrl: URL?, completion: @escaping (Result<Bool, Error>) -> Void) {
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
                            self.prepareAndDownloadBundle(bundleId: bundleId, fileUrl: validFileUrl, storeDir: storeDir, completion: completion)
                        } catch let error {
                            NSLog("[BundleStorage] Failed to remove invalid bundle dir: \(error.localizedDescription)")
                            completion(.failure(BundleStorageError.fileSystemError(error)))
                        }
                    }
                case .failure(let error):
                    completion(.failure(error))
                }
            } else {
                self.prepareAndDownloadBundle(bundleId: bundleId, fileUrl: validFileUrl, storeDir: storeDir, completion: completion)
            }
        }
    }
    
    /**
     * Prepares directories and starts the download process.
     * This method is part of the asynchronous `updateBundle` flow.
     * @param bundleId ID of the bundle to update
     * @param fileUrl URL of the bundle file to download
     * @param storeDir Path to the bundle-store directory
     * @param completion Callback with result of the operation
     */
    private func prepareAndDownloadBundle(
        bundleId: String,
        fileUrl: URL,
        storeDir: String,
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
        
        // 4) Define paths for compressed bundle file
        let tempZipFile = (tempDirectory as NSString).appendingPathComponent("bundle.zip")
        
        NSLog("[BundleStorage] Starting download from \(fileUrl)")
        
        // 5) DownloadService handles its own threading for the download task.
        // The completion handler for downloadService.downloadFile is then dispatched to fileOperationQueue.
        let task = self.downloadService.downloadFile(from: fileUrl,
                                                     to: tempZipFile,
                                                     progressHandler: { _ in
                                                         // Progress updates handled by notification system
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
                                                      tempZipFile: tempZipFile,
                                                      storeDir: storeDir,
                                                      bundleId: bundleId,
                                                      tempDirectory: tempDirectory,
                                                      completion: completion)
                case .failure(let error):
                    NSLog("[BundleStorage] Download failed: \(error.localizedDescription)")
                    self.cleanupTemporaryFiles([tempDirectory]) // Sync cleanup
                    completion(.failure(BundleStorageError.downloadFailed(error)))
                }
            }
            self.fileOperationQueue.async(execute: workItem)
        })
        
        if let task = task {
            self.activeTasks.append(task) // Manage active tasks
        }
    }
    
    /**
     * Processes a downloaded bundle file using the "tmp" rename approach.
     * This method is part of the asynchronous `updateBundle` flow and is expected to run on a background thread.
     * @param location URL of the downloaded file
     * @param tempZipFile Path to store the downloaded zip file
     * @param storeDir Path to the bundle-store directory
     * @param bundleId ID of the bundle being processed
     * @param tempDirectory Temporary directory for processing
     * @param completion Callback with result of the operation
     */
    private func processDownloadedFileWithTmp(
        location: URL,
        tempZipFile: String,
        storeDir: String,
        bundleId: String,
        tempDirectory: String,
        completion: @escaping (Result<Bool, Error>) -> Void
    ) {
        let currentBundleId = self.getCachedBundleURL()?.deletingLastPathComponent().lastPathComponent
        NSLog("[BundleStorage] Processing downloaded file atPath: \(location.path)")
        
        // 1) Ensure the compressed bundle file exists
        guard self.fileSystem.fileExists(atPath: location.path) else {
            self.cleanupTemporaryFiles([tempDirectory])
            completion(.failure(BundleStorageError.fileSystemError(NSError(
                domain: "HotUpdaterError",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Source file does not exist atPath: \(location.path)"]
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
            
            // 5) Detect compression format and unzip directly into tmpDir
            NSLog("[BundleStorage] Detecting compression format for \(tempZipFile)")
            let unzipService = self.unzipService ?? CompressionFormatDetector.createUnzipService(forFile: tempZipFile)
            NSLog("[BundleStorage] Unzipping \(tempZipFile) → \(tmpDir)")
            try unzipService.unzip(file: tempZipFile, to: tmpDir)
            NSLog("[BundleStorage] Unzip complete at \(tmpDir)")
            
            // 6) Remove the downloaded compressed bundle file
            try? self.fileSystem.removeItem(atPath: tempZipFile)
            
            // 7) Verify that a valid bundle file exists inside tmpDir
            switch self.findBundleFile(in: tmpDir) {
            case .success(let maybeBundlePath):
                if let bundlePathInTmp = maybeBundlePath {
                    // 8) Remove any existing realDir
                    if self.fileSystem.fileExists(atPath: realDir) {
                        try self.fileSystem.removeItem(atPath: realDir)
                        NSLog("[BundleStorage] Removed existing realDir: \(realDir)")
                    }
                    
                    // 9) Rename (move) tmpDir → realDir
                    try self.fileSystem.moveItem(atPath: tmpDir, toPath: realDir)
                    NSLog("[BundleStorage] Renamed tmpDir to realDir: \(realDir)")
                    
                    // 10) Construct final bundlePath for preferences
                    let finalBundlePath = (realDir as NSString).appendingPathComponent((bundlePathInTmp as NSString).lastPathComponent)
                    
                    // 11) Set the bundle URL in preferences
                    let setResult = self.setBundleURL(localPath: finalBundlePath)
                    switch setResult {
                    case .success:
                        // 12) Clean up the temporary directory
                        self.cleanupTemporaryFiles([tempDirectory])
                        
                        // 13) Clean up old bundles, preserving current and latest
                        let _ = self.cleanupOldBundles(currentBundleId: currentBundleId, bundleId: bundleId)
                        
                        // 14) Complete with success
                        completion(.success(true))
                    case .failure(let err):
                        // Preferences save failed → remove realDir and clean up
                        try? self.fileSystem.removeItem(atPath: realDir)
                        self.cleanupTemporaryFiles([tempDirectory])
                        completion(.failure(err))
                    }
                } else {
                    // No valid .jsbundle found → delete tmpDir and fail
                    try? self.fileSystem.removeItem(atPath: tmpDir)
                    self.cleanupTemporaryFiles([tempDirectory])
                    completion(.failure(BundleStorageError.invalidBundle))
                }
            case .failure(let findError):
                // Error scanning tmpDir → delete tmpDir and fail
                try? self.fileSystem.removeItem(atPath: tmpDir)
                self.cleanupTemporaryFiles([tempDirectory])
                completion(.failure(findError))
            }
        } catch let error {
            // Any failure during unzip or rename → clean tmpDir and fail
            NSLog("[BundleStorage] Error during tmpDir processing: \(error)")
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
