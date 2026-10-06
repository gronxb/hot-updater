import XCTest
@testable import HotUpdaterLynxArtifact

final class LynxClientStorageTests: XCTestCase {
    func testPagesRetainIdentityAndIndependentKeysAfterRecreation() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let main = LynxClientStorage(directory: directory)
        let detail = LynxClientStorage(directory: directory)
        let id = try main.installId()
        XCTAssertNotNil(UUID(uuidString: id))
        try main.set("plugins/insights/user", value: "alice")
        try detail.set("plugins/other/user", value: "bob")
        XCTAssertEqual(try detail.get("plugins/insights/user"), "alice")
        try main.set("plugins/insights/user", value: nil)
        XCTAssertNil(try detail.get("plugins/insights/user"))
        XCTAssertEqual(try LynxClientStorage(directory: directory).get("plugins/other/user"), "bob")
        XCTAssertEqual(try LynxClientStorage(directory: directory).installId(), id)
        XCTAssertEqual(try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        try FileManager.default.removeItem(at: directory)
        XCTAssertNotEqual(try main.installId(), id)
    }

    func testConcurrentPagesPreserveEveryWrite() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = LynxClientStorage(directory: directory)
        let id = try store.installId()
        DispatchQueue.concurrentPerform(iterations: 16) { index in
            let page = LynxClientStorage(directory: directory)
            do {
                XCTAssertEqual(try page.installId(), id)
                try page.set("plugins/test/\(index)", value: "\(index)")
            } catch { XCTFail("Concurrent plugin write failed: \(error)") }
        }
        for index in 0..<16 { XCTAssertEqual(try store.get("plugins/test/\(index)"), "\(index)") }
    }

    func testInvalidWritesAndCorruptionPreserveExistingBytes() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = LynxClientStorage(directory: directory)
        _ = try store.installId()
        let file = directory.appendingPathComponent("client.json")
        let before = try Data(contentsOf: file)
        XCTAssertThrowsError(try store.set("installId", value: "overwrite"))
        XCTAssertThrowsError(try store.set("plugins/test/value", value: String(repeating: "x", count: 65_537)))
        XCTAssertEqual(try Data(contentsOf: file), before)
        let corrupt = Data("broken json".utf8)
        try corrupt.write(to: file)
        XCTAssertThrowsError(try store.installId())
        XCTAssertEqual(try Data(contentsOf: file), corrupt)
    }
}
