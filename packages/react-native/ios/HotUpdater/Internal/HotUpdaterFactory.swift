import Foundation

@objcMembers
public class HotUpdaterFactory: NSObject {
    public static let shared = HotUpdaterFactory()
    
    private override init() {}
    
    public func create() -> HotUpdaterImpl {
        let fileSystem = FileManagerService()
        let preferences = VersionedPreferencesService()
        let downloadService = URLSessionDownloadService()
        let zipUnzipService = SSZipArchiveUnzipService()
        let tarBrUnzipService = TarBrUnzipService()

        let bundleStorage = BundleFileStorageService(
            fileSystem: fileSystem,
            downloadService: downloadService,
            zipUnzipService: zipUnzipService,
            tarBrUnzipService: tarBrUnzipService,
            preferences: preferences
        )

        return HotUpdaterImpl(bundleStorage: bundleStorage, preferences: preferences)
    }
}