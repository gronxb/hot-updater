@testable import HotUpdaterLynxSparklingDiagnostics
import XCTest

final class SparklingReloadContractTests: XCTestCase {
    private struct Failure: Error, Equatable {
        let code: String
        let message: String
    }

    func testClosedBusyAndStaleRequestsNeverStartReplacement() {
        [
            (true, false, true, "HOST_CLOSED"),
            (false, true, true, "RELOAD_BUSY"),
            (false, false, false, "CONTEXT_REJECTED"),
        ].forEach { closed, replacing, current, code in
            var started = false
            let result = SparklingReloadContract.run(
                closed: closed,
                replacing: replacing,
                current: current,
                error: { Failure(code: $0, message: $1) }
            ) {
                started = true
                return .success(())
            }
            XCTAssertFalse(started)
            XCTAssertEqual((try? result.get()) == nil, true)
            if case .failure(let error) = result {
                XCTAssertEqual((error as? Failure)?.code, code)
            } else {
                XCTFail("A rejected reload unexpectedly succeeded")
            }
        }
    }

    func testReplacementResultIsTheReloadResult() throws {
        let failure = Failure(code: "RECONSTRUCTION_FAILED", message: "attach failed")
        let failed = SparklingReloadContract.run(
            closed: false,
            replacing: false,
            current: true,
            error: { Failure(code: $0, message: $1) },
            replacement: { .failure(failure) }
        )
        if case .failure(let error) = failed {
            XCTAssertEqual(error as? Failure, failure)
        } else {
            XCTFail("A failed reconstruction unexpectedly succeeded")
        }

        let succeeded = SparklingReloadContract.run(
            closed: false,
            replacing: false,
            current: true,
            error: { Failure(code: $0, message: $1) },
            replacement: { .success(()) }
        )
        XCTAssertNoThrow(try succeeded.get())
    }
}
