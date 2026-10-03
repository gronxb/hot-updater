@testable import HotUpdaterLynxSparklingDiagnostics
import XCTest

final class SparklingLaunchConfigurationTests: XCTestCase {
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
