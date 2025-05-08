import Foundation
import React

@objcMembers public class HotUpdaterImpl: NSObject {
    private let fileSystem: FileSystemService
    private let bundleStorage: BundleStorageService
    private let preferences: PreferencesService
    private let downloadService: DownloadService
    private let unzipService: UnzipService
    
    private var activeTasks: [URLSessionTask] = []
    
    public convenience override init() {
        let fileSystem = FileManagerService()
        let bundleStorage = LocalBundleStorageService(fileSystem: fileSystem)
        let preferences = UserDefaultsPreferencesService()
        let downloadService = URLSessionDownloadService()
        let unzipService = SSZipArchiveUnzipService()
        
        self.init(
            fileSystem: fileSystem,
            bundleStorage: bundleStorage,
            preferences: preferences,
            downloadService: downloadService,
            unzipService: unzipService
        )
    }
    
    init(fileSystem: FileSystemService, 
         bundleStorage: BundleStorageService, 
         preferences: PreferencesService, 
         downloadService: DownloadService,
         unzipService: UnzipService) {
        
        self.fileSystem = fileSystem
        self.bundleStorage = bundleStorage
        self.preferences = preferences
        self.downloadService = downloadService
        self.unzipService = unzipService
        
        super.init()
        
        if let appVersion = HotUpdaterImpl.appVersion {
            (preferences as? UserDefaultsPreferencesService)?.configure(appVersion: appVersion)
        }
    }
    
    public static var appVersion: String? {
        return Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    }
    
    public func setChannel(_ channel: String?) {
        preferences.setItem(channel, forKey: "HotUpdaterChannel")
        print("[HotUpdaterImpl] Channel set to: \(channel ?? "nil")")
    }
    
    public func getChannel() -> String? {
        return preferences.getItem(forKey: "HotUpdaterChannel")
    }
    
    private func setBundleURLInternal(localPath: String?) {
        print("[HotUpdaterImpl] Setting bundle URL to: \(localPath ?? "nil")")
        preferences.setItem(localPath, forKey: "HotUpdaterBundleURL")
    }
    
    private func cachedURLFromBundle() -> URL? {
        guard let savedURLString = preferences.getItem(forKey: "HotUpdaterBundleURL"),
              let bundleURL = URL(string: savedURLString),
              fileSystem.fileExists(atPath: bundleURL.path) else {
            return nil
        }
        return bundleURL
    }
    
    private func fallbackURL() -> URL? {
        return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
    }
    
    public func bundleURL() -> URL? {
        let url = cachedURLFromBundle()
        print("[HotUpdaterImpl] Resolved bundle URL: \(url?.absoluteString ?? "Fallback")")
        return url ?? self.fallbackURL()
    }
    
    @objc public func updateBundleFromJS(_ params: NSDictionary?,
                                         resolver resolve: @escaping RCTPromiseResolveBlock,
                                         rejecter reject: @escaping RCTPromiseRejectBlock) {
        
        guard let data = params else {
            print("[HotUpdaterImpl] Error: params dictionary is nil")
            let error = NSError(domain: "HotUpdaterError", code: 101, userInfo: [NSLocalizedDescriptionKey: "Missing params dictionary"])
            reject("UPDATE_ERROR", error.localizedDescription, error)
            return
        }
        
        guard let bundleId = data["bundleId"] as? String, !bundleId.isEmpty else {
            print("[HotUpdaterImpl] Error: Missing or empty 'bundleId'")
            let error = NSError(domain: "HotUpdaterError", code: 102, userInfo: [NSLocalizedDescriptionKey: "Missing or empty 'bundleId'"])
            reject("UPDATE_ERROR", error.localizedDescription, error)
            return
        }
        
        let fileUrlString = data["fileUrl"] as? String ?? ""
        
        var fileUrl: URL? = nil
        if !fileUrlString.isEmpty {
            guard let url = URL(string: fileUrlString) else {
                print("[HotUpdaterImpl] Error: Invalid 'fileUrl': \(fileUrlString)")
                let error = NSError(domain: "HotUpdaterError", code: 103, userInfo: [NSLocalizedDescriptionKey: "Invalid 'fileUrl' provided: \(fileUrlString)"])
                reject("UPDATE_ERROR", error.localizedDescription, error)
                return
            }
            fileUrl = url
        }
        
        print("[HotUpdaterImpl] updateBundleFromJS called with bundleId: \(bundleId), fileUrl: \(fileUrl?.absoluteString ?? "nil")")
        
        updateBundleInternal(bundleId: bundleId, fileUrl: fileUrl) { success, error in
            if success {
                print("[HotUpdaterImpl] Update successful for \(bundleId). Resolving promise.")
                resolve(true)
            } else {
                let resolvedError = error ?? NSError(domain: "HotUpdaterError", code: 999, userInfo: [NSLocalizedDescriptionKey: "Unknown update error"])
                print("[HotUpdaterImpl] Update failed for \(bundleId): \(resolvedError.localizedDescription). Rejecting promise.")
                reject("UPDATE_ERROR", resolvedError.localizedDescription, resolvedError)
            }
        }
    }
    
