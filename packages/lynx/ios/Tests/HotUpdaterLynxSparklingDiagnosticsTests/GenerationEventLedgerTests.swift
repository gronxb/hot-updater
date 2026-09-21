import Foundation
@testable import HotUpdaterLynxSparklingCore
import XCTest

final class GenerationEventLedgerTests: XCTestCase {
    func testManagedEventsPersistEightCanonicalIdentityFields() throws {
        let journal = SparklingGenerationEventJournal()
        let generation = SparklingGenerationEvents(
            id: "generation-a",
            journal: journal,
            runtimeId: "runtime-a",
            processId: "123",
            bundleId: "bundle-a",
            releaseId: nil,
            sink: nil
        )
        XCTAssertTrue(generation.emit("generationStarted", [:]))
        XCTAssertTrue(generation.emit("nativeBack", [
            "contextId": "context-a",
            "pageAttemptId": "attempt-a",
            "transitionId": NSNull(),
        ]))
        let events = try XCTUnwrap(
            try journal.snapshot()["events"] as? [[String: Any]]
        )
        for event in events {
            let details = try XCTUnwrap(event["details"] as? [String: Any])
            XCTAssertEqual(details["runtimeId"] as? String, "runtime-a")
            XCTAssertEqual(details["processId"] as? String, "123")
            XCTAssertEqual(details["generationId"] as? String, "generation-a")
            XCTAssertEqual(details["bundleId"] as? String, "bundle-a")
            for key in [
                "releaseId", "contextId", "pageAttemptId", "transitionId",
            ] {
                XCTAssertNotNil(details[key])
                XCTAssertTrue(
                    details[key] is NSNull || details[key] is String
                )
            }
        }
        let nativeBack = try XCTUnwrap(events.last?["details"] as? [String: Any])
        XCTAssertEqual(nativeBack["contextId"] as? String, "context-a")
        XCTAssertEqual(nativeBack["pageAttemptId"] as? String, "attempt-a")
        XCTAssertTrue(nativeBack["transitionId"] is NSNull)
    }

    func testPersistedManagedEventWithInvalidIdentityRepairs() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let file = directory.appendingPathComponent("events.json")
        try Data(
            "{\"events\":[{\"details\":{\"bundleId\":\"bundle\",\"contextId\":null,\"generationId\":\"generation\",\"pageAttemptId\":null,\"processId\":1,\"releaseId\":null,\"runtimeId\":\"runtime\",\"transitionId\":null},\"name\":\"generationStarted\",\"sequence\":\"1\"}],\"nextSequence\":\"2\",\"schemaVersion\":1,\"truncated\":false}".utf8
        ).write(to: file)
        let repaired = SparklingGenerationEventJournal(file: file)
        XCTAssertEqual(try Data(contentsOf: file),
                       SparklingGenerationEventJournal.repairedHistory)
        XCTAssertEqual(try repaired.snapshot()["truncated"] as? Bool, true)
    }

    func testPersistedRetirementEventMissingIdentityRepairs() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let file = directory.appendingPathComponent("events.json")
        try Data(
            "{\"events\":[{\"details\":{},\"name\":\"generationRetired\",\"sequence\":\"1\"}],\"nextSequence\":\"2\",\"schemaVersion\":1,\"truncated\":false}".utf8
        ).write(to: file)

        let repaired = SparklingGenerationEventJournal(file: file)
        XCTAssertEqual(
            try Data(contentsOf: file),
            SparklingGenerationEventJournal.repairedHistory
        )
        XCTAssertEqual(try repaired.snapshot()["truncated"] as? Bool, true)
    }
