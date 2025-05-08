import Foundation

public class HotUpdaterFactory {
    public static let shared = HotUpdaterFactory()
    
    private init() {}
    
    public func create() -> HotUpdaterImpl {
        let fileSystem = FileManagerService()
        let bundleStorage = LocalBundleStorageService(fileSystem: fileSystem)
        let preferences = UserDefaultsPreferencesService()
        let downloadService = URLSessionDownloadService()
        let unzipService = SSZipArchiveUnzipService()
        
        return HotUpdaterImpl(
            fileSystem: fileSystem,
            bundleStorage: bundleStorage,
            preferences: preferences,
            downloadService: downloadService,
            unzipService: unzipService
        )
    }
}