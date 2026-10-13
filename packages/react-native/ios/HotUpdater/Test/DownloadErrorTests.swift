#if canImport(Testing)
import Foundation
import Testing

@testable import HotUpdaterArchive

struct DownloadErrorTests {
    @Test
    func expectsTheWholeFileAfterTheSystemResumesADownload() throws {
        let url = try #require(URL(string: "https://cdn.example.com/bundle.zip"))
        func response(_ status: Int, _ headers: [String: String]) -> HTTPURLResponse? {
            HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)
        }

        #expect(DownloadError.expectedFileSize(for: response(200, ["Content-Length": "5194249"])) == 5194249)
        // A background URLSession resumed the download: the 206 carries the
        // rest, and the saved file holds all of it.
        #expect(DownloadError.expectedFileSize(for: response(206, [
            "Content-Length": "4029412",
            "Content-Range": "bytes 1164837-5194248/5194249",
        ])) == 5194249)
        // Without a total, the size is not checked; the file hash still is.
        #expect(DownloadError.expectedFileSize(for: response(206, [
            "Content-Length": "4029412",
            "Content-Range": "bytes 1164837-5194248/*",
        ])) == nil)
        #expect(DownloadError.expectedFileSize(for: response(206, ["Content-Length": "4029412"])) == nil)
        #expect(DownloadError.expectedFileSize(for: response(200, [:])) == nil)
        #expect(DownloadError.expectedFileSize(for: nil) == nil)
    }
}
#endif
