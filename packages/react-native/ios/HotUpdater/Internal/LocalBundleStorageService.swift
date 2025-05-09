import Foundation


protocol BundleStorageService {
    func bundleStoreDir() -> String
    
    func tempDir() -> String
    
    func findBundleFile(in directoryPath: String) -> String?
    
    func cleanupOldBundles(currentBundleId: String?)
    
    func setBundleURL(localPath: String?)
    
    func cachedBundleURL() -> URL?
    
    func fallbackBundleURL() -> URL?
    
    func resolveBundleURL() -> URL?
    
    func updateBundle(bundleId: String, fileUrl: URL?, completion: @escaping (Bool, Error?) -> Void)
}


class LocalBundleStorageService: BundleStorageService {
    private let fileSystem: FileSystemService
    private let downloadService: DownloadService
    private let unzipService: UnzipService
    private let preferences: PreferencesService
    
    private var activeTasks: [URLSessionTask] = []
    
    
    init(fileSystem: FileSystemService, 
         downloadService: DownloadService,
         unzipService: UnzipService,
         preferences: PreferencesService) {
        
        self.fileSystem = fileSystem
        self.downloadService = downloadService
        self.unzipService = unzipService
        self.preferences = preferences
    }
    
    
    func bundleStoreDir() -> String {
        return (fileSystem.documentsPath() as NSString).appendingPathComponent("bundle-store")
    }
    
    func tempDir() -> String {
        return (fileSystem.documentsPath() as NSString).appendingPathComponent("bundle-temp")
    }
    
    func findBundleFile(in directoryPath: String) -> String? {
        do {
            let items = try fileSystem.contentsOfDirectory(atPath: directoryPath)
            if let bundleFile = items.first(where: { $0 == "index.ios.bundle" }) {
                 return (directoryPath as NSString).appendingPathComponent(bundleFile)
            } else if let bundleFile = items.first(where: { $0 == "main.jsbundle" }) {
                 return (directoryPath as NSString).appendingPathComponent(bundleFile)
            }
        } catch {
            print("[BundleStorage] Error listing directory contents at \(directoryPath): \(error)")
        }
        print("[BundleStorage] Bundle file (index.ios.bundle or main.jsbundle) not found in \(directoryPath)")
        return nil
    }
    
