import Foundation
@testable import HotUpdaterLynxSparklingCore
import XCTest

final class SparklingEmbeddedDescriptorTests: XCTestCase {
    func testParsesRequiredStringsAlongsideRealMultipageMetadata() throws {
        let data = Data(#"""
        {
          "framework": "react",
          "variant": "sdk3",
          "runtimeId": "runtime-a",
          "bundleId": "bundle-a",
          "minimumBundleId": "minimum-a",
          "manifestDigest": "digest-a",
          "entry": "main.lynx.bundle",
          "pageEntries": [
            "detail.lynx.bundle",
            "main.lynx.bundle"
          ],
          "pageEssentialResources": [
            {
              "entry": "detail.lynx.bundle",
              "resources": ["detail.lynx.bundle"]
            },
            {
              "entry": "main.lynx.bundle",
              "resources": [
                "assets/bootstrap.js",
                "main.lynx.bundle"
              ]
            }
          ]
        }
        """#.utf8)

        let descriptor = try HotUpdaterSparklingEmbeddedDescriptor(data: data)

        XCTAssertEqual(descriptor.runtimeId, "runtime-a")
        XCTAssertEqual(descriptor.variant, "sdk3")
        XCTAssertEqual(descriptor.bundleId, "bundle-a")
        XCTAssertEqual(descriptor.minimumBundleId, "minimum-a")
        XCTAssertEqual(descriptor.manifestDigest, "digest-a")
    }

    func testParsesMatrixFrameworkDescriptorWithMultipageMetadata() throws {
        let data = Data(#"""
        {
          "framework": "octane",
          "variant": "public-octane",
          "runtimeId": "matrix-runtime",
          "bundleId": "matrix-bundle",
          "minimumBundleId": "matrix-minimum",
          "manifestDigest": "matrix-digest",
          "entry": "main.lynx.bundle",
          "pageEntries": [
            "detail.lynx.bundle",
            "main.lynx.bundle"
          ],
          "pageEssentialResources": [
            {
              "entry": "detail.lynx.bundle",
              "resources": ["detail.lynx.bundle"]
            },
            {
              "entry": "main.lynx.bundle",
              "resources": ["main.lynx.bundle"]
            }
          ]
        }
        """#.utf8)

        let descriptor = try HotUpdaterSparklingEmbeddedDescriptor(data: data)

        XCTAssertEqual(descriptor.runtimeId, "matrix-runtime")
        XCTAssertEqual(descriptor.variant, "public-octane")
        XCTAssertEqual(descriptor.bundleId, "matrix-bundle")
        XCTAssertEqual(descriptor.minimumBundleId, "matrix-minimum")
        XCTAssertEqual(descriptor.manifestDigest, "matrix-digest")
    }

    func testRejectsMissingRequiredFieldWithExplicitError() {
        let data = Data(#"""
        {
          "variant": "sdk3",
          "bundleId": "bundle-a",
          "minimumBundleId": "minimum-a",
          "manifestDigest": "digest-a",
          "pageEntries": ["main.lynx.bundle"],
          "pageEssentialResources": [
            {
              "entry": "main.lynx.bundle",
              "resources": ["main.lynx.bundle"]
            }
          ]
        }
        """#.utf8)

        XCTAssertThrowsError(
            try HotUpdaterSparklingEmbeddedDescriptor(data: data)
        ) { error in
            XCTAssertEqual(
                error as? HotUpdaterSparklingEmbeddedDescriptorError,
                .missingOrInvalidString("runtimeId")
            )
        }
    }

    func testRejectsNonStringRequiredFieldWithoutTrapping() {
        let data = Data(#"""
        {
          "variant": "sdk3",
          "runtimeId": "runtime-a",
          "bundleId": ["bundle-a"],
          "minimumBundleId": "minimum-a",
          "manifestDigest": "digest-a",
          "pageEntries": ["main.lynx.bundle"],
          "pageEssentialResources": []
        }
        """#.utf8)

        XCTAssertThrowsError(
            try HotUpdaterSparklingEmbeddedDescriptor(data: data)
        ) { error in
            XCTAssertEqual(
                error as? HotUpdaterSparklingEmbeddedDescriptorError,
                .missingOrInvalidString("bundleId")
            )
        }
    }
}
