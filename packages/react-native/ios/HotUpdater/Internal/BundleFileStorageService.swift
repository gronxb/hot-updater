import Foundation

// Specific error types for bundle storage operations
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

// Protocol defining bundle storage operations
public protocol BundleStorageService {
    func bundleStoreDir() throws -> String
    func tempDir() throws -> String
    func findBundleFile(in directoryPath: String) throws -> String?
    func cleanupOldBundles(currentBundleId: String?) throws
    func setBundleURL(localPath: String?) throws
    func cachedBundleURL() throws -> URL?
    func fallbackBundleURL() -> URL?
    func resolveBundleURL() throws -> URL?
    func updateBundle(bundleId: String, fileUrl: URL?, completion: @escaping (Result<Bool, Error>) -> Void)
}

class BundleFileStorageService: BundleStorageService {
    private let fileSystem: FileSystemService
    private let downloadService: DownloadService
    private let unzipService: UnzipService
    private let preferences: PreferencesService
    
    private var activeTasks: [URLSessionTask] = []
    
    public init(fileSystem: FileSystemService, 
         downloadService: DownloadService,
         unzipService: UnzipService,
         preferences: PreferencesService) {
        
        self.fileSystem = fileSystem
        self.downloadService = downloadService
        self.unzipService = unzipService
        self.preferences = preferences
    }
    
    // MARK: - Directory Management
    
    /**
     * Ensures a directory exists at the specified path. Creates it if necessary.
     * @param path The path where directory should exist
     * @return The same path if successful
     * @throws BundleStorageError if directory creation fails
     */
    private func ensureDirectoryExists(path: String) throws -> String {
        if !fileSystem.fileExists(atPath: path) {
            if !fileSystem.createDirectory(at: path) {
                throw BundleStorageError.directoryCreationFailed
            }
        }
        return path
    }
    
    /**
     * Gets the path to the bundle store directory.
     * @return Path to the bundle store directory
     * @throws BundleStorageError if directory creation fails
     */
    func bundleStoreDir() throws -> String {
        let path = (fileSystem.documentsPath() as NSString).appendingPathComponent("bundle-store")
        return try ensureDirectoryExists(path: path)
    }
    
    /**
     * Gets the path to the temporary directory.
     * @return Path to the temporary directory
     * @throws BundleStorageError if directory creation fails
     */
    func tempDir() throws -> String {
        let path = (fileSystem.documentsPath() as NSString).appendingPathComponent("bundle-temp")
        return try ensureDirectoryExists(path: path)
    }
    
    /**
     * Cleans up temporary files safely.
     * @param paths Array of file/directory paths to clean up
     */
    private func cleanupTemporaryFiles(_ paths: [String]) {
        for path in paths {
            try? fileSystem.removeItem(atPath: path)
        }
    }
    
    // MARK: - Bundle File Operations
    
    /**
     * Finds the bundle file within a directory by checking direct paths.
     * @param directoryPath Directory to search in
     * @return Path to the bundle file if found, nil otherwise
     * @throws BundleStorageError if file system error occurs
     */
    func findBundleFile(in directoryPath: String) throws -> String? {
        // Check for iOS bundle file directly
        let iosBundlePath = (directoryPath as NSString).appendingPathComponent("index.ios.bundle")
        if fileSystem.fileExists(atPath: iosBundlePath) {
            return iosBundlePath
        }
        
        // Check for main bundle file
        let mainBundlePath = (directoryPath as NSString).appendingPathComponent("main.jsbundle")
        if fileSystem.fileExists(atPath: mainBundlePath) {
            return mainBundlePath
        }
        
        print("[BundleStorage] Bundle file (index.ios.bundle or main.jsbundle) not found in \(directoryPath)")
        return nil
    }
    
