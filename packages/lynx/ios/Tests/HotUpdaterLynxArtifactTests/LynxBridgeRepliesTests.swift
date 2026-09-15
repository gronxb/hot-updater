@testable import HotUpdaterLynxArtifact
import XCTest

final class LynxBridgeRepliesTests: XCTestCase {
    func testAcceptedReplyWaitsForCompletionAndSettlesOnlyOnce() throws {
        var reply: Result<String, Error>?
        let once = LynxOnceReply<String> { reply = $0 }

        XCTAssertNil(reply)
        once.settle(.success("replaced"))
        once.settle(.failure(LynxPolicyError(code: "LATE", message: "late")))

        XCTAssertEqual(try reply?.get(), "replaced")
    }

    func testGenerationCloseRejectsEveryPendingReplyExactlyOnce() {
        let replies = LynxBridgeReplies()
        var errors: [Error] = []
        let ticket = replies.register { errors.append($0) }!

        replies.close()
        replies.close()
        replies.settle(ticket) { XCTFail("A retired reply was completed twice") }

        XCTAssertEqual(errors.count, 1)
        XCTAssertEqual((errors[0] as? LynxPolicyError)?.code, "CONTEXT_REJECTED")
    }

    func testClosedGenerationRejectsNewRepliesImmediately() {
        let replies = LynxBridgeReplies()
        var error: Error?
        replies.close()

        let ticket = replies.register { error = $0 }

        XCTAssertNil(ticket)
        XCTAssertEqual((error as? LynxPolicyError)?.code, "CONTEXT_REJECTED")
    }

    func testClaimTransfersReplyAcrossGenerationRetirement() throws {
        let replies = LynxBridgeReplies()
        var cancellation: Error?
        let ticket = replies.register { cancellation = $0 }!
        XCTAssertTrue(replies.claim(ticket))

        replies.close()

        XCTAssertNil(cancellation)
    }
}
