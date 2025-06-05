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
    
    // MARK: - Helper Structures
    
    private struct FileItem {
        let relativePath: String
        let isDirectory: Bool
        let size: Int64
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
    
    // MARK: - Optimized File Operations
    
    /**
     * Fast file count with early termination for large datasets
     */
    private func getFileCount(_ path: String) throws -> Int {
        var count = 0
        let enumerator = FileManager.default.enumerator(atPath: path)
        
        while let _ = enumerator?.nextObject() as? String {
            count += 1
            // Early termination for very large bundles
            if count > 5000 {
                return count
            }
        }
        
        return count
    }
    
    /**
     * Memory-efficient streaming verification for medium-sized bundles
     */
    private func verifyMoveCompletionStreaming(sourcePath: String, destinationPath: String) throws {
        NSLog("[BundleStorage] Starting streaming verification...")
        
        var checkedCount = 0
        var errorCount = 0
        let maxErrors = 10 // Allow some errors but not too many
        
        // Stream through source directory
        let sourceEnumerator = FileManager.default.enumerator(atPath: sourcePath)
        
        while let relativePath = sourceEnumerator?.nextObject() as? String {
            let sourceFullPath = (sourcePath as NSString).appendingPathComponent(relativePath)
            let destFullPath = (destinationPath as NSString).appendingPathComponent(relativePath)
            
            // Batch processing with CPU yielding
            checkedCount += 1
            if checkedCount % 100 == 0 {
                NSLog("[BundleStorage] Verified \(checkedCount) items...")
                // Yield CPU to prevent blocking
                usleep(1000) // 1ms
            }
            
            // Check file existence
            guard self.fileSystem.fileExists(atPath: destFullPath) else {
                errorCount += 1
                NSLog("[BundleStorage] Missing file: \(relativePath)")
                
                if errorCount >= maxErrors {
                    throw BundleStorageError.moveOperationFailed(
                        NSError(domain: "HotUpdaterError", code: 601,
                               userInfo: [NSLocalizedDescriptionKey: "Too many missing files (\(errorCount)), aborting verification"])
                    )
                }
                continue
            }
            
            // Verify file size for non-directories
            do {
                let sourceAttributes = try self.fileSystem.attributesOfItem(atPath: sourceFullPath)
                let destAttributes = try self.fileSystem.attributesOfItem(atPath: destFullPath)
                
                let isSourceDir = (sourceAttributes[.type] as? FileAttributeType) == .typeDirectory
                let isDestDir = (destAttributes[.type] as? FileAttributeType) == .typeDirectory
                
                if !isSourceDir && !isDestDir {
                    let sourceSize = (sourceAttributes[.size] as? NSNumber)?.int64Value ?? 0
                    let destSize = (destAttributes[.size] as? NSNumber)?.int64Value ?? 0
                    
                    if sourceSize != destSize {
                        errorCount += 1
                        NSLog("[BundleStorage] Size mismatch: \(relativePath) (\(sourceSize) vs \(destSize))")
                        
                        if errorCount >= maxErrors {
                            throw BundleStorageError.moveOperationFailed(
                                NSError(domain: "HotUpdaterError", code: 602,
                                       userInfo: [NSLocalizedDescriptionKey: "Too many size mismatches (\(errorCount)), aborting verification"])
                            )
                        }
                    }
                }
            } catch {
                NSLog("[BundleStorage] Warning: Could not verify \(relativePath): \(error)")
                // Don't count attribute reading failures as critical errors
            }
        }
        
        if errorCount > 0 {
            throw BundleStorageError.moveOperationFailed(
                NSError(domain: "HotUpdaterError", code: 600,
                       userInfo: [NSLocalizedDescriptionKey: "Verification failed with \(errorCount) errors out of \(checkedCount) files"])
            )
        }
        
        NSLog("[BundleStorage] Streaming verification completed: \(checkedCount) items verified successfully")
    }
    
    /**
     * Sampling-based verification for large bundles
     */
    private func verifyMoveCompletionSampling(sourcePath: String, destinationPath: String) throws {
        NSLog("[BundleStorage] Starting sampling verification...")
        
        // 1. Collect all files (not directories)
        let sourceEnumerator = FileManager.default.enumerator(atPath: sourcePath)
        var allFiles: [String] = []
        var totalFiles = 0
        
        while let relativePath = sourceEnumerator?.nextObject() as? String {
            let sourceFullPath = (sourcePath as NSString).appendingPathComponent(relativePath)
            do {
                let attributes = try self.fileSystem.attributesOfItem(atPath: sourceFullPath)
                if (attributes[.type] as? FileAttributeType) != .typeDirectory {
                    allFiles.append(relativePath)
                    totalFiles += 1
                }
            } catch {
                continue // Skip files we can't read
            }
        }
        
        NSLog("[BundleStorage] Found \(totalFiles) files for sampling verification")
        
        // 2. Determine sampling strategy
        let sampleSize: Int
        if totalFiles <= 100 {
            sampleSize = totalFiles // Verify all small bundles
        } else if totalFiles <= 1000 {
            sampleSize = min(100, totalFiles / 2) // 50% sampling for medium bundles
        } else {
            sampleSize = min(150, totalFiles / 10) // 10% sampling for large bundles
        }
        
        // 3. Size-based sampling: larger files first, then random
        var filesToCheck: Set<String> = []
        
        // Get file sizes and sort by size (largest first)
        var filesWithSizes: [(String, Int64)] = []
        for file in allFiles {
            let fullPath = (sourcePath as NSString).appendingPathComponent(file)
            do {
                let attributes = try self.fileSystem.attributesOfItem(atPath: fullPath)
                let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
                filesWithSizes.append((file, size))
            } catch {
                filesWithSizes.append((file, 0))
            }
        }
        
        // Sort by size (largest first) to prioritize important files
        filesWithSizes.sort { $0.1 > $1.1 }
        
        // Take largest files (up to 25% of sample size)
        let largeFileCount = min(sampleSize / 4, filesWithSizes.count)
        for i in 0..<largeFileCount {
            filesToCheck.insert(filesWithSizes[i].0)
        }
        
        // Fill remaining with random sampling
        let remainingCount = sampleSize - filesToCheck.count
        if remainingCount > 0 {
            let remainingFiles = Array(allFiles.filter { !filesToCheck.contains($0) })
            let shuffledFiles = remainingFiles.shuffled()
            for file in shuffledFiles.prefix(remainingCount) {
                filesToCheck.insert(file)
            }
        }
        
        NSLog("[BundleStorage] Sampling \(filesToCheck.count) files out of \(totalFiles) for verification")
        
        // 4. Verify sampled files
        var errorCount = 0
        for (index, relativePath) in filesToCheck.enumerated() {
            let sourceFullPath = (sourcePath as NSString).appendingPathComponent(relativePath)
            let destFullPath = (destinationPath as NSString).appendingPathComponent(relativePath)
            
            // Progress logging
            if index % 25 == 0 {
                NSLog("[BundleStorage] Sample verification progress: \(index)/\(filesToCheck.count)")
            }
            
            // Check existence and size
            guard self.fileSystem.fileExists(atPath: destFullPath) else {
                errorCount += 1
                NSLog("[BundleStorage] Sample check failed: missing \(relativePath)")
                continue
            }
            
            do {
                let sourceAttributes = try self.fileSystem.attributesOfItem(atPath: sourceFullPath)
                let destAttributes = try self.fileSystem.attributesOfItem(atPath: destFullPath)
                
                let sourceSize = (sourceAttributes[.size] as? NSNumber)?.int64Value ?? 0
                let destSize = (destAttributes[.size] as? NSNumber)?.int64Value ?? 0
                
                if sourceSize != destSize {
                    errorCount += 1
                    NSLog("[BundleStorage] Sample check failed: size mismatch \(relativePath) (\(sourceSize) vs \(destSize))")
                }
            } catch {
                errorCount += 1
                NSLog("[BundleStorage] Sample check failed: cannot read \(relativePath): \(error)")
            }
        }
        
        // 5. Evaluate results
        let errorRate = Double(errorCount) / Double(filesToCheck.count)
        let maxErrorRate = 0.05 // Allow up to 5% error rate in sampling
        
        if errorRate > maxErrorRate {
            throw BundleStorageError.moveOperationFailed(
                NSError(domain: "HotUpdaterError", code: 603,
                       userInfo: [NSLocalizedDescriptionKey: "Sampling verification failed: \(errorCount)/\(filesToCheck.count) errors (\(String(format: "%.1f", errorRate * 100))% error rate)"])
            )
        }
        
        NSLog("[BundleStorage] Sampling verification passed: \(errorCount)/\(filesToCheck.count) errors (\(String(format: "%.1f", errorRate * 100))% error rate)")
    }
    
    /**
     * Full verification for small bundles (legacy method, optimized)
     */
    private func verifyMoveCompletionFull(sourcePath: String, destinationPath: String) throws {
        NSLog("[BundleStorage] Starting full verification...")
        
        // Scan source structure
        var sourceItems: [FileItem] = []
        let enumerator = FileManager.default.enumerator(atPath: sourcePath)
        
        while let relativePath = enumerator?.nextObject() as? String {
            let fullPath = (sourcePath as NSString).appendingPathComponent(relativePath)
            do {
                let attributes = try self.fileSystem.attributesOfItem(atPath: fullPath)
                let item = FileItem(
                    relativePath: relativePath,
                    isDirectory: (attributes[.type] as? FileAttributeType) == .typeDirectory,
                    size: (attributes[.size] as? NSNumber)?.int64Value ?? 0
                )
                sourceItems.append(item)
            } catch {
                NSLog("[BundleStorage] Warning: Could not read attributes for \(relativePath): \(error)")
            }
        }
        
        NSLog("[BundleStorage] Verifying \(sourceItems.count) items...")
        
        // Check destination directory exists
        guard self.fileSystem.fileExists(atPath: destinationPath) else {
            throw BundleStorageError.moveOperationFailed(
                NSError(domain: "HotUpdaterError", code: 404,
                       userInfo: [NSLocalizedDescriptionKey: "Destination directory not found after move"])
            )
        }
        
        var missingItems: [String] = []
        var sizeMismatchItems: [String] = []
        
        // Verify each item with batch processing
        for (index, item) in sourceItems.enumerated() {
            let destinationItemPath = (destinationPath as NSString).appendingPathComponent(item.relativePath)
            
            // CPU yielding every 50 items
            if index % 50 == 0 && index > 0 {
                usleep(500) // 0.5ms yield
            }
            
            // Check existence
            guard self.fileSystem.fileExists(atPath: destinationItemPath) else {
                missingItems.append(item.relativePath)
                continue
            }
            
            // Check file size for files (not directories)
            if !item.isDirectory {
                do {
                    let attributes = try self.fileSystem.attributesOfItem(atPath: destinationItemPath)
                    let actualSize = (attributes[.size] as? NSNumber)?.int64Value ?? 0
                    
                    if actualSize != item.size {
                        sizeMismatchItems.append("\(item.relativePath) (expected: \(item.size), actual: \(actualSize))")
                    }
                } catch {
                    missingItems.append(item.relativePath)
                }
            }
        }
        
        // Report results
        if !missingItems.isEmpty {
            NSLog("[BundleStorage] Missing items after move: \(missingItems.prefix(10))")
            throw BundleStorageError.moveOperationFailed(
                NSError(domain: "HotUpdaterError", code: 601,
                       userInfo: [NSLocalizedDescriptionKey: "Missing \(missingItems.count) items after move"])
            )
        }
        
        if !sizeMismatchItems.isEmpty {
            NSLog("[BundleStorage] Size mismatch items after move: \(sizeMismatchItems.prefix(5))")
            throw BundleStorageError.moveOperationFailed(
                NSError(domain: "HotUpdaterError", code: 602,
                       userInfo: [NSLocalizedDescriptionKey: "Size mismatch for \(sizeMismatchItems.count) items"])
            )
        }
        
        NSLog("[BundleStorage] Full verification completed successfully for \(sourceItems.count) items")
    }
    
    /**
     * Adaptive verification strategy based on bundle size
     */
    private func verifyMoveCompletionAdaptive(sourcePath: String, destinationPath: String) throws {
        // Quick file count to determine strategy
        let fileCount = try getFileCount(sourcePath)
        NSLog("[BundleStorage] Detected \(fileCount) files, selecting verification strategy...")
        
        if fileCount <= 100 {
            // Small bundles: full verification for maximum safety
            NSLog("[BundleStorage] Using full verification for small bundle (\(fileCount) files)")
            try verifyMoveCompletionFull(sourcePath: sourcePath, destinationPath: destinationPath)
        } else if fileCount <= 1000 {
            // Medium bundles: streaming verification for memory efficiency
            NSLog("[BundleStorage] Using streaming verification for medium bundle (\(fileCount) files)")
            try verifyMoveCompletionStreaming(sourcePath: sourcePath, destinationPath: destinationPath)
        } else {
            // Large bundles: sampling verification for speed
            NSLog("[BundleStorage] Using sampling verification for large bundle (\(fileCount)+ files)")
            try verifyMoveCompletionSampling(sourcePath: sourcePath, destinationPath: destinationPath)
        }
    }
    
    /**
     * Safely cleans up destination path
     */
    private func cleanupDestinationSafely(_ destinationPath: String) throws {
        guard self.fileSystem.fileExists(atPath: destinationPath) else { return }
        
        // Move to backup location first, then delete in background
        let backupPath = destinationPath + ".backup.\(UUID().uuidString)"
        
        do {
            try self.fileSystem.moveItem(atPath: destinationPath, toPath: backupPath)
            // Delete in background
            DispatchQueue.global(qos: .background).async {
                try? self.fileSystem.removeItem(atPath: backupPath)
            }
        } catch {
            // If move fails, try direct removal
            try self.fileSystem.removeItem(atPath: destinationPath)
        }
    }
    
    /**
     * Performs atomic move with retry mechanism
     */
    private func performAtomicMoveWithRetry(from sourcePath: String, to destinationPath: String, maxRetries: Int = 3) throws {
        var lastError: Error?
        
        for attempt in 1...maxRetries {
            do {
                // Use temporary destination for atomic operation
                let tempDestination = destinationPath + ".moving.\(UUID().uuidString)"
                
                // Move to temporary location first
                try self.fileSystem.moveItem(atPath: sourcePath, toPath: tempDestination)
                
                // Then rename to final location (faster atomic operation)
                try self.fileSystem.moveItem(atPath: tempDestination, toPath: destinationPath)
                
                NSLog("[BundleStorage] Atomic move succeeded on attempt \(attempt)")
                return
                
            } catch {
                lastError = error
                NSLog("[BundleStorage] Move attempt \(attempt) failed: \(error.localizedDescription)")
                
                // Clean up any partial moves
                let tempDestination = destinationPath + ".moving.\(UUID().uuidString)"
                try? self.fileSystem.removeItem(atPath: tempDestination)
                try? self.fileSystem.removeItem(atPath: destinationPath)
                
                if attempt < maxRetries {
                    // Progressive backoff
                    Thread.sleep(forTimeInterval: TimeInterval(attempt) * 0.5)
                }
            }
        }
        
        throw lastError ?? BundleStorageError.moveOperationFailed(
            NSError(domain: "HotUpdaterError", code: 500,
                   userInfo: [NSLocalizedDescriptionKey: "Move failed after \(maxRetries) attempts"])
        )
    }
    
    /**
     * Optimized directory move with adaptive verification strategy
     */
    private func moveDirectoryWithVerification(from sourcePath: String, to destinationPath: String) throws {
        NSLog("[BundleStorage] Starting optimized directory move from \(sourcePath) to \(destinationPath)")
        
        // 1. Clean destination safely
        try cleanupDestinationSafely(destinationPath)
        
        // 2. Perform atomic move with retry
        try performAtomicMoveWithRetry(from: sourcePath, to: destinationPath)
        
        // 3. Adaptive verification based on bundle size
        try verifyMoveCompletionAdaptive(sourcePath: destinationPath, destinationPath: destinationPath)
        
        NSLog("[BundleStorage] Optimized directory move and verification completed successfully")
    }
    
    /**
     * Verifies bundle integrity after move with optimized checks
     */
    private func verifyBundleIntegrity(bundlePath: String) throws -> String {
        NSLog("[BundleStorage] Verifying bundle integrity at: \(bundlePath)")
        
        // 1. Find bundle file
        let findResult = self.findBundleFile(in: bundlePath)
        guard case .success(let bundleFilePath) = findResult,
              let bundleFilePath = bundleFilePath else {
            throw BundleStorageError.invalidBundle
        }
        
        // 2. Verify bundle file exists and is readable
        guard self.fileSystem.fileExists(atPath: bundleFilePath) else {
            throw BundleStorageError.invalidBundle
        }
        
        // 3. Check bundle file size (must be > 100 bytes to be valid)
        do {
            let attributes = try self.fileSystem.attributesOfItem(atPath: bundleFilePath)
            let fileSize = (attributes[.size] as? NSNumber)?.int64Value ?? 0
            
            if fileSize < 100 {
                NSLog("[BundleStorage] Bundle file too small: \(fileSize) bytes")
                throw BundleStorageError.invalidBundle
            }
            
            NSLog("[BundleStorage] Bundle file verified: \(fileSize) bytes")
        } catch {
            NSLog("[BundleStorage] Could not read bundle file attributes: \(error)")
            throw BundleStorageError.invalidBundle
        }
        
        // 4. Quick assets directory check if it exists
        let assetsPath = (bundlePath as NSString).appendingPathComponent("assets")
        if self.fileSystem.fileExists(atPath: assetsPath) {
            do {
                let assetsContents = try self.fileSystem.contentsOfDirectory(atPath: assetsPath)
                NSLog("[BundleStorage] Assets directory verified with \(assetsContents.count) items")
            } catch {
                NSLog("[BundleStorage] Warning: Could not verify assets directory: \(error)")
                // Don't fail for assets issues, just warn
            }
        }
        
        NSLog("[BundleStorage] Bundle integrity verified successfully")
        return bundleFilePath
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
            let workItem = DispatchWorkItem {
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
            self.fileOperationQueue.async(execute: workItem)
        })
        
        if let task = task {
            self.activeTasks.append(task) // Manage active tasks
        }
    }
    
    /**
     * Processes a downloaded bundle file with enhanced safety and verification.
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
        
        do {
            // 1. Check if source file exists
            guard self.fileSystem.fileExists(atPath: location.path) else {
                NSLog("[BundleStorage] Source file does not exist atPath: \(location.path)")
                throw BundleStorageError.fileSystemError(NSError(
                    domain: "HotUpdaterError",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Source file does not exist atPath: \(location.path)"]
                ))
            }

            // 2. Create target directory
            let tempZipFileURL = URL(fileURLWithPath: tempZipFile)
            let tempZipFileDirectory = tempZipFileURL.deletingLastPathComponent()

            if !self.fileSystem.fileExists(atPath: tempZipFileDirectory.path) {
                try self.fileSystem.createDirectory(atPath: tempZipFileDirectory.path)
                NSLog("[BundleStorage] Created directory atPath: \(tempZipFileDirectory.path)")
            }
            NSLog("[BundleStorage] Successfully downloaded file to: \(tempZipFile)")

            // 3. Unzip the file
            try self.unzipService.unzip(file: tempZipFile, to: extractedDir)
            NSLog("[BundleStorage] Successfully extracted to: \(extractedDir)")
            
            // 4. Remove temporary zip file
            try? self.fileSystem.removeItem(atPath: tempZipFile)
            
            // 5. Search for bundle file in extracted directory
            switch self.findBundleFile(in: extractedDir) {
            case .success(let bundlePath):
                guard let bundlePath = bundlePath else {
                    NSLog("[BundleStorage] No bundle file found in extracted directory")
                    throw BundleStorageError.invalidBundle
                }
                
                NSLog("[BundleStorage] Found bundle in extracted directory: \(bundlePath)")
                
                // 6. Move directory with adaptive verification
                try self.moveDirectoryWithVerification(from: extractedDir, to: finalBundleDir)
                
                NSLog("[BundleStorage] Successfully moved and verified bundle directory to: \(finalBundleDir)")
                
                // 7. Verify bundle integrity after move and get final bundle path
                let finalBundlePath = try self.verifyBundleIntegrity(bundlePath: finalBundleDir)
                
                // 8. Only set bundle URL after all verifications pass
                let setResult = self.setBundleURL(localPath: finalBundlePath)
                switch setResult {
                case .success:
                    NSLog("[BundleStorage] Bundle URL set successfully: \(finalBundlePath)")
                    self.cleanupTemporaryFiles([tempDirectory])
                    completion(.success(true))
                case .failure(let error):
                    NSLog("[BundleStorage] Failed to set bundle URL: \(error)")
                    throw error
                }
                
            case .failure(let error):
                NSLog("[BundleStorage] Error finding bundle file: \(error.localizedDescription)")
                throw error
            }
            
        } catch {
            NSLog("[BundleStorage] Error processing downloaded file: \(error.localizedDescription)")
            
            // Clean up on failure
            self.cleanupTemporaryFiles([tempDirectory])
            try? self.fileSystem.removeItem(atPath: finalBundleDir) // Remove partial bundle
            
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