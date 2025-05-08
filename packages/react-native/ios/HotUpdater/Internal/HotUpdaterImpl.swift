import Foundation
import SSZipArchive
import React

@objcMembers public class HotUpdaterImpl: NSObject {

    private let fileManager = FileManager.default
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.default
        return URLSession(configuration: configuration, delegate: nil, delegateQueue: nil)
    }()


    private let prefs = HotUpdaterPrefs.shared

    public override init() {
        super.init()
        prefs.configure(appVersion: HotUpdaterImpl.appVersion)
    }


    public static var appVersion: String? {
        return Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    }


    public func setChannel(_ channel: String?) {
        prefs.setItem(channel, forKey: "HotUpdaterChannel")
        print("[HotUpdaterImpl] Channel set to: \(channel ?? "nil")")
    }

    public func getChannel() -> String? {
        return prefs.getItem(forKey: "HotUpdaterChannel")
    }


    private func setBundleURLInternal(localPath: String?) {
        print("[HotUpdaterImpl] Setting bundle URL to: \(localPath ?? "nil")")
        prefs.setItem(localPath, forKey: "HotUpdaterBundleURL")
    }

    private func cachedURLFromBundle() -> URL? {
        guard let savedURLString = prefs.getItem(forKey: "HotUpdaterBundleURL"),
              let bundleURL = URL(string: savedURLString),
              fileManager.fileExists(atPath: bundleURL.path) else {
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

        let zipUrlString = data["zipUrl"] as? String ?? ""

        var zipUrl: URL? = nil
        if !zipUrlString.isEmpty {
            guard let url = URL(string: zipUrlString) else {
                print("[HotUpdaterImpl] Error: Invalid 'zipUrl': \(zipUrlString)")
                let error = NSError(domain: "HotUpdaterError", code: 103, userInfo: [NSLocalizedDescriptionKey: "Invalid 'zipUrl' provided: \(zipUrlString)"])
                reject("UPDATE_ERROR", error.localizedDescription, error)
                return
            }
            zipUrl = url
        }

        print("[HotUpdaterImpl] updateBundleFromJS called with bundleId: \(bundleId), zipUrl: \(zipUrl?.absoluteString ?? "nil")")

        updateBundleInternal(bundleId: bundleId, zipUrl: zipUrl) { success, error in
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


    private func updateBundleInternal(bundleId: String, zipUrl: URL?,
                                      completion: @escaping (Bool, Error?) -> Void) {


        guard let validZipUrl = zipUrl else {
            print("[HotUpdaterImpl] zipUrl is nil, resetting bundle URL.")
            setBundleURLInternal(localPath: nil)
            cleanupOldBundles(currentBundleId: nil)
            completion(true, nil)
            return
        }

        let storeDir = bundleStoreDir()
        let finalBundleDir = (storeDir as NSString).appendingPathComponent(bundleId)

        if fileManager.fileExists(atPath: finalBundleDir),
           let existingBundlePath = findBundleFile(in: finalBundleDir) {
            print("[HotUpdaterImpl] Using cached bundle at path: \(existingBundlePath)")
            try? fileManager.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir)
            setBundleURLInternal(localPath: existingBundlePath)
            cleanupOldBundles(currentBundleId: bundleId)
            completion(true, nil)
            return
        } else if fileManager.fileExists(atPath: finalBundleDir) {
             print("[HotUpdaterImpl] Cached directory exists but invalid, removing: \(finalBundleDir)")
             try? fileManager.removeItem(atPath: finalBundleDir)
        }

        let tempDirectory = tempDir()
        _ = try? fileManager.removeItem(atPath: tempDirectory)
        guard createDir(at: tempDirectory), createDir(at: storeDir) else {
            let error = NSError(domain: "HotUpdaterError", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to create temporary or bundle store directories"])
            completion(false, error)
            return
        }
        let tempZipFile = (tempDirectory as NSString).appendingPathComponent("bundle.zip")
        let extractedDir = (tempDirectory as NSString).appendingPathComponent("extracted")
        guard createDir(at: extractedDir) else {
            let error = NSError(domain: "HotUpdaterError", code: 3, userInfo: [NSLocalizedDescriptionKey: "Failed to create extracted directory"])
            completion(false, error)
            return
        }
        print("[HotUpdaterImpl] Starting download from \(validZipUrl)")
        
        var task: URLSessionDownloadTask!
        
        let downloadCompletionHandler: (URL?, URLResponse?, Error?) -> Void = { [weak self] location, response, error in
            guard let self = self else {
                completion(false, NSError(domain: "HotUpdaterError", code: 998, userInfo: [NSLocalizedDescriptionKey: "Self deallocated during download"]))
                return
            }

            defer {
                NotificationCenter.default.post(name: .downloadDidFinish, object: task)
                DispatchQueue.main.async {
                    print("[HotUpdaterImpl] Attempting to remove observers post-download.")
                }
            }


            if let error = error {
                print("[HotUpdaterImpl] Download failed: \(error.localizedDescription)")
                try? self.fileManager.removeItem(atPath: tempDirectory)
                completion(false, error)
                return
            }
            guard let location = location else {
                 let error = NSError(domain: "HotUpdaterError", code: 4, userInfo: [NSLocalizedDescriptionKey: "Download location URL is nil"])
                 try? self.fileManager.removeItem(atPath: tempDirectory)
                 completion(false, error)
                 return
            }

            do {
                 try? self.fileManager.removeItem(atPath: tempZipFile)
                 try self.fileManager.moveItem(at: location, to: URL(fileURLWithPath: tempZipFile))
             } catch let moveError {
                 print("[HotUpdaterImpl] Failed to move downloaded file: \(moveError.localizedDescription)")
                 try? self.fileManager.removeItem(atPath: tempDirectory)
                 completion(false, moveError)
                 return
             }
            do {
                try SSZipArchive.unzipFile(atPath: tempZipFile, toDestination: extractedDir, overwrite: true, password: nil)
                
                if !self.fileManager.fileExists(atPath: extractedDir) {
                    throw NSError(domain: "HotUpdaterError", code: 5, userInfo: [NSLocalizedDescriptionKey: "Extraction directory does not exist"])
                }
                
                let contents = try self.fileManager.contentsOfDirectory(atPath: extractedDir)
                if contents.isEmpty {
                    throw NSError(domain: "HotUpdaterError", code: 5, userInfo: [NSLocalizedDescriptionKey: "No files were extracted"])
                }
            } catch let unzipError {
                print("[HotUpdaterImpl] Extraction failed: \(unzipError.localizedDescription)")
                let error = NSError(domain: "HotUpdaterError", code: 5, userInfo: [NSLocalizedDescriptionKey: "Failed to unzip file: \(unzipError.localizedDescription)"])
                try? self.fileManager.removeItem(atPath: tempDirectory)
                completion(false, error)
                return
            }

             guard let _ = self.findBundleFile(in: extractedDir) else {
                  let error = NSError(domain: "HotUpdaterError", code: 6, userInfo: [NSLocalizedDescriptionKey: "index.ios.bundle or main.jsbundle not found in extracted files"])
                  try? self.fileManager.removeItem(atPath: tempDirectory)
                  completion(false, error)
                  return
             }

             do {
                 try? self.fileManager.removeItem(atPath: finalBundleDir)
                 try self.fileManager.moveItem(atPath: extractedDir, toPath: finalBundleDir)
                 try? self.fileManager.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir)
             } catch {
                 print("[HotUpdaterImpl] Move failed, attempting copy: \(error.localizedDescription)")
                 do {
                    try self.fileManager.copyItem(atPath: extractedDir, toPath: finalBundleDir)
                    try self.fileManager.removeItem(atPath: extractedDir)
                    try? self.fileManager.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir)
                 } catch let copyError {
                    print("[HotUpdaterImpl] Copy also failed: \(copyError.localizedDescription)")
                    try? self.fileManager.removeItem(atPath: tempDirectory)
                    try? self.fileManager.removeItem(atPath: finalBundleDir)
                    completion(false, copyError)
                    return
                 }
             }

             guard let finalBundlePath = self.findBundleFile(in: finalBundleDir) else {
                 let error = NSError(domain: "HotUpdaterError", code: 7, userInfo: [NSLocalizedDescriptionKey: "Bundle file not found in final directory after move/copy"])
                 try? self.fileManager.removeItem(atPath: finalBundleDir)
                 try? self.fileManager.removeItem(atPath: tempDirectory)
                 completion(false, error)
                 return
             }

            print("[HotUpdaterImpl] Bundle update successful. Path: \(finalBundlePath)")
            self.setBundleURLInternal(localPath: finalBundlePath)
            self.cleanupOldBundles(currentBundleId: bundleId)
            try? self.fileManager.removeItem(atPath: tempDirectory)
            completion(true, nil)
        }
        
        task = session.downloadTask(with: validZipUrl, completionHandler: downloadCompletionHandler)

        task.addObserver(self, forKeyPath: #keyPath(URLSessionDownloadTask.countOfBytesReceived), options: [NSKeyValueObservingOptions.new], context: nil as UnsafeMutableRawPointer?)
        task.addObserver(self, forKeyPath: #keyPath(URLSessionDownloadTask.countOfBytesExpectedToReceive), options: [NSKeyValueObservingOptions.new], context: nil as UnsafeMutableRawPointer?)

        task.resume()
    }

    override public func observeValue(forKeyPath keyPath: String?, of object: Any?, change: [NSKeyValueChangeKey : Any]?, context: UnsafeMutableRawPointer?) {

        guard context == nil else {
             super.observeValue(forKeyPath: keyPath, of: object, change: change, context: context)
             return
        }

        guard let task = object as? URLSessionDownloadTask,
              (keyPath == #keyPath(URLSessionDownloadTask.countOfBytesReceived) || keyPath == #keyPath(URLSessionDownloadTask.countOfBytesExpectedToReceive))
        else {
            super.observeValue(forKeyPath: keyPath, of: object, change: change, context: context)
            return
        }

        let totalBytesExpected = task.countOfBytesExpectedToReceive
        let totalBytesReceived = task.countOfBytesReceived

        if totalBytesExpected > 0 {
            let progress = Double(totalBytesReceived) / Double(totalBytesExpected)
             let progressInfo: [String: Any] = [
                 "progress": progress,
                 "totalBytesReceived": totalBytesReceived,
                 "totalBytesExpected": totalBytesExpected
             ]
             NotificationCenter.default.post(name: .downloadProgressUpdate, object: task, userInfo: progressInfo)

        } else {
             NotificationCenter.default.post(name: .downloadProgressUpdate, object: task, userInfo: ["progress": 0.0, "totalBytesReceived": 0, "totalBytesExpected": 0])
        }
    }

    private func documentsPath() -> String {
       return NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true)[0]
    }
    private func bundleStoreDir() -> String {
       return (documentsPath() as NSString).appendingPathComponent("bundle-store")
    }
    private func tempDir() -> String {
        return (documentsPath() as NSString).appendingPathComponent("bundle-temp")
    }
    private func createDir(at path: String) -> Bool {
        do {
            try fileManager.createDirectory(atPath: path, withIntermediateDirectories: true, attributes: nil)
            return true
        } catch {
            print("[HotUpdaterImpl] Failed to create directory at \(path): \(error)")
            return false
        }
    }
    private func findBundleFile(in directoryPath: String) -> String? {
        do {
            let items = try fileManager.contentsOfDirectory(atPath: directoryPath)
            if let bundleFile = items.first(where: { $0 == "index.ios.bundle" }) {
                 return (directoryPath as NSString).appendingPathComponent(bundleFile)
            } else if let bundleFile = items.first(where: { $0 == "main.jsbundle" }) {
                 return (directoryPath as NSString).appendingPathComponent(bundleFile)
            }
        } catch {
            print("[HotUpdaterImpl] Error listing directory contents at \(directoryPath): \(error)")
        }
        print("[HotUpdaterImpl] Bundle file (index.ios.bundle or main.jsbundle) not found in \(directoryPath)")
        return nil
    }

    private func cleanupOldBundles(currentBundleId: String?) {
        let storeDir = bundleStoreDir()
        guard let contents = try? fileManager.contentsOfDirectory(atPath: storeDir) else {
             print("[HotUpdaterImpl] Failed to list contents of bundle store directory: \(storeDir)")
            return
        }

        var bundleDirs = [(path: String, modDate: Date)]()

        for item in contents {
            let fullPath = (storeDir as NSString).appendingPathComponent(item)
            var isDir: ObjCBool = false
            if fileManager.fileExists(atPath: fullPath, isDirectory: &isDir), isDir.boolValue {
                do {
                    let attributes = try fileManager.attributesOfItem(atPath: fullPath)
                    if let modDate = attributes[.modificationDate] as? Date {
                        bundleDirs.append((path: fullPath, modDate: modDate))
                    } else {
                        bundleDirs.append((path: fullPath, modDate: .distantPast))
                         print("[HotUpdaterImpl] Warning: Could not get modification date for \(fullPath), treating as old.")
                    }
                } catch {
                     print("[HotUpdaterImpl] Warning: Could not get attributes for \(fullPath): \(error)")
                     bundleDirs.append((path: fullPath, modDate: .distantPast))
                }
            }
        }

        bundleDirs.sort { $0.modDate > $1.modDate }

        var bundlesToKeep = Set<String>()

        if let currentId = currentBundleId, let currentPath = bundleDirs.first(where: { ($0.path as NSString).lastPathComponent == currentId })?.path {
            bundlesToKeep.insert(currentPath)
            print("[HotUpdaterImpl] Keeping current bundle: \(currentId)")
        }

        if let latestBundle = bundleDirs.first {
            bundlesToKeep.insert(latestBundle.path)
             print("[HotUpdaterImpl] Keeping latest bundle (by mod date): \((latestBundle.path as NSString).lastPathComponent)")
        }

        let bundlesToRemove = bundleDirs.filter { !bundlesToKeep.contains($0.path) }

        if bundlesToRemove.isEmpty {
            print("[HotUpdaterImpl] No old bundles to remove.")
        } else {
            print("[HotUpdaterImpl] Found \(bundlesToRemove.count) old bundle(s) to remove.")
        }


        for oldBundle in bundlesToRemove {
            do {
                try fileManager.removeItem(atPath: oldBundle.path)
                print("[HotUpdaterImpl] Removed old bundle: \((oldBundle.path as NSString).lastPathComponent)")
            } catch {
                print("[HotUpdaterImpl] Failed to remove old bundle at \(oldBundle.path): \(error)")
            }
        }
    }
}

extension Notification.Name {
    static let downloadProgressUpdate = Notification.Name("HotUpdaterDownloadProgressUpdate")
    static let downloadDidFinish = Notification.Name("HotUpdaterDownloadDidFinish")
}

extension URLSessionDownloadTask {
    @objc dynamic open override var countOfBytesReceived: Int64 {
        return super.countOfBytesReceived
    }

    @objc dynamic open override var countOfBytesExpectedToReceive: Int64 {
        return super.countOfBytesExpectedToReceive
    }
}