    func cleanupOldBundles(currentBundleId: String?) {
        let storeDir = bundleStoreDir()
        guard let contents = try? fileSystem.contentsOfDirectory(atPath: storeDir) else {
             print("[BundleStorage] Failed to list contents of bundle store directory: \(storeDir)")
            return
        }

        var bundleDirs = [(path: String, modDate: Date)]()

        for item in contents {
            let fullPath = (storeDir as NSString).appendingPathComponent(item)
            if fileSystem.fileExists(atPath: fullPath) {
                do {
                    let attributes = try fileSystem.setAttributes([.modificationDate: Date()], ofItemAtPath: fullPath)
                    if let modDate = attributes[.modificationDate] as? Date {
                        bundleDirs.append((path: fullPath, modDate: modDate))
                    } else {
                        bundleDirs.append((path: fullPath, modDate: .distantPast))
                         print("[BundleStorage] Warning: Could not get modification date for \(fullPath), treating as old.")
                    }
                } catch {
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
            } catch {
                print("[BundleStorage] Failed to remove old bundle at \(oldBundle.path): \(error)")
            }
        }
    }
    
    func setBundleURL(localPath: String?) {
        print("[BundleStorage] Setting bundle URL to: \(localPath ?? "nil")")
        preferences.setItem(localPath, forKey: "HotUpdaterBundleURL")
    }
    
    func cachedBundleURL() -> URL? {
        guard let savedURLString = preferences.getItem(forKey: "HotUpdaterBundleURL"),
              let bundleURL = URL(string: savedURLString),
              fileSystem.fileExists(atPath: bundleURL.path) else {
            return nil
        }
        return bundleURL
    }
    
    func fallbackBundleURL() -> URL? {
        return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
    }
    
    func resolveBundleURL() -> URL? {
        let url = cachedBundleURL()
        print("[BundleStorage] Resolved bundle URL: \(url?.absoluteString ?? "Fallback")")
        return url ?? fallbackBundleURL()
    }
    
    func updateBundle(bundleId: String, fileUrl: URL?, completion: @escaping (Bool, Error?) -> Void) {
        guard let validFileUrl = fileUrl else {
            print("[BundleStorage] fileUrl is nil, resetting bundle URL.")
            setBundleURL(localPath: nil)
            cleanupOldBundles(currentBundleId: nil)
            completion(true, nil)
            return
        }
        
        let storeDir = bundleStoreDir()
        let finalBundleDir = (storeDir as NSString).appendingPathComponent(bundleId)
        
        if fileSystem.fileExists(atPath: finalBundleDir) {
            if let existingBundlePath = findBundleFile(in: finalBundleDir) {
                print("[BundleStorage] Using cached bundle at path: \(existingBundlePath)")
                try? fileSystem.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir)
                setBundleURL(localPath: existingBundlePath)
                cleanupOldBundles(currentBundleId: bundleId)
                completion(true, nil)
                return
            } else {
                print("[BundleStorage] Cached directory exists but invalid, removing: \(finalBundleDir)")
                try? fileSystem.removeItem(atPath: finalBundleDir)
            }
        }
        
        let tempDirectory = tempDir()
        _ = try? fileSystem.removeItem(atPath: tempDirectory)
        
        guard fileSystem.createDirectory(at: tempDirectory), fileSystem.createDirectory(at: storeDir) else {
            let error = NSError(domain: "HotUpdaterError", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to create temporary or bundle store directories"])
            completion(false, error)
            return
        }
        
        let tempZipFile = (tempDirectory as NSString).appendingPathComponent("bundle.zip")
        let extractedDir = (tempDirectory as NSString).appendingPathComponent("extracted")
        
        guard fileSystem.createDirectory(at: extractedDir) else {
            let error = NSError(domain: "HotUpdaterError", code: 3, userInfo: [NSLocalizedDescriptionKey: "Failed to create extracted directory"])
            completion(false, error)
            return
        }
        
        print("[BundleStorage] Starting download from \(validFileUrl)")
        
        let task = downloadService.downloadFile(from: validFileUrl, to: tempZipFile, progressHandler: { progress in
        }, completion: { [weak self] result in
            guard let self = self else {
                completion(false, NSError(domain: "HotUpdaterError", code: 998, userInfo: [NSLocalizedDescriptionKey: "Self deallocated during download"]))
                return
            }
            
            switch result {
            case .success(let location):
                self.processDownloadedFile(location: location, tempZipFile: tempZipFile, extractedDir: extractedDir, finalBundleDir: finalBundleDir, bundleId: bundleId, tempDirectory: tempDirectory, completion: completion)
                
            case .failure(let error):
                print("[BundleStorage] Download failed: \(error.localizedDescription)")
                try? self.fileSystem.removeItem(atPath: tempDirectory)
                completion(false, error)
            }
        })
        
        if let task = task {
            activeTasks.append(task)
        }
    }
    
    private func processDownloadedFile(location: URL, tempZipFile: String, extractedDir: String, finalBundleDir: String, bundleId: String, tempDirectory: String, completion: @escaping (Bool, Error?) -> Void) {
        
        do {
            try? fileSystem.removeItem(atPath: tempZipFile)
            try fileSystem.moveItem(at: location, to: URL(fileURLWithPath: tempZipFile))
        } catch let moveError {
            print("[BundleStorage] Failed to move downloaded file: \(moveError.localizedDescription)")
            try? fileSystem.removeItem(atPath: tempDirectory)
            completion(false, moveError)
            return
        }
        
        do {
            try unzipService.unzip(file: tempZipFile, to: extractedDir)
            
            if !fileSystem.fileExists(atPath: extractedDir) {
                throw NSError(domain: "HotUpdaterError", code: 5, userInfo: [NSLocalizedDescriptionKey: "Extraction directory does not exist"])
            }
            
            let contents = try fileSystem.contentsOfDirectory(atPath: extractedDir)
            if contents.isEmpty {
                throw NSError(domain: "HotUpdaterError", code: 5, userInfo: [NSLocalizedDescriptionKey: "No files were extracted"])
            }
        } catch let unzipError {
            print("[BundleStorage] Extraction failed: \(unzipError.localizedDescription)")
            let error = NSError(domain: "HotUpdaterError", code: 5, userInfo: [NSLocalizedDescriptionKey: "Failed to unzip file: \(unzipError.localizedDescription)"])
            try? fileSystem.removeItem(atPath: tempDirectory)
            completion(false, error)
            return
        }
        
        guard let _ = findBundleFile(in: extractedDir) else {
            let error = NSError(domain: "HotUpdaterError", code: 6, userInfo: [NSLocalizedDescriptionKey: "index.ios.bundle or main.jsbundle not found in extracted files"])
            try? fileSystem.removeItem(atPath: tempDirectory)
            completion(false, error)
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
                completion(false, copyError)
                return
            }
        }
        
        guard let finalBundlePath = findBundleFile(in: finalBundleDir) else {
            let error = NSError(domain: "HotUpdaterError", code: 7, userInfo: [NSLocalizedDescriptionKey: "Bundle file not found in final directory after move/copy"])
            try? fileSystem.removeItem(atPath: finalBundleDir)
            try? fileSystem.removeItem(atPath: tempDirectory)
            completion(false, error)
            return
        }
        
        print("[BundleStorage] Bundle update successful. Path: \(finalBundlePath)")
        setBundleURL(localPath: finalBundlePath)
        cleanupOldBundles(currentBundleId: bundleId)
        try? fileSystem.removeItem(atPath: tempDirectory)
        completion(true, nil)
    }
}