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
 * Protocol for interacting with bundle storage system in a thread-safe way.
 * All heavy operations use completion handlers for asynchronous operation.
 */
public protocol BundleStorageService {
    // Directory operations
    func bundleStoreDir(completion: @escaping (Result<String, Error>) -> Void)
    func tempDir(completion: @escaping (Result<String, Error>) -> Void)
    
    // Bundle file operations
    func findBundleFile(in directoryPath: String, completion: @escaping (Result<String?, Error>) -> Void) 
    func cleanupOldBundles(currentBundleId: String?, completion: @escaping (Result<Void, Error>) -> Void)
    
    // Bundle URL operations
    func setBundleURL(localPath: String?, completion: @escaping (Result<Void, Error>) -> Void)
    func cachedBundleURL(completion: @escaping (Result<URL?, Error>) -> Void)
    func fallbackBundleURL() -> URL? // Synchronous as it's lightweight
    func resolveBundleURL(completion: @escaping (Result<URL?, Error>) -> Void)
    
    // Bundle update
    func updateBundle(bundleId: String, fileUrl: URL?, completion: @escaping (Result<Bool, Error>) -> Void)
}

class BundleFileStorageService: BundleStorageService {
    private let fileSystem: FileSystemService
    private let downloadService: DownloadService
    private let unzipService: UnzipService
    private let preferences: PreferencesService
    
    // Queue for file operations to prevent UI blocking
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
        