#if HOT_UPDATER_LYNX_DIAGNOSTICS
    func testDiagnosticsFixturesExerciseRetentionEvictionAndRepair() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("events.json")
        let journal = SparklingGenerationEventJournal(file: file)

        try journal.installDiagnosticsFixture("retention-limit")
        var snapshot = try journal.snapshot()
        XCTAssertEqual((snapshot["events"] as? [[String: Any]])?.count, 256)
        XCTAssertEqual(snapshot["oldestSequence"] as? String, "1")
        XCTAssertEqual(snapshot["latestSequence"] as? String, "256")
        XCTAssertEqual(snapshot["truncated"] as? Bool, false)
        let installedEvents = try XCTUnwrap(
            snapshot["events"] as? [[String: Any]]
        )
        let installedDetails = try XCTUnwrap(
            installedEvents.first?["details"] as? [String: Any]
        )
        XCTAssertEqual(
            installedDetails["processId"] as? String,
            "1"
        )
        XCTAssertEqual(
            installedDetails["identitySource"] as? String,
            "synthetic-fixture"
        )
        let installedReceipt = try journal.diagnosticsReceipt()
        XCTAssertEqual(
            installedReceipt["processId"] as? String,
            String(ProcessInfo.processInfo.processIdentifier)
        )
        for key in [
            "runtimeId", "processId", "generationId", "bundleId",
            "releaseId", "contextId", "pageAttemptId", "transitionId",
        ] {
            XCTAssertNotNil(installedDetails[key])
        }

        try journal.installDiagnosticsFixture("count-plus-one")
        snapshot = try journal.snapshot()
        XCTAssertEqual((snapshot["events"] as? [[String: Any]])?.count, 256)
        XCTAssertEqual(snapshot["oldestSequence"] as? String, "2")
        XCTAssertEqual(snapshot["latestSequence"] as? String, "257")
        XCTAssertEqual(snapshot["truncated"] as? Bool, true)

        try journal.installDiagnosticsFixture("byte-plus-one")
        let receipt = try journal.diagnosticsReceipt()
        snapshot = try XCTUnwrap(receipt["snapshot"] as? [String: Any])
        XCTAssertEqual((snapshot["events"] as? [[String: Any]])?.count, 255)
        XCTAssertEqual(snapshot["oldestSequence"] as? String, "2")
        XCTAssertEqual(snapshot["latestSequence"] as? String, "256")
        XCTAssertEqual(snapshot["truncated"] as? Bool, true)
        XCTAssertLessThanOrEqual(
            try XCTUnwrap(receipt["byteLength"] as? Int),
            SparklingGenerationEventJournal.maximumSerializedFileBytes
        )

        for mode in ["corrupt-json", "noncanonical", "already-oversized"] {
            try journal.installDiagnosticsFixture(mode)
            snapshot = try journal.snapshot()
            XCTAssertTrue(snapshot["latestSequence"] is NSNull)
            XCTAssertEqual(snapshot["truncated"] as? Bool, true)
            try journal.reopenDiagnosticsFixture()
            snapshot = try journal.snapshot()
            XCTAssertTrue(snapshot["latestSequence"] is NSNull)
            XCTAssertEqual(snapshot["truncated"] as? Bool, true)
            XCTAssertEqual(
                try Data(contentsOf: file),
                SparklingGenerationEventJournal.repairedHistory
            )
        }

        try journal.restoreDiagnosticsFixture()
        snapshot = try journal.snapshot()
        XCTAssertTrue(snapshot["latestSequence"] is NSNull)
        XCTAssertEqual(snapshot["truncated"] as? Bool, false)
    }
