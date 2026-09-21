@testable import HotUpdaterLynxSparklingCore
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
            var result: Result<SparklingTransitionAcceptance, Error>?
            SparklingReloadContract.run(
                closed: closed,
                replacing: replacing,
                current: current,
                error: { Failure(code: $0, message: $1) },
                authorize: {
                started = true
                return .success(.init(transitionId: "transition"))
                },
                completion: { result = $0 },
                retire: { XCTFail("A rejected reload retired its generation") }
            )
            XCTAssertFalse(started)
            if case .failure(let error) = result! {
                XCTAssertEqual((error as? Failure)?.code, code)
            } else {
                XCTFail("A rejected reload unexpectedly succeeded")
            }
        }
    }

    func testAcceptanceReplyPrecedesOldGenerationRetirement() throws {
        var order: [String] = []
        var reply: SparklingTransitionAcceptance?
        SparklingReloadContract.run(
            closed: false,
            replacing: false,
            current: true,
            error: { Failure(code: $0, message: $1) },
            authorize: {
                order.append("authorized")
                return .success(.init(transitionId: "transition-1"))
            },
            completion: {
                order.append("replied")
                reply = try? $0.get()
            },
            retire: { order.append("retired") }
        )
        XCTAssertEqual(order, ["authorized", "replied", "retired"])
        XCTAssertEqual(reply?.status, "TRANSITION_ACCEPTED")
        XCTAssertEqual(reply?.transitionId, "transition-1")
    }

    func testLaunchConfigurationAcceptsOnlyAStringMap() throws {
        let value = try HotUpdaterSparklingLaunchConfiguration.parse(
            arguments: [
                "app",
                "--hot-updater-launch-configuration={\"runtimeConfigURL\":\"http://localhost:3111/e2e/runtime-config\",\"appBaseURL\":\"http://localhost:3011/hot-updater\",\"channel\":\"production\"}"
            ]
        )
        XCTAssertEqual(
            value["runtimeConfigURL"],
            "http://localhost:3111/e2e/runtime-config"
        )
        XCTAssertEqual(value["channel"], "production")
        XCTAssertThrowsError(try HotUpdaterSparklingLaunchConfiguration.parse(
            arguments: [
                "--hot-updater-launch-configuration={\"runtimeConfigURL\":3111}"
            ]
        ))
        XCTAssertThrowsError(try HotUpdaterSparklingLaunchConfiguration.parse(
            arguments: [
                "--hot-updater-launch-configuration={\"\":\"http://localhost:3111/e2e/runtime-config\"}"
            ]
        ))
        XCTAssertThrowsError(try HotUpdaterSparklingLaunchConfiguration.parse(
            arguments: ["--hot-updater-launch-configuration={"]
        ))
    }
}