        // Create a concurrent background queue for file operations
        self.fileOperationQueue = DispatchQueue(label: "com.hotupdater.fileoperations", 
                                               qos: .utility, 
                                               attributes: .concurrent)
    }
    
    // MARK: - Directory Management
    
    /**
     * Ensures a directory exists at the specified path. Creates it if necessary.
     * Always executes on background thread to prevent UI blocking.
     * @param path The path where directory should exist
     * @param completion Callback with result
     */
    private func ensureDirectoryExists(path: String, completion: @escaping (Result<String, Error>) -> Void) {
        fileOperationQueue.async {
            if !self.fileSystem.fileExists(atPath: path) {
                if !self.fileSystem.createDirectory(at: path) {
                    completion(.failure(BundleStorageError.directoryCreationFailed))
                    return
                }
            }
            completion(.success(path))
        }
    }
    
    /**
     * Gets the path to the bundle store directory.
     * @param completion Callback with the directory path or error
     */
    func bundleStoreDir(completion: @escaping (Result<String, Error>) -> Void) {
        let path = (fileSystem.documentsPath() as NSString).appendingPathComponent("bundle-store")
        ensureDirectoryExists(path: path, completion: completion)
    }
    
    /**
     * Gets the path to the temporary directory.
     * @param completion Callback with the directory path or error
     */
    func tempDir(completion: @escaping (Result<String, Error>) -> Void) {
        let path = (fileSystem.documentsPath() as NSString).appendingPathComponent("bundle-temp")
        ensureDirectoryExists(path: path, completion: completion)
    }
    
    /**
     * Cleans up temporary files safely on background thread.
     * @param paths Array of file/directory paths to clean up
     */
    private func cleanupTemporaryFiles(_ paths: [String]) {
        fileOperationQueue.async {
            for path in paths {
                try? self.fileSystem.removeItem(atPath: path)
            }
        }
    }
    
    // MARK: - Bundle File Operations
    
    /**
     * Finds the bundle file within a directory by checking direct paths.
     * Executes on background thread to prevent UI blocking.
     * @param directoryPath Directory to search in
     * @param completion Callback with path to bundle file or error
     */
    func findBundleFile(in directoryPath: String, completion: @escaping (Result<String?, Error>) -> Void) {
        fileOperationQueue.async {
            // Check for iOS bundle file directly
            let iosBundlePath = (directoryPath as NSString).appendingPathComponent("index.ios.bundle")
            if self.fileSystem.fileExists(atPath: iosBundlePath) {
                completion(.success(iosBundlePath))
                return
            }
            
            // Check for main bundle file
            let mainBundlePath = (directoryPath as NSString).appendingPathComponent("main.jsbundle")
            if self.fileSystem.fileExists(atPath: mainBundlePath) {
                completion(.success(mainBundlePath))
                return
            }
            
            print("[BundleStorage] Bundle file (index.ios.bundle or main.jsbundle) not found in \(directoryPath)")
            completion(.success(nil))
        }
    }
    
    /**
     * Cleans up old bundles, keeping only the current and latest bundles.
     * Executes on background thread to prevent UI blocking.
     * @param currentBundleId ID of the current active bundle (optional)
     * @param completion Callback with result of operation
     */
    func cleanupOldBundles(currentBundleId: String?, completion: @escaping (Result<Void, Error>) -> Void) {
        bundleStoreDir { result in
            switch result {
            case .success(let storeDir):
                self.fileOperationQueue.async {
                    do {
                        var contents: [String]
                        do {
                            contents = try self.fileSystem.contentsOfDirectory(atPath: storeDir)
                        } catch let error {
                            print("[BundleStorage] Failed to list contents of bundle store directory: \(storeDir)")
                            DispatchQueue.main.async {
                                completion(.failure(BundleStorageError.fileSystemError(error)))
                            }
                            return
                        }

                        if contents.isEmpty {
                            print("[BundleStorage] No bundles to clean up.")
                            DispatchQueue.main.async {
                                completion(.success(()))
                            }
                            return
                        }

                        // Identify current bundle path
                        let currentBundlePath = currentBundleId != nil ? 
                            (storeDir as NSString).appendingPathComponent(currentBundleId!) : nil
                        
                        // Find the latest bundle by modification date
                        var latestBundlePath: String? = nil
                        var latestModDate: Date = .distantPast
                        
                        for item in contents {
                            let fullPath = (storeDir as NSString).appendingPathComponent(item)
                            
                            // Skip current bundle as it's already preserved
                            if fullPath == currentBundlePath {
                                continue
                            }
                            
                            if self.fileSystem.fileExists(atPath: fullPath) {
                                do {
                                    let attributes = try self.fileSystem.attributesOfItem(atPath: fullPath)
                                    if let modDate = attributes[FileAttributeKey.modificationDate] as? Date {
                                        // Update if this is the most recent bundle found so far
                                        if modDate > latestModDate {
                                            latestModDate = modDate
                                            latestBundlePath = fullPath
                                        }
                                    }
                                } catch {
                                    // Skip bundles with inaccessible attributes
                                    print("[BundleStorage] Warning: Could not get attributes for \(fullPath): \(error)")
                                }
                            }
                        }
                        
                        // Set of bundle paths to keep
                        var bundlesToKeep = Set<String>()
                        
                        // Keep current bundle
                        if let currentPath = currentBundlePath, self.fileSystem.fileExists(atPath: currentPath) {
                            bundlesToKeep.insert(currentPath)
                            print("[BundleStorage] Keeping current bundle: \(currentBundleId!)")
                        }
                        
                        // Keep latest bundle
                        if let latestPath = latestBundlePath {
                            bundlesToKeep.insert(latestPath)
                            print("[BundleStorage] Keeping latest bundle: \((latestPath as NSString).lastPathComponent)")
                        }
                        
                        // Remove all bundles not marked for keeping
                        var removedCount = 0
                        
                        for item in contents {
                            let fullPath = (storeDir as NSString).appendingPathComponent(item)
                            if !bundlesToKeep.contains(fullPath) {
                                do {
                                    try self.fileSystem.removeItem(atPath: fullPath)
                                    removedCount += 1
                                    print("[BundleStorage] Removed old bundle: \(item)")
                                } catch {
                                    print("[BundleStorage] Failed to remove old bundle at \(fullPath): \(error)")
                                }
                            }
                        }
                        
                        if removedCount == 0 {
                            print("[BundleStorage] No old bundles to remove.")
                        } else {
                            print("[BundleStorage] Removed \(removedCount) old bundle(s).")
                        }
                        
                        DispatchQueue.main.async {
                            completion(.success(()))
                        }
                    } catch let error {
                        DispatchQueue.main.async {
                            completion(.failure(error))
                        }
                    }
                }
                
            case .failure(let error):
                DispatchQueue.main.async {
                    completion(.failure(error))
                }
            }
        }
    }
    
    /**
     * Sets the current bundle URL in preferences.
     * @param localPath Path to the bundle file (or nil to reset)
     * @param completion Callback with result of operation
     */
    func setBundleURL(localPath: String?, completion: @escaping (Result<Void, Error>) -> Void) {
        DispatchQueue.global(qos: .utility).async {
            do {
                print("[BundleStorage] Setting bundle URL to: \(localPath ?? "nil")")
                try self.preferences.setItem(localPath, forKey: "HotUpdaterBundleURL")
                DispatchQueue.main.async {
                    completion(.success(()))
                }
            } catch let error {
                DispatchQueue.main.async {
                    completion(.failure(error))
                }
            }
        }
    }
    
    /**
     * Gets the URL to the cached bundle file if it exists.
     * @param completion Callback with URL to cached bundle or nil
     */
    func cachedBundleURL(completion: @escaping (Result<URL?, Error>) -> Void) {
        DispatchQueue.global(qos: .utility).async {
            do {
                let savedURLString = try self.preferences.getItem(forKey: "HotUpdaterBundleURL")
                
                guard let urlString = savedURLString,
                      let bundleURL = URL(string: urlString),
                      self.fileSystem.fileExists(atPath: bundleURL.path) else {
                    DispatchQueue.main.async {
                        completion(.success(nil))
                    }
                    return
                }
                
                DispatchQueue.main.async {
                    completion(.success(bundleURL))
                }
            } catch let error {
                DispatchQueue.main.async {
                    completion(.failure(error))
                }
            }
        }
    }
    
    /**
     * Gets the URL to the fallback bundle included in the app.
     * @return URL to the fallback bundle or nil if not found
     */
    func fallbackBundleURL() -> URL? {
        return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
    }
    
    /**
     * Resolves the most appropriate bundle URL to use.
     * @param completion Callback with URL to the bundle
     */
    func resolveBundleURL(completion: @escaping (Result<URL?, Error>) -> Void) {
        cachedBundleURL { result in
            switch result {
            case .success(let url):
                print("[BundleStorage] Resolved bundle URL: \(url?.absoluteString ?? "Fallback")")
                if let resolvedUrl = url {
                    completion(.success(resolvedUrl))
                } else {
                    let fallbackUrl = self.fallbackBundleURL()
                    completion(.success(fallbackUrl))
                }
            case .failure(let error):
                print("[BundleStorage] Error resolving bundle URL: \(error.localizedDescription)")
                completion(.success(self.fallbackBundleURL()))
            }
        }
    }
    
    // MARK: - Bundle Update
    
    /**
     * Updates the bundle from the specified URL.
     * @param bundleId ID of the bundle to update
     * @param fileUrl URL of the bundle file to download (or nil to reset)
     * @param completion Callback with result of the operation
     */
    func updateBundle(bundleId: String, fileUrl: URL?, completion: @escaping (Result<Bool, Error>) -> Void) {
        // If no fileUrl provided, reset bundle URL and clean up
        guard let validFileUrl = fileUrl else {
            print("[BundleStorage] fileUrl is nil, resetting bundle URL.")
            
            setBundleURL(localPath: nil) { result in
                switch result {
                case .success:
                    self.cleanupOldBundles(currentBundleId: nil) { cleanupResult in
                        switch cleanupResult {
                        case .success:
                            completion(.success(true))
                        case .failure(let error):
                            print("[BundleStorage] Error during cleanup: \(error)")
                            completion(.success(true)) // Still consider it a success
                        }
                    }
                case .failure(let error):
                    print("[BundleStorage] Error resetting bundle URL: \(error)")
                    completion(.failure(error))
                }
            }
            return
        }
        
        // Start the bundle update process
        bundleStoreDir { storeDirResult in
            switch storeDirResult {
            case .success(let storeDir):
                let finalBundleDir = (storeDir as NSString).appendingPathComponent(bundleId)
                
                // Check if bundle already exists
                if self.fileSystem.fileExists(atPath: finalBundleDir) {
                    self.findBundleFile(in: finalBundleDir) { findResult in
                        switch findResult {
                        case .success(let existingBundlePath):
                            if let bundlePath = existingBundlePath {
                                print("[BundleStorage] Using cached bundle at path: \(bundlePath)")
                                
                                // Execute operations in sequence
                                self.fileOperationQueue.async {
                                    do {
                                        try self.fileSystem.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir)
                                        
                                        self.setBundleURL(localPath: bundlePath) { setResult in
                                            switch setResult {
                                            case .success:
                                                self.cleanupOldBundles(currentBundleId: bundleId) { cleanupResult in
                                                    switch cleanupResult {
                                                    case .success:
                                                        completion(.success(true))
                                                    case .failure(let error):
                                                        print("[BundleStorage] Warning: Cleanup failed but bundle is set: \(error)")
                                                        completion(.success(true)) // Still a success
                                                    }
                                                }
                                            case .failure(let error):
                                                completion(.failure(error))
                                            }
                                        }
                                    } catch let error {
                                        DispatchQueue.main.async {
                                            completion(.failure(error))
                                        }
                                    }
                                }
                                return
                            } else {
                                print("[BundleStorage] Cached directory exists but invalid, removing: \(finalBundleDir)")
                                self.fileOperationQueue.async {
                                    do {
                                        try self.fileSystem.removeItem(atPath: finalBundleDir)
                                        // Continue with download process on success
                                        self.prepareAndDownloadBundle(bundleId: bundleId, fileUrl: validFileUrl, finalBundleDir: finalBundleDir, completion: completion)
                                    } catch let error {
                                        print("[BundleStorage] Failed to remove invalid bundle dir: \(error.localizedDescription)")
                                        DispatchQueue.main.async {
                                            completion(.failure(BundleStorageError.fileSystemError(error)))
                                        }
                                    }
                                }
                            }
                        case .failure(let error):
                            completion(.failure(error))
                        }
                    }
                } else {
                    // Bundle doesn't exist, proceed with download
                    self.prepareAndDownloadBundle(bundleId: bundleId, fileUrl: validFileUrl, finalBundleDir: finalBundleDir, completion: completion)
                }
                
            case .failure(let error):
                completion(.failure(error))
            }
        }
    }
    
    /**
     * Prepares directories and starts the download process.
     * @param bundleId ID of the bundle to update
     * @param fileUrl URL of the bundle file to download
     * @param finalBundleDir Final directory for the bundle
     * @param completion Callback with result of the operation
     */
    private func prepareAndDownloadBundle(bundleId: String, fileUrl: URL, finalBundleDir: String, completion: @escaping (Result<Bool, Error>) -> Void) {
        // Prepare temporary directory
        tempDir { tempDirResult in
            switch tempDirResult {
            case .success(let tempDirectory):
                self.fileOperationQueue.async {
                    // Clean up any previous temp dir
                    try? self.fileSystem.removeItem(atPath: tempDirectory)
                    
                    // Create necessary directories
                    if !self.fileSystem.createDirectory(at: tempDirectory) {
                        DispatchQueue.main.async {
                            completion(.failure(BundleStorageError.directoryCreationFailed))
                        }
                        return
                    }
                    
                    let tempZipFile = (tempDirectory as NSString).appendingPathComponent("bundle.zip")
                    let extractedDir = (tempDirectory as NSString).appendingPathComponent("extracted")
                    
                    if !self.fileSystem.createDirectory(at: extractedDir) {
                        DispatchQueue.main.async {
                            completion(.failure(BundleStorageError.directoryCreationFailed))
                        }
                        return
                    }
                    
                    // Start download on main thread (URLSession handles its own threading)
                    DispatchQueue.main.async {
                        print("[BundleStorage] Starting download from \(fileUrl)")
                        
                        // Start download
                        let task = self.downloadService.downloadFile(from: fileUrl, to: tempZipFile, progressHandler: { progress in
                            // Progress updates handled by notification system
                        }, completion: { [weak self] result in
                            guard let self = self else {
                                let error = NSError(domain: "HotUpdaterError", code: 998, 
                                                   userInfo: [NSLocalizedDescriptionKey: "Self deallocated during download"])
                                completion(.failure(error))
                                return
                            }
                            
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
                                print("[BundleStorage] Download failed: \(error.localizedDescription)")
                                self.cleanupTemporaryFiles([tempDirectory])
                                completion(.failure(BundleStorageError.downloadFailed(error)))
                            }
                        })
                        
                        if let task = task {
                            self.activeTasks.append(task)
                        }
                    }
                }
                
            case .failure(let error):
                completion(.failure(error))
            }
        }
    }
    
    /**
     * Processes a downloaded bundle file.
     * All heavy operations are performed on background threads.
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
        // Move to background queue for file operations
        fileOperationQueue.async {
            // Move downloaded file to temp location
            do {
                try? self.fileSystem.removeItem(atPath: tempZipFile) // Remove any existing file
                try self.fileSystem.moveItem(at: location, to: URL(fileURLWithPath: tempZipFile))
            } catch let moveError {
                print("[BundleStorage] Failed to move downloaded file: \(moveError.localizedDescription)")
                self.cleanupTemporaryFiles([tempDirectory])
                DispatchQueue.main.async {
                    completion(.failure(BundleStorageError.moveOperationFailed(moveError)))
                }
                return
            }
            
            // Extract the zip file (potentially heavy operation)
            do {
                try self.unzipService.unzip(file: tempZipFile, to: extractedDir)
                
                // Remove zip file immediately after extraction to save space
                try? self.fileSystem.removeItem(atPath: tempZipFile)
                
                // Verify extraction was successful
                if !self.fileSystem.fileExists(atPath: extractedDir) {
                    throw BundleStorageError.extractionFailed(NSError(
                        domain: "HotUpdaterError", 
                        code: 5, 
                        userInfo: [NSLocalizedDescriptionKey: "Extraction directory does not exist"]
                    ))
                }
                
                let contents = try self.fileSystem.contentsOfDirectory(atPath: extractedDir)
                if contents.isEmpty {
                    throw BundleStorageError.extractionFailed(NSError(
                        domain: "HotUpdaterError", 
                        code: 5, 
                        userInfo: [NSLocalizedDescriptionKey: "No files were extracted"]
                    ))
                }
            } catch let unzipError {
                print("[BundleStorage] Extraction failed: \(unzipError.localizedDescription)")
                self.cleanupTemporaryFiles([tempDirectory])
                DispatchQueue.main.async {
                    completion(.failure(BundleStorageError.extractionFailed(unzipError)))
                }
                return
            }
            
            // Verify bundle file exists in extracted directory
            self.findBundleFile(in: extractedDir) { findResult in
                switch findResult {
                case .success(let bundlePath):
                    if bundlePath == nil {
                        self.cleanupTemporaryFiles([tempDirectory])
                        completion(.failure(BundleStorageError.invalidBundle))
                        return
                    }
                    
                    // Continue with move/copy operations on background thread
                    self.fileOperationQueue.async {
                        // Move extracted directory to final location
                        do {
                            // Remove existing bundle directory if it exists
                            if self.fileSystem.fileExists(atPath: finalBundleDir) {
                                try self.fileSystem.removeItem(atPath: finalBundleDir)
                            }
                            
                            // Move extracted directory to final location
                            try self.fileSystem.moveItem(at: URL(fileURLWithPath: extractedDir), to: URL(fileURLWithPath: finalBundleDir))
                            try? self.fileSystem.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir)
                        } catch {
                            print("[BundleStorage] Move failed, attempting copy: \(error.localizedDescription)")
                            do {
                                // Try copying if move fails
                                try self.fileSystem.copyItem(atPath: extractedDir, toPath: finalBundleDir)
                                try self.fileSystem.removeItem(atPath: extractedDir) // Clean up source after copy
                                try? self.fileSystem.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir)
                            } catch let copyError {
                                print("[BundleStorage] Copy also failed: \(copyError.localizedDescription)")
                                self.cleanupTemporaryFiles([tempDirectory, finalBundleDir])
                                DispatchQueue.main.async {
                                    completion(.failure(BundleStorageError.copyOperationFailed(copyError)))
                                }
                                return
                            }
                        }
                        
                        // Get the final bundle path
                        self.findBundleFile(in: finalBundleDir) { finalFindResult in
                            switch finalFindResult {
                            case .success(let finalBundlePath):
                                if let finalPath = finalBundlePath {
                                    print("[BundleStorage] Bundle update successful. Path: \(finalPath)")
                                    
                                    // Update in sequence
                                    self.setBundleURL(localPath: finalPath) { setResult in
                                        switch setResult {
                                        case .success:
                                            self.cleanupOldBundles(currentBundleId: bundleId) { cleanupResult in
                                                self.cleanupTemporaryFiles([tempDirectory])
                                                
                                                switch cleanupResult {
                                                case .success:
                                                    completion(.success(true))
                                                case .failure(let error):
                                                    print("[BundleStorage] Warning: Final cleanup failed but bundle is set: \(error)")
                                                    completion(.success(true)) // Still a success
                                                }
                                            }
                                        case .failure(let error):
                                            self.cleanupTemporaryFiles([tempDirectory])
                                            completion(.failure(error))
                                        }
                                    }
                                } else {
                                    self.cleanupTemporaryFiles([tempDirectory])
                                    completion(.failure(BundleStorageError.bundleNotFound))
                                }
                                
                            case .failure(let error):
                                print("[BundleStorage] Final bundle processing failed: \(error)")
                                self.cleanupTemporaryFiles([tempDirectory])
                                completion(.failure(error))
                            }
                        }
                    }
                    
                case .failure(let error):
                    print("[BundleStorage] Failed to check extracted bundle: \(error)")
                    self.cleanupTemporaryFiles([tempDirectory])
                    completion(.failure(error))
                }
            }
        }
    }
}