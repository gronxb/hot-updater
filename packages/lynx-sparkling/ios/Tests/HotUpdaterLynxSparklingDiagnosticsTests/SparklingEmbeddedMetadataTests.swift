import Foundation
@testable import HotUpdaterLynxSparklingCore
import XCTest

final class SparklingEmbeddedMetadataTests: XCTestCase {
    private func accepts(_ overrides: [String: Any] = [:]) throws -> Bool {
        var metadata: [String: Any] = ["schemaVersion": 2, "runtimeId": "runtime",
                                       "platform": "ios", "bundleId": "bundle"]
        metadata.merge(overrides) { _, replacement in replacement }
        let data = try JSONSerialization.data(withJSONObject: metadata)
        return try JSONDecoder().decode(SparklingEmbeddedMetadata.self, from: data)
            .isCompatible(runtimeId: "runtime", bundleId: "bundle")
    }

    func testCurrentBuilderSidecarPassesNativeBootstrap() throws {
        XCTAssertTrue(try accepts())
    }

    func testSupportedLegacySidecarRemainsAccepted() throws {
        XCTAssertTrue(try accepts(["schemaVersion": 1]))
    }

    func testUnknownOrMalformedVersionsAndForeignIdentitiesRemainRejected() throws {
        for version: Any in [0, 3, -1, "2", true, 2.5] {
            XCTAssertFalse((try? accepts(["schemaVersion": version])) ?? false, "Version: \(version)")
        }
        for mismatch: [String: Any] in [["runtimeId": "another-runtime"], ["platform": "android"],
                                        ["bundleId": "another-bundle"]] {
            XCTAssertFalse(try accepts(mismatch))
        }
    }
}
