import Foundation
import Testing

@testable import HotUpdater

// MARK: - Mock Download Service

private final class MockDownloadService: DownloadService {
    var downloadFileCalled = false
    var lastURL: URL?

    func downloadFile(
        from url: URL,
        to destination: String,
        fileSizeHandler: ((Int64) -> Void)?,
        progressHandler: @escaping (Double) -> Void,
        completion: @escaping (Result<URL, Error>) -> Void
    ) -> URLSessionDownloadTask? {
        downloadFileCalled = true
        lastURL = url
        completion(.success(URL(fileURLWithPath: destination)))
        return nil
    }
}

// MARK: - Tests

@Suite("DownloadServiceFactory")
struct DownloadServiceFactoryTests {

    @Test("Custom factory is used when set")
    func customFactoryIsUsed() {
        let mock = MockDownloadService()
        HotUpdaterImpl.downloadServiceFactory = { mock }
        defer { HotUpdaterImpl.downloadServiceFactory = nil }

        // The factory should return our mock
        let service = HotUpdaterImpl.downloadServiceFactory?()
        #expect(service != nil)
        #expect(service is MockDownloadService)
    }

    @Test("Default factory returns nil when not set")
    func defaultFactoryIsNil() {
        HotUpdaterImpl.downloadServiceFactory = nil
        #expect(HotUpdaterImpl.downloadServiceFactory == nil)
    }

    @Test("URLSessionDownloadService conforms to public DownloadService protocol")
    func defaultServiceConformsToProtocol() {
        let service: DownloadService = URLSessionDownloadService()
        #expect(service is URLSessionDownloadService)
    }
}
