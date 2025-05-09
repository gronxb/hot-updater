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
        do {
            try preferences.setItem(channel, forKey: "HotUpdaterChannel")
            print("[HotUpdaterImpl] Channel set to: \(channel ?? "nil")")
        } catch let error {
            print("[HotUpdaterImpl] Error setting channel: \(error.localizedDescription)")
        }
    }
    
    public func getChannel() -> String? {
        do {
            return try preferences.getItem(forKey: "HotUpdaterChannel")
        } catch let error {
            print("[HotUpdaterImpl] Error getting channel: \(error.localizedDescription)")
            return nil
        }
    }
    
    public func bundleURL() -> URL? {
        do {
            return try bundleStorage.resolveBundleURL()
        } catch let error {
            print("[HotUpdaterImpl] Error resolving bundle URL: \(error.localizedDescription)")
            return bundleStorage.fallbackBundleURL()
        }
    }
    
    @objc public func updateBundle(_ params: NSDictionary?,
                                         resolver resolve: @escaping RCTPromiseResolveBlock,
                                         rejecter reject: @escaping RCTPromiseRejectBlock) {
        
        do {
            guard let data = params else {
                throw NSError(domain: "HotUpdaterError", code: 101, userInfo: [NSLocalizedDescriptionKey: "Missing params dictionary"])
            }
            
            guard let bundleId = data["bundleId"] as? String, !bundleId.isEmpty else {
                throw NSError(domain: "HotUpdaterError", code: 102, userInfo: [NSLocalizedDescriptionKey: "Missing or empty 'bundleId'"])
            }
            
            let fileUrlString = data["fileUrl"] as? String ?? ""
            
            var fileUrl: URL? = nil
            if !fileUrlString.isEmpty {
                guard let url = URL(string: fileUrlString) else {
                    throw NSError(domain: "HotUpdaterError", code: 103, userInfo: [NSLocalizedDescriptionKey: "Invalid 'fileUrl' provided: \(fileUrlString)"])
                }
                fileUrl = url
            }
            
            print("[HotUpdaterImpl] updateBundle called with bundleId: \(bundleId), fileUrl: \(fileUrl?.absoluteString ?? "nil")")
            bundleStorage.updateBundle(bundleId: bundleId, fileUrl: fileUrl) { [weak self] result in
                guard self != nil else {
                    let error = NSError(domain: "HotUpdaterError", code: 998, userInfo: [NSLocalizedDescriptionKey: "Self deallocated during update"])
                    reject("UPDATE_ERROR", error.localizedDescription, error)
                    return
                }
                
                switch result {
                case .success:
                    print("[HotUpdaterImpl] Update successful for \(bundleId). Resolving promise.")
                    resolve(true)
                case .failure(let error):
                    print("[HotUpdaterImpl] Update failed for \(bundleId): \(error.localizedDescription). Rejecting promise.")
                    reject("UPDATE_ERROR", error.localizedDescription, error)
                }
            }
        } catch let error {
            print("[HotUpdaterImpl] Error in updateBundleFromJS: \(error.localizedDescription)")
            reject("UPDATE_ERROR", error.localizedDescription, error)
        }
    }
}