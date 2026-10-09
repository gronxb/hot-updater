import XCTest
@testable import HotUpdaterLynxArtifact

final class LynxManagedFontURLTests: XCTestCase {
    private let canonical = "https://hot-updater-font.invalid/assets/probe.ttf?hot-updater-generation=2"

    func testMalformedOwnedRequestsCannotBecomeUnmanaged() throws {
        XCTAssertTrue(LynxManagedFontURL.owns(canonical))
        XCTAssertEqual(try LynxManagedFontURL.relativePath(canonical), "assets/probe.ttf")
        for invalid in [
            canonical.replacingOccurrences(of: ".invalid/", with: ".invalid:443/"),
            canonical.replacingOccurrences(of: ".invalid/", with: ".invalid:bad/"),
            canonical.replacingOccurrences(of: "https://", with: "https://user@"),
            canonical.replacingOccurrences(of: "https://", with: "https:/"),
            canonical.replacingOccurrences(of: "https://", with: "https:///"),
            canonical.replacingOccurrences(of: "https://", with: "https:\\\\"),
            canonical.replacingOccurrences(of: ".invalid", with: "。invalid"),
            canonical.replacingOccurrences(of: "hot-updater-font", with: "ｈot-updater-font"),
            canonical.replacingOccurrences(of: "https://", with: "http://"),
            canonical.replacingOccurrences(of: "hot-updater-font", with: "%68ot-updater-font"),
            canonical.replacingOccurrences(of: "/assets/", with: "/../assets/"),
            canonical.replacingOccurrences(of: "probe.ttf", with: "%70robe.ttf"),
            canonical.replacingOccurrences(of: "=2", with: "=0"),
            String(canonical.prefix { $0 != "?" }),
            canonical + "#fragment",
        ] {
            XCTAssertTrue(LynxManagedFontURL.owns(invalid), invalid)
            XCTAssertThrowsError(try LynxManagedFontURL.relativePath(invalid), invalid)
        }
        for external in ["https://example.test/font.ttf", "https://hot-updater-font.invalid.example/font.ttf",
                         "https://hot-updater-font.invalid@example.test/font.ttf"] {
            XCTAssertFalse(LynxManagedFontURL.owns(external), external)
        }
    }

    func testCanonicalEncodedPathsPreserveUnicodeAndRejectAlternateSpellings() throws {
        let encoded = "https://hot-updater-font.invalid/assets/%ED%95%9C%EA%B8%80%20caf%C3%A9%20%281%29%21~.ttf?hot-updater-generation=2"
        XCTAssertEqual(try LynxManagedFontURL.relativePath(encoded), "assets/한글 café (1)!~.ttf")
        for path in ["%2E%2E/probe.ttf", "assets%2Fprobe.ttf", "assets/%FF.ttf", "assets/%25.ttf"] {
            XCTAssertThrowsError(try LynxManagedFontURL.relativePath("https://hot-updater-font.invalid/\(path)?hot-updater-generation=2"))
        }
    }
}