    private func updateBundleInternal(bundleId: String, fileUrl: URL?,
                                      completion: @escaping (Bool, Error?) -> Void) {
        
        guard let validFileUrl = fileUrl else {
            print("[HotUpdaterImpl] fileUrl is nil, resetting bundle URL.")
            setBundleURLInternal(localPath: nil)
            bundleStorage.cleanupOldBundles(currentBundleId: nil)
            completion(true, nil)
            return
        }
        
        let storeDir = bundleStorage.bundleStoreDir()
        let finalBundleDir = (storeDir as NSString).appendingPathComponent(bundleId)
        
        // 이미 존재하는 번들인지 체크
        if fileSystem.fileExists(atPath: finalBundleDir) {
            print("[HotUpdaterImpl] Bundle already exists for bundleId: \(bundleId). Rejecting update.")
            let error = NSError(domain: "HotUpdaterError", code: 409, userInfo: [NSLocalizedDescriptionKey: "Bundle already exists. Preventing infinite updates."])
            completion(false, error)
            return
        }
        
        let tempDirectory = bundleStorage.tempDir()
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
        
        print("[HotUpdaterImpl] Starting download from \(validFileUrl)")
        
        let task = downloadService.downloadFile(from: validFileUrl, to: tempZipFile, progressHandler: { progress in
            // 진행상황 처리는 DownloadService에서 처리됨
        }, completion: { [weak self] result in
            guard let self = self else {
                completion(false, NSError(domain: "HotUpdaterError", code: 998, userInfo: [NSLocalizedDescriptionKey: "Self deallocated during download"]))
                return
            }
            
            switch result {
            case .success(let location):
                self.processDownloadedFile(location: location, tempZipFile: tempZipFile, extractedDir: extractedDir, finalBundleDir: finalBundleDir, bundleId: bundleId, tempDirectory: tempDirectory, completion: completion)
                
            case .failure(let error):
                print("[HotUpdaterImpl] Download failed: \(error.localizedDescription)")
                try? self.fileSystem.removeItem(atPath: tempDirectory)
                completion(false, error)
            }
        })
        
        if let task = task {
            activeTasks.append(task)
        }
    }
    
    private func processDownloadedFile(location: URL, tempZipFile: String, extractedDir: String, finalBundleDir: String, bundleId: String, tempDirectory: String, completion: @escaping (Bool, Error?) -> Void) {
        
        // 1. 다운로드된 파일 이동
        do {
            try? fileSystem.removeItem(atPath: tempZipFile)
            try fileSystem.moveItem(at: location, to: URL(fileURLWithPath: tempZipFile))
        } catch let moveError {
            print("[HotUpdaterImpl] Failed to move downloaded file: \(moveError.localizedDescription)")
            try? fileSystem.removeItem(atPath: tempDirectory)
            completion(false, moveError)
            return
        }
        
        // 2. 압축 해제
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
            print("[HotUpdaterImpl] Extraction failed: \(unzipError.localizedDescription)")
            let error = NSError(domain: "HotUpdaterError", code: 5, userInfo: [NSLocalizedDescriptionKey: "Failed to unzip file: \(unzipError.localizedDescription)"])
            try? fileSystem.removeItem(atPath: tempDirectory)
            completion(false, error)
            return
        }
        
        // 3. 번들 파일 확인
        guard let _ = bundleStorage.findBundleFile(in: extractedDir) else {
            let error = NSError(domain: "HotUpdaterError", code: 6, userInfo: [NSLocalizedDescriptionKey: "index.ios.bundle or main.jsbundle not found in extracted files"])
            try? fileSystem.removeItem(atPath: tempDirectory)
            completion(false, error)
            return
        }
        
        // 4. 최종 디렉토리로 이동
        do {
            try? fileSystem.removeItem(atPath: finalBundleDir)
            try fileSystem.moveItem(at: URL(fileURLWithPath: extractedDir), to: URL(fileURLWithPath: finalBundleDir))
            try? fileSystem.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir)
        } catch {
            print("[HotUpdaterImpl] Move failed, attempting copy: \(error.localizedDescription)")
            do {
                try fileSystem.copyItem(atPath: extractedDir, toPath: finalBundleDir)
                try fileSystem.removeItem(atPath: extractedDir)
                try? fileSystem.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir)
            } catch let copyError {
                print("[HotUpdaterImpl] Copy also failed: \(copyError.localizedDescription)")
                try? fileSystem.removeItem(atPath: tempDirectory)
                try? fileSystem.removeItem(atPath: finalBundleDir)
                completion(false, copyError)
                return
            }
        }
        
        // 5. 최종 번들 검증
        guard let finalBundlePath = bundleStorage.findBundleFile(in: finalBundleDir) else {
            let error = NSError(domain: "HotUpdaterError", code: 7, userInfo: [NSLocalizedDescriptionKey: "Bundle file not found in final directory after move/copy"])
            try? fileSystem.removeItem(atPath: finalBundleDir)
            try? fileSystem.removeItem(atPath: tempDirectory)
            completion(false, error)
            return
        }
        
        // 6. 성공 처리
        print("[HotUpdaterImpl] Bundle update successful. Path: \(finalBundlePath)")
        setBundleURLInternal(localPath: finalBundlePath)
        bundleStorage.cleanupOldBundles(currentBundleId: bundleId)
        try? fileSystem.removeItem(atPath: tempDirectory)
        completion(true, nil)
    }
}