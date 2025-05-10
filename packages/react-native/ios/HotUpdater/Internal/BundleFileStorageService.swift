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
    func getBundleURL() -> URL
    
    // Bundle update
    func updateBundle(bundleId: String, fileUrl: URL?, completion: @escaping (Result<Bool, Error>) -> Void)
}

class BundleFileStorageService: BundleStorageService {
    private let fileSystem: FileSystemService
    private let downloadService: DownloadService
    private let unzipService: UnzipService
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
     * Cleans up old bundles, keeping only the current and latest bundles.
     * Executes synchronously on the calling thread.
     * @param currentBundleId ID of the current active bundle (optional)
     * @return Result of operation
     */
    func cleanupOldBundles(currentBundleId: String?) -> Result<Void, Error> {
        let storeDirResult = bundleStoreDir()
        
        guard case .success(let storeDir) = storeDirResult else {
            return .failure(storeDirResult.failureError ?? BundleStorageError.unknown(nil))
        }
        
        do {
            var contents: [String]
            do {
                contents = try self.fileSystem.contentsOfDirectory(atPath: storeDir)
            } catch let error {
                NSLog("[BundleStorage] Failed to list contents of bundle store directory: \(storeDir)")
                return .failure(BundleStorageError.fileSystemError(error))
            }
            
            if contents.isEmpty {
                NSLog("[BundleStorage] No bundles to clean up.")
                return .success(())
            }
            
            let currentBundlePath = currentBundleId != nil ?
            (storeDir as NSString).appendingPathComponent(currentBundleId!) : nil
            
            var latestBundlePath: String? = nil
            var latestModDate: Date = .distantPast
            
            for item in contents {
                let fullPath = (storeDir as NSString).appendingPathComponent(item)
                
                if fullPath == currentBundlePath {
                    continue
                }
                
                if self.fileSystem.fileExists(atPath: fullPath) {
                    do {
                        let attributes = try self.fileSystem.attributesOfItem(atPath: fullPath)
                        if let modDate = attributes[FileAttributeKey.modificationDate] as? Date {
                            if modDate > latestModDate {
                                latestModDate = modDate
                                latestBundlePath = fullPath
                            }
                        }
                    } catch {
                        NSLog("[BundleStorage] Warning: Could not get attributes for \(fullPath): \(error)")
                    }
                }
            }
            
            var bundlesToKeep = Set<String>()
            
            if let currentPath = currentBundlePath, self.fileSystem.fileExists(atPath: currentPath) {
                bundlesToKeep.insert(currentPath)
                NSLog("[BundleStorage] Keeping current bundle: \(currentBundleId!)")
            }
            
            if let latestPath = latestBundlePath {
                bundlesToKeep.insert(latestPath)
                NSLog("[BundleStorage] Keeping latest bundle: \((latestPath as NSString).lastPathComponent)")
            }
            
            var removedCount = 0
            for item in contents {
                let fullPath = (storeDir as NSString).appendingPathComponent(item)
                if !bundlesToKeep.contains(fullPath) {
                    do {
                        try self.fileSystem.removeItem(atPath: fullPath)
                        removedCount += 1
                        NSLog("[BundleStorage] Removed old bundle: \(item)")
                    } catch {
                        NSLog("[BundleStorage] Failed to remove old bundle at \(fullPath): \(error)")
                        // Optionally, collect errors and return a multiple error type or first error
                    }
                }
            }
            
            if removedCount == 0 {
                NSLog("[BundleStorage] No old bundles to remove.")
            } else {
                NSLog("[BundleStorage] Removed \(removedCount) old bundle(s).")
            }
            
            return .success(())
        } catch let error {
            return .failure(error)
        }
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
        guard let validFileUrl = fileUrl else {
            NSLog("[BundleStorage] fileUrl is nil, resetting bundle URL.")
            // Dispatch the sequence to the file operation queue to ensure completion is called asynchronously
            // and to keep file operations off the calling thread if it's the main thread.
            fileOperationQueue.async {
                let setResult = self.setBundleURL(localPath: nil)
                switch setResult {
                case .success:
                    let cleanupResult = self.cleanupOldBundles(currentBundleId: nil)
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
        
        // Start the bundle update process, dispatching the main logic to fileOperationQueue
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
                            try self.fileSystem.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir)
                            
                            let setResult = self.setBundleURL(localPath: bundlePath)
                            switch setResult {
                            case .success:
                                let cleanupResult = self.cleanupOldBundles(currentBundleId: bundleId)
                                switch cleanupResult {
                                case .success:
                                    completion(.success(true))
                                case .failure(let error):
                                    NSLog("[BundleStorage] Warning: Cleanup failed but bundle is set: \(error)")
                                    completion(.failure(error)) // Or consider .success(true) if main operation succeeded
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
                            // Continue with download process on success (must be called on a thread that can continue,
                            // but prepareAndDownloadBundle will manage its own threading for download)
                            self.prepareAndDownloadBundle(bundleId: bundleId, fileUrl: validFileUrl, finalBundleDir: finalBundleDir, completion: completion)
                        } catch let error {
                            NSLog("[BundleStorage] Failed to remove invalid bundle dir: \(error.localizedDescription)")
                            completion(.failure(BundleStorageError.fileSystemError(error)))
                        }
                    }
                case .failure(let error):
                    completion(.failure(error))
                }
            } else {
                self.prepareAndDownloadBundle(bundleId: bundleId, fileUrl: validFileUrl, finalBundleDir: finalBundleDir, completion: completion)
            }
        }
    }
    
    /**
     * Prepares directories and starts the download process.
     * This method is part of the asynchronous `updateBundle` flow.
     * @param bundleId ID of the bundle to update
     * @param fileUrl URL of the bundle file to download
     * @param finalBundleDir Final directory for the bundle
     * @param completion Callback with result of the operation
     */
    private func prepareAndDownloadBundle(bundleId: String, fileUrl: URL, finalBundleDir: String, completion: @escaping (Result<Bool, Error>) -> Void) {
        // tempDir() is now synchronous. The rest of this function manages async download.
        let tempDirResult = tempDir()
        guard case .success(let tempDirectory) = tempDirResult else {
            completion(.failure(tempDirResult.failureError ?? BundleStorageError.unknown(nil)))
            return
        }
        
        // The rest of the operations (cleanup, dir creation, download) should still be on a background thread
        // This is already within a fileOperationQueue.async block from updateBundle or needs to be if called directly.
        // For safety, ensure this block runs on the fileOperationQueue if it's not already.
        // However, prepareAndDownloadBundle is called from an existing fileOperationQueue.async block in updateBundle.

        // Clean up any previous temp dir (sync operation)
        try? self.fileSystem.removeItem(atPath: tempDirectory)
        
        // Create necessary directories (sync operation)
        if !self.fileSystem.createDirectory(atPath: tempDirectory) {
            completion(.failure(BundleStorageError.directoryCreationFailed))
            return
        }
        
        let tempZipFile = (tempDirectory as NSString).appendingPathComponent("bundle.zip")
        let extractedDir = (tempDirectory as NSString).appendingPathComponent("extracted")
        
        if !self.fileSystem.createDirectory(atPath: extractedDir) {
            completion(.failure(BundleStorageError.directoryCreationFailed))
            return
        }
        
        NSLog("[BundleStorage] Starting download from \(fileUrl)")
        
        // DownloadService handles its own threading for the download task.
        // The completion handler for downloadService.downloadFile is then dispatched to fileOperationQueue.
        let task = self.downloadService.downloadFile(from: fileUrl, to: tempZipFile, progressHandler: { progress in
            // Progress updates handled by notification system
        }, completion: { [weak self] result in
            guard let self = self else {
                let error = NSError(domain: "HotUpdaterError", code: 998,
                                    userInfo: [NSLocalizedDescriptionKey: "Self deallocated during download"])
                completion(.failure(error))
                return
            }
            
            // Dispatch the processing of the downloaded file to the file operation queue
            self.fileOperationQueue.async {
                switch result {
                case .success(let location):
                    self.processDownloadedFile(
                        location: location,
                        tempZipFile: tempZipFile,
                        extractedDir: extractedDir,
                        finalBundleDir: finalBundleDir,
                        bundleId: bundleId,
                        tempDirectory: tempDirectory,
                        completion: completion
                    )
                    
                case .failure(let error):
                    NSLog("[BundleStorage] Download failed: \(error.localizedDescription)")
                    self.cleanupTemporaryFiles([tempDirectory]) // Sync cleanup
                    completion(.failure(BundleStorageError.downloadFailed(error)))
                }
            }
        })
        
        if let task = task {
            self.activeTasks.append(task) // Manage active tasks
        }
    }
    
    /**
     * Processes a downloaded bundle file.
     * This method is part of the asynchronous `updateBundle` flow and is expected to run on a background thread.
     * @param location URL of the downloaded file
     * @param tempZipFile Path to store the downloaded zip file
     * @param extractedDir Directory to extract contents to
     * @param finalBundleDir Final directory for the bundle
     * @param bundleId ID of the bundle being processed
     * @param tempDirectory Temporary directory for processing
     * @param completion Callback with result of the operation
     */
    private func processDownloadedFile(
        location: URL,
        tempZipFile: String,
        extractedDir: String,
        finalBundleDir: String,
        bundleId: String,
        tempDirectory: String,
        completion: @escaping (Result<Bool, Error>) -> Void
    ) {
        NSLog("[BundleStorage] Processing downloaded file atPath: \(location.path)")
        
        // 1. Check if source file exists
        guard self.fileSystem.fileExists(atPath: location.path) else {
            NSLog("[BundleStorage] Source file does not exist atPath: \(location.path)")
            self.cleanupTemporaryFiles([tempDirectory])
            completion(.failure(BundleStorageError.fileSystemError(NSError(
                domain: "HotUpdaterError",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Source file does not exist atPath: \(location.path)"]
            ))))
            return
        }
        
        // 2. Create target directory
        do {
            let tempZipFileURL = URL(fileURLWithPath: tempZipFile)
            let tempZipFileDirectory = tempZipFileURL.deletingLastPathComponent()
            
            if !self.fileSystem.fileExists(atPath: tempZipFileDirectory.path) {
                try self.fileSystem.createDirectory(atPath: tempZipFileDirectory.path)
                NSLog("[BundleStorage] Created directory atPath: \(tempZipFileDirectory.path)")
            }
            
            try self.fileSystem.moveItem(atPath: location.path, toPath: tempZipFile)
            NSLog("[BundleStorage] Successfully moved file to: \(tempZipFile)")
            
            try self.unzipService.unzip(file: tempZipFile, to: extractedDir)
            NSLog("[BundleStorage] Successfully extracted to: \(extractedDir)")
            
            // 6. Remove temporary zip file
            try? self.fileSystem.removeItem(atPath: tempZipFile)
            
            // 7. Search for bundle file
            switch self.findBundleFile(in: extractedDir) {
            case .success(let bundlePath):
                if let bundlePath = bundlePath {
                    NSLog("[BundleStorage] Found bundle atPath: \(bundlePath)")
                    
                    // 8. Create final bundle directory
                    if !self.fileSystem.fileExists(atPath: finalBundleDir) {
                        try self.fileSystem.createDirectory(atPath: finalBundleDir)
                        NSLog("[BundleStorage] Created final bundle directory atPath: \(finalBundleDir)")
                    }
                    
                    // 9. Move entire extracted directory to final location
                    if self.fileSystem.fileExists(atPath: finalBundleDir) {
                        try self.fileSystem.removeItem(atPath: finalBundleDir)
                    }
                    try self.fileSystem.moveItem(atPath: extractedDir, toPath: finalBundleDir)
                    NSLog("[BundleStorage] Successfully moved entire bundle directory to: \(finalBundleDir)")
                    
                    // 10. Cleanup
                    self.cleanupTemporaryFiles([tempDirectory])
                    completion(.success(true))
                } else {
                    NSLog("[BundleStorage] No bundle file found in extracted directory")
                    self.cleanupTemporaryFiles([tempDirectory])
                    completion(.failure(BundleStorageError.invalidBundle))
                }
            case .failure(let error):
                NSLog("[BundleStorage] Error finding bundle file: \(error.localizedDescription)")
                self.cleanupTemporaryFiles([tempDirectory])
                completion(.failure(error))
            }
        } catch let error {
            NSLog("[BundleStorage] Error processing downloaded file: \(error.localizedDescription)")
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