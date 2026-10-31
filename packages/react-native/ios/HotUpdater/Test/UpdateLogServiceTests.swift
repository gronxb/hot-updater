#if canImport(Testing)
import Foundation
import Testing

@testable import HotUpdaterCore

struct UpdateLogServiceTests {
    private final class Clock {
        var now = Date(timeIntervalSince1970: 1_000_000_000)
    }

    private func logFile(_ name: String = #function) throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("UpdateLogServiceTests-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("nested", isDirectory: true)
        return directory.appendingPathComponent(UpdateLogService.filename)
    }

    private func cleanup(_ file: URL) {
        try? FileManager.default.removeItem(at: file.deletingLastPathComponent().deletingLastPathComponent())
    }

    private func check(_ bundleId: String) -> UpdateLogEvent {
        UpdateLogEvent(type: UpdateLogEvent.check, outcome: UpdateLogEvent.upToDate, bundleId: bundleId)
    }

    private func entries(_ log: UpdateLogService) throws -> [[String: Any]] {
        let data = try #require(log.read().data(using: .utf8))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    }

    private func bundleIds(_ log: UpdateLogService) throws -> [String] {
        try entries(log).compactMap { $0["bundleId"] as? String }
    }

    @Test
    func readsWhatWasAppendedOldestFirstWithEveryField() throws {
        let file = try logFile()
        defer { cleanup(file) }
        let clock = Clock()
        let log = UpdateLogService(file: file, clock: { clock.now })

        log.append(check("a"))
        log.append(UpdateLogEvent(
            type: UpdateLogEvent.download,
            outcome: UpdateLogEvent.failed,
            bundleId: "b",
            fromBundleId: "a",
            releaseId: "release",
            channel: "beta",
            error: ["code": "DOWNLOAD_FAILED", "message": "failed", "stage": "download", "reason": "network"]
        ))

        let read = try entries(log)
        #expect(read.count == 2)
        #expect((read[0]["timestamp"] as? NSNumber)?.int64Value == 1_000_000_000_000)
        #expect(read[0]["type"] as? String == "CHECK")
        #expect(read[0]["error"] == nil)
        #expect(read[1]["outcome"] as? String == "FAILED")
        #expect(read[1]["fromBundleId"] as? String == "a")
        #expect(read[1]["releaseId"] as? String == "release")
        #expect(read[1]["channel"] as? String == "beta")
        let error = try #require(read[1]["error"] as? [String: Any])
        #expect(error["code"] as? String == "DOWNLOAD_FAILED")
        #expect(error["message"] as? String == "failed")
        #expect(error["stage"] as? String == "download")
        #expect(error["reason"] as? String == "network")
    }

    @Test
    func aMissingLogReadsAsAnEmptyList() throws {
        let file = try logFile()
        #expect(UpdateLogService(file: file).read() == "[]")
    }

    @Test
    func entriesSurviveANewProcess() throws {
        let file = try logFile()
        defer { cleanup(file) }
        let first = UpdateLogService(file: file)
        first.append(check("a"))
        _ = first.read()

        #expect(try bundleIds(UpdateLogService(file: file)) == ["a"])
    }

    @Test
    func readsKeepOnlyTheNewestEntries() throws {
        let file = try logFile()
        defer { cleanup(file) }
        let log = UpdateLogService(file: file)
        for index in 0..<(UpdateLogService.maxEntries + 5) {
            log.append(check("bundle-\(index)"))
        }

        let read = try bundleIds(log)

        #expect(read.count == UpdateLogService.maxEntries)
        #expect(read.first == "bundle-5")
        #expect(read.last == "bundle-\(UpdateLogService.maxEntries + 4)")
    }

    @Test
    func readsDropEntriesOlderThanTheRetention() throws {
        let file = try logFile()
        defer { cleanup(file) }
        let clock = Clock()
        let log = UpdateLogService(file: file, clock: { clock.now })
        log.append(check("old"))
        clock.now = clock.now.addingTimeInterval(1)
        log.append(check("new"))
        _ = log.read()

        clock.now = clock.now.addingTimeInterval(UpdateLogService.maxAge)

        #expect(try bundleIds(log) == ["new"])
    }

    @Test
    func theFileItselfIsTrimmed() throws {
        let file = try logFile()
        defer { cleanup(file) }
        let log = UpdateLogService(file: file)
        for index in 0..<(UpdateLogService.maxEntries + 3 * UpdateLogService.trimInterval) {
            log.append(check("bundle-\(index)"))
        }
        _ = log.read()

        let lines = try String(contentsOf: file, encoding: .utf8)
            .split(separator: "\n", omittingEmptySubsequences: true)

        #expect(lines.count <= UpdateLogService.maxEntries + UpdateLogService.trimInterval)
    }

    @Test
    func aLineThatCannotBeReadIsSkippedAndKeepsTheNextOne() throws {
        let file = try logFile()
        defer { cleanup(file) }
        let log = UpdateLogService(file: file)
        log.append(check("before"))
        _ = log.read()
        // A process killed in the middle of a write.
        try append("\n{\"timestamp\":1,\"type\":\"CHE", to: file)

        log.append(check("after"))
        _ = log.read()
        try append("\nnot json\n[1,2]\n{\"timestamp\":\"x\",\"type\":\"CHECK\"}\n{\"type\":\"CHECK\"}", to: file)

        #expect(try bundleIds(log) == ["before", "after"])
    }

    private func append(_ text: String, to file: URL) throws {
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        _ = try handle.seekToEnd()
        try handle.write(contentsOf: Data(text.utf8))
    }

    @Test
    func aFileTooLargeToBeThisLogIsDiscarded() throws {
        let file = try logFile()
        defer { cleanup(file) }
        try FileManager.default.createDirectory(
            at: file.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data(count: UpdateLogService.maxFileBytes + 1).write(to: file)
        let log = UpdateLogService(file: file)

        #expect(log.read() == "[]")
        #expect(!FileManager.default.fileExists(atPath: file.path))
        log.append(check("a"))
        #expect(try bundleIds(log) == ["a"])
    }

    @Test
    func clearRemovesEveryEntryAndTheNextAppendStartsOver() throws {
        let file = try logFile()
        defer { cleanup(file) }
        let log = UpdateLogService(file: file)
        log.append(check("a"))

        #expect(log.clear())
        #expect(log.read() == "[]")

        log.append(check("b"))
        #expect(try bundleIds(log) == ["b"])
        #expect(log.clear())
        #expect(log.clear())
    }

    @Test
    func anUnwritableLocationNeverThrows() throws {
        let blocker = FileManager.default.temporaryDirectory
            .appendingPathComponent("UpdateLogServiceTests-\(UUID().uuidString)")
        try Data().write(to: blocker)
        defer { try? FileManager.default.removeItem(at: blocker) }
        let log = UpdateLogService(file: blocker.appendingPathComponent("nested/\(UpdateLogService.filename)"))

        log.append(check("a"))

        #expect(log.read() == "[]")
    }

    @Test
    func theLogIsExcludedFromBackups() throws {
        let file = try logFile()
        defer { cleanup(file) }
        let log = UpdateLogService(file: file)
        log.append(check("a"))
        _ = log.read()

        #expect(try file.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
    }

    @Test
    func aJavaScriptEntryKeepsOnlyWhatTheLogKnowsStampedByNative() throws {
        let file = try logFile()
        defer { cleanup(file) }
        let clock = Clock()
        let log = UpdateLogService(file: file, clock: { clock.now })

        log.appendJson("""
        {"timestamp":1,"type":"CHECK","outcome":"UP_TO_DATE","bundleId":"a","secret":"value",\
        "error":{"message":"m","headers":"x-api-key: 1"}}
        """)

        let entry = try #require(try entries(log).first)
        #expect((entry["timestamp"] as? NSNumber)?.int64Value == 1_000_000_000_000)
        #expect(entry["bundleId"] as? String == "a")
        #expect(entry["secret"] == nil)
        let error = try #require(entry["error"] as? [String: Any])
        #expect(error["headers"] == nil)
    }

    @Test
    func javaScriptEntriesOfWhatOnlyNativeRecordsOrUnreadableOnesAreIgnored() throws {
        let file = try logFile()
        defer { cleanup(file) }
        let log = UpdateLogService(file: file)

        log.appendJson("not json")
        log.appendJson(#"{"type":"APPLY","outcome":"APPLIED"}"#)
        log.appendJson(#"{"type":"CHECK"}"#)

        #expect(log.read() == "[]")
    }

    @Test
    func messagesKeepOnlyTheHostOfAURL() {
        #expect(
            UpdateLogService.sanitizeMessage(
                "Failed https://user:pass@cdn.example.com/a/b.zip?X-Amz-Signature=secret&token=t and s3://bucket/key?sig=1 then done"
            ) == "Failed https://cdn.example.com and s3://bucket then done"
        )
    }

    @Test
    func anErrorsMessageIsSanitizedAndBoundedInTheFile() throws {
        let file = try logFile()
        defer { cleanup(file) }
        let log = UpdateLogService(file: file)

        log.append(UpdateLogEvent(
            type: UpdateLogEvent.download,
            outcome: UpdateLogEvent.failed,
            error: ["message": "Invalid 'manifestUrl' provided: https://x.dev/m?token=secret " + String(repeating: "y", count: 5000)]
        ))
        let read = try entries(log)

        let contents = try String(contentsOf: file, encoding: .utf8)
        #expect(!contents.contains("token=secret"))
        #expect(!contents.contains("/m?"))
        let error = try #require(read.first?["error"] as? [String: Any])
        #expect((error["message"] as? String)?.count ?? 513 <= 512)
    }

    @Test
    func errorFieldsReadAClassifiedFailuresClassification() {
        let underlying = NSError(domain: "t", code: 1, userInfo: [NSLocalizedDescriptionKey: "failed"])
        let fields = UpdateLogEvent.errorFields(
            of: UpdateFailureError(underlying: underlying, failure: .network),
            code: "DOWNLOAD_FAILED"
        )

        #expect(fields["code"] as? String == "DOWNLOAD_FAILED")
        #expect(fields["message"] as? String == "failed")
        #expect(fields["stage"] as? String == "download")
        #expect(fields["reason"] as? String == "network")
    }
}
#endif
