import Foundation

@objcMembers
public class HotUpdaterFactory: NSObject {
    public static let shared = HotUpdaterFactory()
    
    private override init() {}
    
    public func create() -> HotUpdaterImpl {
        let fileSystem = FileManagerService()
        let preferences = VersionedPreferencesService()
        let downloadService = URLSessionDownloadService()

        // UnzipService is created dynamically based on Content-Encoding header
        let bundleStorage = BundleFileStorageService(
            fileSystem: fileSystem,
            downloadService: downloadService,
            preferences: preferences
        )

        return HotUpdaterImpl(bundleStorage: bundleStorage, preferences: preferences)
    }
}