#endif

    func testNilListenerStillRecordsBoundedStringSequencedEvents() throws {
        let journal = SparklingGenerationEventJournal()
        let generation = SparklingGenerationEvents(
            id: "generation-a",
            journal: journal,
            sink: nil
        )
        for index in 1 ... 260 {
            XCTAssertTrue(generation.emit("pageEvent", ["index": index]))
        }

        let snapshot = try journal.snapshot()
        XCTAssertEqual(snapshot["schemaVersion"] as? Int, 1)
        XCTAssertEqual(snapshot["oldestSequence"] as? String, "5")
        XCTAssertEqual(snapshot["latestSequence"] as? String, "260")
        XCTAssertEqual(snapshot["truncated"] as? Bool, true)
        let events = try XCTUnwrap(
            snapshot["events"] as? [[String: Any]]
        )
        XCTAssertEqual(
            events.count,
            SparklingGenerationEventJournal.capacity
        )
        XCTAssertEqual(events.first?["sequence"] as? String, "5")
        XCTAssertEqual(events.last?["sequence"] as? String, "260")
    }

    func testCapacityPlusOneIsAcceptedAndEvictsOldest() throws {
        let journal = SparklingGenerationEventJournal()
        for index in 1...SparklingGenerationEventJournal.capacity {
            XCTAssertTrue(journal.append(name: "event", details: [
                "index": index,
            ]))
        }
        XCTAssertEqual(try journal.snapshot()["truncated"] as? Bool, false)

        XCTAssertTrue(journal.append(name: "event", details: [
            "index": SparklingGenerationEventJournal.capacity + 1,
        ]))
        let snapshot = try journal.snapshot()
        XCTAssertEqual(snapshot["truncated"] as? Bool, true)
        XCTAssertEqual(snapshot["oldestSequence"] as? String, "2")
        XCTAssertEqual(snapshot["latestSequence"] as? String, "257")
        XCTAssertEqual(
            (snapshot["events"] as? [[String: Any]])?.count,
            SparklingGenerationEventJournal.capacity
        )
    }

    func testJournalPersistsEventsSequenceAndCurrentIdentity() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("events.json")
        let first = SparklingGenerationEventJournal(file: file)
        first.append(name: "fixtureStarted", details: [
            "bundleId": "bundle-a",
            "releaseId": NSNull(),
        ])
        XCTAssertEqual(
            try String(contentsOf: file, encoding: .utf8),
            "{\"events\":[{\"details\":{\"bundleId\":\"bundle-a\",\"releaseId\":null},\"name\":\"fixtureStarted\",\"sequence\":\"1\"}],\"nextSequence\":\"2\",\"schemaVersion\":1,\"truncated\":false}"
        )

        let reopened = SparklingGenerationEventJournal(file: file)
        let recovered = try reopened.snapshot()
        XCTAssertEqual(recovered["latestSequence"] as? String, "1")
        let recoveredEvents = try XCTUnwrap(
            recovered["events"] as? [[String: Any]]
        )
        XCTAssertEqual(recoveredEvents.first?["name"] as? String,
                       "fixtureStarted")
        let recoveredDetails = try XCTUnwrap(
            recoveredEvents.first?["details"] as? [String: Any]
        )
        XCTAssertTrue(recoveredDetails["releaseId"] is NSNull)

        reopened.append(name: "fixtureOpened", details: [
            "pageEntry": "pages/detail.js",
        ])
        XCTAssertEqual(
            try SparklingGenerationEventJournal(file: file)
                .snapshot()["latestSequence"] as? String,
            "2"
        )
    }

    func testJournalAppendPrecedesOptionalListenerDelivery() throws {
        let journal = SparklingGenerationEventJournal()
        var listenerObservedJournal = false
        let generation = SparklingGenerationEvents(
            id: "generation-a",
            journal: journal,
            runtimeId: "runtime-a",
            processId: "1",
            bundleId: "bundle-a"
        ) { name, _ in
            listenerObservedJournal = (
                try? journal.snapshot()["events"]
                    as? [[String: Any]]
            )?.last?["name"] as? String == name
        }

        XCTAssertTrue(generation.emit("generationStarted", [:]))
        XCTAssertTrue(listenerObservedJournal)
    }

    func testCorruptUnsupportedAndOversizedHistoryRepairCanonically() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let corrupt = directory.appendingPathComponent("corrupt.json")
        try Data("not-json".utf8).write(to: corrupt)
        let repairedCorrupt = SparklingGenerationEventJournal(file: corrupt)
        let corruptSnapshot = try repairedCorrupt.snapshot()
        XCTAssertEqual(corruptSnapshot["truncated"] as? Bool, true)
        XCTAssertEqual(corruptSnapshot["oldestSequence"] as? NSNull, NSNull())
        XCTAssertEqual(try Data(contentsOf: corrupt),
                       SparklingGenerationEventJournal.repairedHistory)

        let unsupported = directory.appendingPathComponent("unsupported.json")
        try Data("{\"schemaVersion\":2,\"nextSequence\":1,\"rolledOver\":false,\"events\":[]}".utf8)
            .write(to: unsupported)
        let repairedUnsupported = SparklingGenerationEventJournal(
            file: unsupported
        )
        XCTAssertEqual(
            try repairedUnsupported.snapshot()["truncated"] as? Bool,
            true
        )
        XCTAssertEqual(try Data(contentsOf: unsupported),
                       SparklingGenerationEventJournal.repairedHistory)

        let oversized = directory.appendingPathComponent("oversized.json")
        try Data(
            count: SparklingGenerationEventJournal.maximumSerializedFileBytes
                + 1
        ).write(to: oversized)
        let repairedOversized = SparklingGenerationEventJournal(
            file: oversized
        )
        XCTAssertEqual(
            try repairedOversized.snapshot()["latestSequence"] as? NSNull,
            NSNull()
        )
        XCTAssertEqual(try Data(contentsOf: oversized),
                       SparklingGenerationEventJournal.repairedHistory)
    }

    func testFailedCorruptHistoryRepairLeavesJournalUnavailable() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let journal = SparklingGenerationEventJournal(file: directory)
        XCTAssertThrowsError(try journal.snapshot()) { error in
            XCTAssertEqual(
                error as? SparklingGenerationEventJournal.Unavailable,
                .persistenceFailed
            )
        }
        XCTAssertFalse(journal.append(name: "event", details: [:]))
    }

    func testOrdinaryPersistenceFailurePreservesSequenceAndCanRetry() throws {
        let parentFile = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: parentFile) }
        try Data("not-a-directory".utf8).write(to: parentFile)
        let journal = SparklingGenerationEventJournal(
            file: parentFile.appendingPathComponent("events.json")
        )
        XCTAssertFalse(journal.append(name: "fixtureStarted", details: [:]))
        let afterFailure = try journal.snapshot()
        XCTAssertTrue(afterFailure["latestSequence"] is NSNull)
        XCTAssertEqual(
            (afterFailure["events"] as? [[String: Any]])?.count,
            0
        )

        try FileManager.default.removeItem(at: parentFile)
        try FileManager.default.createDirectory(
            at: parentFile,
            withIntermediateDirectories: true
        )
        XCTAssertTrue(journal.append(name: "fixtureStarted", details: [:]))
        XCTAssertEqual(try journal.snapshot()["latestSequence"] as? String, "1")
    }

    func testNoncontiguousPersistedSequencesRepairAsCorrupt() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let file = directory.appendingPathComponent("events.json")
        try Data(
            "{\"events\":[{\"details\":{},\"name\":\"a\",\"sequence\":\"1\"},{\"details\":{},\"name\":\"b\",\"sequence\":\"3\"}],\"nextSequence\":\"4\",\"schemaVersion\":1,\"truncated\":false}".utf8
        ).write(to: file)

        let repaired = SparklingGenerationEventJournal(file: file)
        XCTAssertEqual(try Data(contentsOf: file),
                       SparklingGenerationEventJournal.repairedHistory)
        XCTAssertEqual(try repaired.snapshot()["truncated"] as? Bool, true)
    }

    func testRecoveredTerminalReplayDoesNotDuplicateAfterMarkerFailure() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("events.json")
        var firstSinkCount = 0
        let first = SparklingGenerationEvents(
            journal: SparklingGenerationEventJournal(file: file),
            runtimeId: "runtime-a",
            processId: "1",
            bundleId: "bundle-a"
        ) { _, _ in firstSinkCount += 1 }
        XCTAssertTrue(first.replayRecoveredPageAttemptTerminal(
            pageAttemptId: "attempt-1",
            details: ["pageAttemptId": "attempt-1"]
        ) {
            throw NSError(domain: "marker", code: 1)
        })
        XCTAssertEqual(firstSinkCount, 1)

        let reopenedJournal = SparklingGenerationEventJournal(file: file)
        var secondSinkCount = 0
        var marked = false
        let second = SparklingGenerationEvents(
            journal: reopenedJournal,
            runtimeId: "runtime-a",
            processId: "1",
            bundleId: "bundle-a"
        ) { _, _ in secondSinkCount += 1 }
        XCTAssertTrue(second.replayRecoveredPageAttemptTerminal(
            pageAttemptId: "attempt-1",
            details: ["pageAttemptId": "attempt-1"]
        ) {
            marked = true
        })
        XCTAssertTrue(marked)
        XCTAssertEqual(secondSinkCount, 0)
        XCTAssertEqual(
            (try reopenedJournal.snapshot()["events"] as? [[String: Any]])?.count,
            1
        )
    }

    func testDirectorySyncFailureAfterRenameKeepsCommittedSequence() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("events.json")
        let journal = SparklingGenerationEventJournal(
            file: file,
            directorySynchronizer: { _ in
                throw NSError(domain: "directory-sync", code: 1)
            }
        )

        XCTAssertTrue(journal.append(name: "committed", details: [:]))
        XCTAssertEqual(try journal.snapshot()["latestSequence"] as? String, "1")
        XCTAssertEqual(
            try SparklingGenerationEventJournal(file: file)
                .snapshot()["latestSequence"] as? String,
            "1"
        )
    }

    func testEventNameAndDetailsExactByteLimitsDoNotConsumeSequence() throws {
        let journal = SparklingGenerationEventJournal()
        let exactName = String(repeating: "🌟", count: 32)
        XCTAssertEqual(
            exactName.utf8.count,
            SparklingGenerationEventJournal.maximumEventNameBytes
        )
        XCTAssertTrue(journal.append(name: exactName, details: [:]))
        XCTAssertFalse(journal.append(name: exactName + "x", details: [:]))

        let emptyDetailsBytes = Data("{\"payload\":\"\"}".utf8).count
        let exactPayload = String(
            repeating: "x",
            count: SparklingGenerationEventJournal.maximumDetailsBytes
                - emptyDetailsBytes
        )
        XCTAssertTrue(journal.append(name: "details", details: [
            "payload": exactPayload,
        ]))
        XCTAssertFalse(journal.append(name: "details", details: [
            "payload": exactPayload + "x",
        ]))
        let snapshot = try journal.snapshot()
        XCTAssertEqual(snapshot["latestSequence"] as? String, "2")
        XCTAssertEqual(
            (snapshot["events"] as? [[String: Any]])?.count,
            2
        )
    }

    func testSizeEvictionPersistsOnlyBoundedCanonicalCandidates() throws {
        XCTAssertEqual(
            SparklingGenerationEventJournal.maximumSerializedFileBytes,
            16 * 1_024 * 1_024
        )
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("events.json")
        let byteLimit = 600
        let journal = SparklingGenerationEventJournal(
            file: file,
            serializedFileByteLimit: byteLimit
        )
        for index in 1...10 {
            XCTAssertTrue(journal.append(name: "event", details: [
                "index": index,
                "payload": String(repeating: "x", count: 120),
            ]))
            XCTAssertLessThanOrEqual(
                try Data(contentsOf: file).count,
                byteLimit
            )
            XCTAssertEqual(
                try FileManager.default.contentsOfDirectory(
                    atPath: directory.path
                ),
                ["events.json"]
            )
        }
        let snapshot = try journal.snapshot()
        XCTAssertEqual(snapshot["latestSequence"] as? String, "10")
        XCTAssertEqual(snapshot["truncated"] as? Bool, true)
        XCTAssertLessThan(
            try XCTUnwrap(snapshot["events"] as? [[String: Any]]).count,
            10
        )
        let reopened = SparklingGenerationEventJournal(
            file: file,
            serializedFileByteLimit: byteLimit
        )
        XCTAssertEqual(try reopened.snapshot()["truncated"] as? Bool, true)
    }

    func testCanonicalRecursiveDetailsHaveExactPersistedBytes() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("events.json")
        let journal = SparklingGenerationEventJournal(file: file)
        XCTAssertTrue(journal.append(name: "event", details: [
            "z": 1.0,
            "a": [true, NSNull(), "line\n"],
        ]))
        XCTAssertEqual(
            try String(contentsOf: file, encoding: .utf8),
            "{\"events\":[{\"details\":{\"a\":[true,null,\"line\\n\"],\"z\":1},\"name\":\"event\",\"sequence\":\"1\"}],\"nextSequence\":\"2\",\"schemaVersion\":1,\"truncated\":false}"
        )
        XCTAssertFalse(journal.append(name: "invalid", details: [
            "date": Date(),
        ]))
        XCTAssertEqual(try journal.snapshot()["latestSequence"] as? String, "1")
    }

    func testRFC8785NumberSerializationVector() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("events.json")
        let journal = SparklingGenerationEventJournal(file: file)
        XCTAssertTrue(journal.append(name: "numbers", details: [
            "a": 333_333_333.333_333_29,
            "b": 1e30,
            "c": 4.50,
            "d": 2e-3,
            "e": 1e-27,
            "f": -0.0,
        ]))
        XCTAssertEqual(
            try String(contentsOf: file, encoding: .utf8),
            "{\"events\":[{\"details\":{\"a\":333333333.3333333,\"b\":1e+30,\"c\":4.5,\"d\":0.002,\"e\":1e-27,\"f\":0},\"name\":\"numbers\",\"sequence\":\"1\"}],\"nextSequence\":\"2\",\"schemaVersion\":1,\"truncated\":false}"
        )
    }

    func testRetirementWaitsForTheRealResourceConsumerToFinish() {
        let eventLock = NSLock()
        var events: [(String, [String: Any])] = []
        let generation = SparklingGenerationEvents(
            id: "generation-a",
            runtimeId: "runtime-a",
            processId: "1",
            bundleId: "bundle-a"
        ) {
            eventLock.lock()
            events.append(($0, $1))
            eventLock.unlock()
        }
        let consumerStarted = DispatchSemaphore(value: 0)
        let releaseConsumer = DispatchSemaphore(value: 0)
        let retired = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            try! generation.resourceOperation {
                consumerStarted.signal()
                XCTAssertEqual(
                    releaseConsumer.wait(timeout: .now() + 2),
                    .success
                )
                XCTAssertTrue(generation.resourceLoaded(
                    "resourceLoaded",
                    details: [
                        "contextId": "context-a",
                        "path": "assets/bootstrap.js",
                        "sha256": "abc",
                    ]
                ))
            }
        }
        XCTAssertEqual(consumerStarted.wait(timeout: .now() + 2), .success)
        DispatchQueue.global().async {
            let details: [String: Any] = [
                "generationId": "generation-a",
            ]
            generation.beginRetirement(details)
            generation.finishRetirement(details)
            retired.signal()
        }

        XCTAssertEqual(retired.wait(timeout: .now() + 0.1), .timedOut)
        releaseConsumer.signal()
        XCTAssertEqual(retired.wait(timeout: .now() + 2), .success)
        eventLock.lock()
        let observed = events
        eventLock.unlock()
        XCTAssertEqual(observed.map(\.0), [
            "resourceLeaseAcquired",
            "resourceLoaded",
            "generationWillRetire",
            "resourceLeaseReleased",
            "generationRetired",
        ])
        XCTAssertEqual(observed.last?.1["inFlightResourceCount"] as? Int, 0)
    }

    func testEmbeddedIdentityIsJSONSerializable() throws {
        let identity: [String: Any] = [
            "processId": "42",
            "generationId": "generation-a",
            "contextId": "context-a",
            "attemptId": "attempt-a",
            "bundleId": "embedded-a",
            "releaseId": hotUpdaterJSONValue(nil as String?),
        ]
        XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: identity))
        XCTAssertTrue(identity["releaseId"] is NSNull)
    }

    func testReadinessAndRetirementOrderingRejectsLateResources() {
        var events: [(String, [String: Any])] = []
        let generation = SparklingGenerationEvents(
            id: "generation-a",
            runtimeId: "runtime-a",
            processId: "1",
            bundleId: "bundle-a"
        ) {
            events.append(($0, $1))
        }
        let image: [String: Any] = [
            "contextId": "context-a",
            "path": "assets/probe.png",
            "sha256": "abc",
        ]
        XCTAssertTrue(generation.emit("generationWillEvaluate", [:]))
        XCTAssertTrue(generation.resourceLoaded("resourceLoaded", details: image))
        XCTAssertTrue(generation.resourceLoaded(
            "imageLoaded",
            details: image.merging(["contextId": "context-b"]) { _, new in new }
        ))
        XCTAssertTrue(generation.emit("firstContent", [:]))
        XCTAssertTrue(generation.emit("jsReady", [:]))

        let retired: [String: Any] = ["generationId": "generation-a"]
        generation.beginRetirement(retired)
        XCTAssertFalse(generation.resourceLoaded(
            "resourceLoaded",
            details: image.merging(["sha256": "late"]) { _, new in new }
        ))
        generation.finishRetirement(retired)

        XCTAssertEqual(events.map(\.0), [
            "generationWillEvaluate",
            "resourceLeaseAcquired",
            "resourceLoaded",
            "resourceLeaseAcquired",
            "imageLoaded",
            "firstContent",
            "jsReady",
            "generationWillRetire",
            "resourceLeaseReleased",
            "resourceLeaseReleased",
            "generationRetired",
        ])
        XCTAssertEqual(
            events.filter { $0.0 == "resourceLeaseReleased" }.compactMap {
                $0.1["contextId"] as? String
            },
            ["context-a", "context-b"]
        )
        XCTAssertEqual(events.last?.1["inFlightResourceCount"] as? Int, 0)
    }
}
