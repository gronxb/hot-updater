import Foundation

public protocol BundleStorageService {
    func bundleStoreDir() -> String
    
    func tempDir() -> String
    
    func findBundleFile(in directoryPath: String) -> String?
    
    func cleanupOldBundles(currentBundleId: String?)
    
    func setBundleURL(localPath: String?)
    
    func cachedBundleURL() -> URL?
    
    func fallbackBundleURL() -> URL?
    
    func resolveBundleURL() -> URL?
    
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
    
    
    func bundleStoreDir() throws -> String {
        let path = (fileSystem.documentsPath() as NSString).appendingPathComponent("bundle-store")
        
        // 디렉토리 존재 확인 및 생성 시도
        if !fileSystem.fileExists(atPath: path) {
            if !fileSystem.createDirectory(at: path) {
                throw BundleStorageError.directoryCreationFailed
            }
        }
        
        return path
    }
    
    func tempDir() throws -> String {
        let path = (fileSystem.documentsPath() as NSString).appendingPathComponent("bundle-temp")
        
        // 디렉토리 존재 확인 및 생성 시도
        if !fileSystem.fileExists(atPath: path) {
            if !fileSystem.createDirectory(at: path) {
                throw BundleStorageError.directoryCreationFailed
            }
        }
        
        return path
    }
    
    func findBundleFile(in directoryPath: String) throws -> String? {
        do {
            let items = try fileSystem.contentsOfDirectory(atPath: directoryPath)
            if let bundleFile = items.first(where: { $0 == "index.ios.bundle" }) {
                 return (directoryPath as NSString).appendingPathComponent(bundleFile)
            } else if let bundleFile = items.first(where: { $0 == "main.jsbundle" }) {
                 return (directoryPath as NSString).appendingPathComponent(bundleFile)
            }
        } catch let error {
            print("[BundleStorage] Error listing directory contents at \(directoryPath): \(error)")
            throw BundleStorageError.fileSystemError(error)
        }
        print("[BundleStorage] Bundle file (index.ios.bundle or main.jsbundle) not found in \(directoryPath)")
        return nil
    }
    
    func cleanupOldBundles(currentBundleId: String?) throws {
        let storeDir = try bundleStoreDir()
        
        var contents: [String]
        do {
            contents = try fileSystem.contentsOfDirectory(atPath: storeDir)
        } catch let error {
            print("[BundleStorage] Failed to list contents of bundle store directory: \(storeDir)")
            throw BundleStorageError.fileSystemError(error)
        }

        var bundleDirs = [(path: String, modDate: Date)]()

        for item in contents {
            let fullPath = (storeDir as NSString).appendingPathComponent(item)
            if fileSystem.fileExists(atPath: fullPath) {
                do {
                    let attributes = try fileSystem.attributesOfItem(atPath: fullPath)
                    if let modDate = attributes[FileAttributeKey.modificationDate] as? Date {
                        bundleDirs.append((path: fullPath, modDate: modDate))
                    } else {
                        bundleDirs.append((path: fullPath, modDate: .distantPast))
                         print("[BundleStorage] Warning: Could not get modification date for \(fullPath), treating as old.")
                    }
                } catch let error {
                     print("[BundleStorage] Warning: Could not get attributes for \(fullPath): \(error)")
                     bundleDirs.append((path: fullPath, modDate: .distantPast))
                }
            }
        }

        bundleDirs.sort { $0.modDate > $1.modDate }

        var bundlesToKeep = Set<String>()

        if let currentId = currentBundleId, let currentPath = bundleDirs.first(where: { ($0.path as NSString).lastPathComponent == currentId })?.path {
            bundlesToKeep.insert(currentPath)
            print("[BundleStorage] Keeping current bundle: \(currentId)")
        }

        if let latestBundle = bundleDirs.first {
            bundlesToKeep.insert(latestBundle.path)
             print("[BundleStorage] Keeping latest bundle (by mod date): \((latestBundle.path as NSString).lastPathComponent)")
        }

        let bundlesToRemove = bundleDirs.filter { !bundlesToKeep.contains($0.path) }

        if bundlesToRemove.isEmpty {
            print("[BundleStorage] No old bundles to remove.")
        } else {
            print("[BundleStorage] Found \(bundlesToRemove.count) old bundle(s) to remove.")
        }

        for oldBundle in bundlesToRemove {
            do {
                try fileSystem.removeItem(atPath: oldBundle.path)
                print("[BundleStorage] Removed old bundle: \((oldBundle.path as NSString).lastPathComponent)")
            } catch let error {
                print("[BundleStorage] Failed to remove old bundle at \(oldBundle.path): \(error)")
                // 이 에러는 크리티컬하지 않으므로 다음 번들 삭제 시도는 계속합니다
            }
        }
    }
    
    func setBundleURL(localPath: String?) throws {
        print("[BundleStorage] Setting bundle URL to: \(localPath ?? "nil")")
        try preferences.setItem(localPath, forKey: "HotUpdaterBundleURL")
    }
    
    func cachedBundleURL() throws -> URL? {
        guard let savedURLString = try preferences.getItem(forKey: "HotUpdaterBundleURL"),
              let bundleURL = URL(string: savedURLString),
              fileSystem.fileExists(atPath: bundleURL.path) else {
            return nil
        }
        return bundleURL
    }
    
    func fallbackBundleURL() -> URL? {
        return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
    }
    
    func resolveBundleURL() throws -> URL? {
        let url = try cachedBundleURL()
        print("[BundleStorage] Resolved bundle URL: \(url?.absoluteString ?? "Fallback")")
        return url ?? fallbackBundleURL()
    }
    
