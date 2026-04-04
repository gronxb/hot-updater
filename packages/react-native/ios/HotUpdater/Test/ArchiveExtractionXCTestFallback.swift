#if !canImport(Testing)
import XCTest

final class ArchiveExtractionXCTestFallback: XCTestCase {
    func testSwiftTestingUnavailableOnThisToolchain() throws {
        throw XCTSkip("Swift Testing module is unavailable on this toolchain.")
    }
}
#endif
