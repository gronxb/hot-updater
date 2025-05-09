import Foundation
import React

@objcMembers public class HotUpdaterImpl: NSObject {
    private let bundleStorage: BundleStorageService
    private let preferences: PreferencesService
    
    
    public convenience override init() {
        let fileSystem = FileManagerService()
        let preferences = UserDefaultsPreferencesService()
        let downloadService = URLSessionDownloadService()
        let unzipService = SSZipArchiveUnzipService()
        
        let bundleStorage = BundleFileStorageService(
            fileSystem: fileSystem,
            downloadService: downloadService,
            unzipService: unzipService,
            preferences: preferences
        )
        
        self.init(bundleStorage: bundleStorage, preferences: preferences)
    }
    
    internal init(bundleStorage: BundleStorageService, preferences: PreferencesService) {
        self.bundleStorage = bundleStorage
        self.preferences = preferences
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
    
    public func bundleURL() -> URL? {
        return bundleStorage.resolveBundleURL()
    }
    
    @objc public func updateBundle(_ params: NSDictionary?,
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
        
        print("[HotUpdaterImpl] updateBundle called with bundleId: \(bundleId), fileUrl: \(fileUrl?.absoluteString ?? "nil")")
        
        bundleStorage.updateBundle(bundleId: bundleId, fileUrl: fileUrl) { success, error in
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
}