    func updateBundle(bundleId: String, fileUrl: URL?, completion: @escaping (Result<Bool, Error>) -> Void) {
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
            
            if fileSystem.fileExists(atPath: finalBundleDir) {
                if let existingBundlePath = try findBundleFile(in: finalBundleDir) {
                    print("[BundleStorage] Using cached bundle at path: \(existingBundlePath)")
                    do {
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
            
            let tempDirectory = try tempDir()
            do {
                try fileSystem.removeItem(atPath: tempDirectory)
            } catch {
                // 디렉토리가 없을 수 있으므로 무시
            }
            
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
        
        let task = downloadService.downloadFile(from: validFileUrl, to: tempZipFile, progressHandler: { progress in
        }, completion: { [weak self] result in
            guard let self = self else {
                let error = NSError(domain: "HotUpdaterError", code: 998, userInfo: [NSLocalizedDescriptionKey: "Self deallocated during download"])
                completion(.failure(error))
                return
            }
            
            switch result {
            case .success(let location):
                self.processDownloadedFile(location: location, tempZipFile: tempZipFile, extractedDir: extractedDir, finalBundleDir: finalBundleDir, bundleId: bundleId, tempDirectory: tempDirectory, completion: completion)
                
            case .failure(let error):
                print("[BundleStorage] Download failed: \(error.localizedDescription)")
                try? self.fileSystem.removeItem(atPath: tempDirectory)
                completion(.failure(BundleStorageError.downloadFailed(error)))
            }
        })
        
        if let task = task {
            activeTasks.append(task)
        }
    }
    
    private func processDownloadedFile(location: URL, tempZipFile: String, extractedDir: String, finalBundleDir: String, bundleId: String, tempDirectory: String, completion: @escaping (Result<Bool, Error>) -> Void) {
        
        do {
            try? fileSystem.removeItem(atPath: tempZipFile)
            try fileSystem.moveItem(at: location, to: URL(fileURLWithPath: tempZipFile))
        } catch let moveError {
            print("[BundleStorage] Failed to move downloaded file: \(moveError.localizedDescription)")
            try? fileSystem.removeItem(atPath: tempDirectory)
            completion(.failure(BundleStorageError.moveOperationFailed(moveError)))
            return
        }
        
        do {
            try unzipService.unzip(file: tempZipFile, to: extractedDir)
            
            if !fileSystem.fileExists(atPath: extractedDir) {
                let error = BundleStorageError.extractionFailed(NSError(domain: "HotUpdaterError", code: 5, userInfo: [NSLocalizedDescriptionKey: "Extraction directory does not exist"]))
                try? fileSystem.removeItem(atPath: tempDirectory)
                completion(.failure(error))
                return
            }
            
            let contents = try fileSystem.contentsOfDirectory(atPath: extractedDir)
            if contents.isEmpty {
                let error = BundleStorageError.extractionFailed(NSError(domain: "HotUpdaterError", code: 5, userInfo: [NSLocalizedDescriptionKey: "No files were extracted"]))
                try? fileSystem.removeItem(atPath: tempDirectory)
                completion(.failure(error))
                return
            }
        } catch let unzipError {
            print("[BundleStorage] Extraction failed: \(unzipError.localizedDescription)")
            try? fileSystem.removeItem(atPath: tempDirectory)
            completion(.failure(BundleStorageError.extractionFailed(unzipError)))
            return
        }
        
        do {
            guard let _ = try findBundleFile(in: extractedDir) else {
                let error = BundleStorageError.invalidBundle
                try? fileSystem.removeItem(atPath: tempDirectory)
                completion(.failure(error))
                return
            }
        } catch let error {
            print("[BundleStorage] Failed to find bundle file in extracted directory: \(error)")
            try? fileSystem.removeItem(atPath: tempDirectory)
            completion(.failure(error))
            return
        }
        
        do {
            try? fileSystem.removeItem(atPath: finalBundleDir)
            try fileSystem.moveItem(at: URL(fileURLWithPath: extractedDir), to: URL(fileURLWithPath: finalBundleDir))
            try? fileSystem.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir)
        } catch {
            print("[BundleStorage] Move failed, attempting copy: \(error.localizedDescription)")
            do {
                try fileSystem.copyItem(atPath: extractedDir, toPath: finalBundleDir)
                try fileSystem.removeItem(atPath: extractedDir)
                try? fileSystem.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir)
            } catch let copyError {
                print("[BundleStorage] Copy also failed: \(copyError.localizedDescription)")
                try? fileSystem.removeItem(atPath: tempDirectory)
                try? fileSystem.removeItem(atPath: finalBundleDir)
                completion(.failure(BundleStorageError.copyOperationFailed(copyError)))
                return
            }
        }
        
        do {
            guard let finalBundlePath = try findBundleFile(in: finalBundleDir) else {
                let error = BundleStorageError.bundleNotFound
                try? fileSystem.removeItem(atPath: finalBundleDir)
                try? fileSystem.removeItem(atPath: tempDirectory)
                completion(.failure(error))
                return
            }
            
            print("[BundleStorage] Bundle update successful. Path: \(finalBundlePath)")
            try setBundleURL(localPath: finalBundlePath)
            try cleanupOldBundles(currentBundleId: bundleId)
            try? fileSystem.removeItem(atPath: tempDirectory)
            completion(.success(true))
        } catch let error {
            print("[BundleStorage] Final bundle processing failed: \(error)")
            try? fileSystem.removeItem(atPath: tempDirectory)
            completion(.failure(error))
        }
    }
}