    /**
     * Cleans up old bundles, keeping only the current and latest bundles.
     * @param currentBundleId ID of the current active bundle (optional)
     * @throws BundleStorageError if file system operations fail
     */
    func cleanupOldBundles(currentBundleId: String?) throws {
        let storeDir = try bundleStoreDir()
        
        var contents: [String]
        do {
            contents = try fileSystem.contentsOfDirectory(atPath: storeDir)
        } catch let error {
            print("[BundleStorage] Failed to list contents of bundle store directory: \(storeDir)")
            throw BundleStorageError.fileSystemError(error)
        }

        if contents.isEmpty {
            print("[BundleStorage] No bundles to clean up.")
            return
        }

        // Identify current bundle path
        let currentBundlePath = currentBundleId != nil ? 
            (storeDir as NSString).appendingPathComponent(currentBundleId!) : nil
        
        // Maximum number of bundles to keep
        let maxBundlesToKeep = 2
        
        // Find the latest bundle by modification date
        var latestBundlePath: String? = nil
        var latestModDate: Date = .distantPast
        
        for item in contents {
            let fullPath = (storeDir as NSString).appendingPathComponent(item)
            
            // Skip current bundle as it's already preserved
            if fullPath == currentBundlePath {
                continue
            }
            
            if fileSystem.fileExists(atPath: fullPath) {
                do {
                    let attributes = try fileSystem.attributesOfItem(atPath: fullPath)
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
        if let currentPath = currentBundlePath, fileSystem.fileExists(atPath: currentPath) {
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
                    try fileSystem.removeItem(atPath: fullPath)
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
    }
    
    /**
     * Sets the current bundle URL in preferences.
     * @param localPath Path to the bundle file (or nil to reset)
     * @throws Error if preferences operation fails
     */
    func setBundleURL(localPath: String?) throws {
        print("[BundleStorage] Setting bundle URL to: \(localPath ?? "nil")")
        try preferences.setItem(localPath, forKey: "HotUpdaterBundleURL")
    }
    
    /**
     * Gets the URL to the cached bundle file if it exists.
     * @return URL to the cached bundle or nil if not found
     * @throws Error if preferences operation fails
     */
    func cachedBundleURL() throws -> URL? {
        guard let savedURLString = try preferences.getItem(forKey: "HotUpdaterBundleURL"),
              let bundleURL = URL(string: savedURLString),
              fileSystem.fileExists(atPath: bundleURL.path) else {
            return nil
        }
        return bundleURL
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
     * @return URL to the bundle (cached or fallback)
     * @throws Error if bundle resolution fails
     */
    func resolveBundleURL() throws -> URL? {
        let url = try cachedBundleURL()
        print("[BundleStorage] Resolved bundle URL: \(url?.absoluteString ?? "Fallback")")
        return url ?? fallbackBundleURL()
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
            do {
                try setBundleURL(localPath: nil)
                try cleanupOldBundles(currentBundleId: nil)
                completion(.success(true))
            } catch let error {
                print("[BundleStorage] Error resetting bundle URL: \(error)")
                completion(.failure(error))
            }
            return
        }
        
        do {
            let storeDir = try bundleStoreDir()
            let finalBundleDir = (storeDir as NSString).appendingPathComponent(bundleId)
            
            // Check if bundle already exists
            if fileSystem.fileExists(atPath: finalBundleDir) {
                if let existingBundlePath = try findBundleFile(in: finalBundleDir) {
                    print("[BundleStorage] Using cached bundle at path: \(existingBundlePath)")
                    do {
                        // Update timestamp, set as current bundle, and clean up old bundles
                        try fileSystem.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir)
                        try setBundleURL(localPath: existingBundlePath)
                        try cleanupOldBundles(currentBundleId: bundleId)
                        completion(.success(true))
                    } catch let error {
                        completion(.failure(error))
                    }
                    return
                } else {
                    print("[BundleStorage] Cached directory exists but invalid, removing: \(finalBundleDir)")
                    do {
                        try fileSystem.removeItem(atPath: finalBundleDir)
                    } catch let error {
                        print("[BundleStorage] Failed to remove invalid bundle dir: \(error.localizedDescription)")
                        completion(.failure(BundleStorageError.fileSystemError(error)))
                        return
                    }
                }
            }
            
            // Prepare temporary directory
            let tempDirectory = try tempDir()
            try? fileSystem.removeItem(atPath: tempDirectory) // Clean up any previous temp dir
            
            // Create necessary directories
            if !fileSystem.createDirectory(at: tempDirectory) || !fileSystem.createDirectory(at: storeDir) {
                let error = BundleStorageError.directoryCreationFailed
                completion(.failure(error))
                return
            }
            
            let tempZipFile = (tempDirectory as NSString).appendingPathComponent("bundle.zip")
            let extractedDir = (tempDirectory as NSString).appendingPathComponent("extracted")
            
            if !fileSystem.createDirectory(at: extractedDir) {
                let error = BundleStorageError.directoryCreationFailed
                completion(.failure(error))
                return
            }
            
            print("[BundleStorage] Starting download from \(validFileUrl)")
            
            // Start download
            let task = downloadService.downloadFile(from: validFileUrl, to: tempZipFile, progressHandler: { progress in
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
                    try? self.fileSystem.removeItem(atPath: tempDirectory)
                    completion(.failure(BundleStorageError.downloadFailed(error)))
                }
            })
            
            if let task = task {
                activeTasks.append(task)
            }
        } catch let error {
            print("[BundleStorage] Error preparing for bundle update: \(error)")
            completion(.failure(error))
        }
    }
    
    /**
     * Processes a downloaded bundle file.
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
        // Move downloaded file to temp location
        do {
            try? fileSystem.removeItem(atPath: tempZipFile) // Remove any existing file
            try fileSystem.moveItem(at: location, to: URL(fileURLWithPath: tempZipFile))
        } catch let moveError {
            print("[BundleStorage] Failed to move downloaded file: \(moveError.localizedDescription)")
            cleanupTemporaryFiles([tempDirectory])
            completion(.failure(BundleStorageError.moveOperationFailed(moveError)))
            return
        }
        
        // Extract the zip file
        do {
            try unzipService.unzip(file: tempZipFile, to: extractedDir)
            
            // Remove zip file immediately after extraction to save space
            try? fileSystem.removeItem(atPath: tempZipFile)
            
            // Verify extraction was successful
            if !fileSystem.fileExists(atPath: extractedDir) {
                throw BundleStorageError.extractionFailed(NSError(
                    domain: "HotUpdaterError", 
                    code: 5, 
                    userInfo: [NSLocalizedDescriptionKey: "Extraction directory does not exist"]
                ))
            }
            
            let contents = try fileSystem.contentsOfDirectory(atPath: extractedDir)
            if contents.isEmpty {
                throw BundleStorageError.extractionFailed(NSError(
                    domain: "HotUpdaterError", 
                    code: 5, 
                    userInfo: [NSLocalizedDescriptionKey: "No files were extracted"]
                ))
            }
        } catch let unzipError {
            print("[BundleStorage] Extraction failed: \(unzipError.localizedDescription)")
            cleanupTemporaryFiles([tempDirectory])
            completion(.failure(BundleStorageError.extractionFailed(unzipError)))
            return
        }
        
        // Verify bundle file exists in extracted directory
        do {
            guard let _ = try findBundleFile(in: extractedDir) else {
                throw BundleStorageError.invalidBundle
            }
        } catch let error {
            print("[BundleStorage] Failed to find bundle file in extracted directory: \(error)")
            cleanupTemporaryFiles([tempDirectory])
            completion(.failure(error))
            return
        }
        
        // Move extracted directory to final location
        do {
            // Remove existing bundle directory if it exists
            if fileSystem.fileExists(atPath: finalBundleDir) {
                try fileSystem.removeItem(atPath: finalBundleDir)
            }
            
            // Move extracted directory to final location
            try fileSystem.moveItem(at: URL(fileURLWithPath: extractedDir), to: URL(fileURLWithPath: finalBundleDir))
            try? fileSystem.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir)
        } catch {
            print("[BundleStorage] Move failed, attempting copy: \(error.localizedDescription)")
            do {
                // Try copying if move fails
                try fileSystem.copyItem(atPath: extractedDir, toPath: finalBundleDir)
                try fileSystem.removeItem(atPath: extractedDir) // Clean up source after copy
                try? fileSystem.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir)
            } catch let copyError {
                print("[BundleStorage] Copy also failed: \(copyError.localizedDescription)")
                cleanupTemporaryFiles([tempDirectory, finalBundleDir])
                completion(.failure(BundleStorageError.copyOperationFailed(copyError)))
                return
            }
        }
        
        // Complete the update by setting the bundle URL and cleaning up
        do {
            guard let finalBundlePath = try findBundleFile(in: finalBundleDir) else {
                throw BundleStorageError.bundleNotFound
            }
            
            print("[BundleStorage] Bundle update successful. Path: \(finalBundlePath)")
            
            // Update in transaction-like sequence
            try setBundleURL(localPath: finalBundlePath)
            try cleanupOldBundles(currentBundleId: bundleId)
            cleanupTemporaryFiles([tempDirectory])
            completion(.success(true))
        } catch let error {
            print("[BundleStorage] Final bundle processing failed: \(error)")
            cleanupTemporaryFiles([tempDirectory])
            completion(.failure(error))
        }
    }
}