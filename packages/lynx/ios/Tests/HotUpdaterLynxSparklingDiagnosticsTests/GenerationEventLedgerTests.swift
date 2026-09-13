import Foundation
@testable import HotUpdaterLynxSparklingDiagnostics
import XCTest

final class GenerationEventLedgerTests: XCTestCase {
    func testRetirementWaitsForTheRealResourceConsumerToFinish() {
        let eventLock = NSLock()
        var events: [(String, [String: Any])] = []
        let generation = SparklingGenerationEvents(id: "generation-a") {
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
            "processId": 42,
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
        let generation = SparklingGenerationEvents(id: "generation-a") {
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
