import XCTest
@testable import HotUpdater

final class HashUtilsTests: XCTestCase {
  func testCalculateSHA256WithValidData() throws {
    let testData = "Hello, World!".data(using: .utf8)!
    let hash = try HashUtils.calculateSHA256(data: testData)

    // Expected SHA256 hash of "Hello, World!"
    let expectedHash = "dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f"

    XCTAssertEqual(hash, expectedHash, "SHA256 hash should match expected value")
  }

  func testCalculateSHA256WithEmptyData() throws {
    let testData = Data()
    let hash = try HashUtils.calculateSHA256(data: testData)

    // Expected SHA256 hash of empty data
    let expectedHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

    XCTAssertEqual(hash, expectedHash, "SHA256 hash of empty data should match expected value")
  }

  func testVerifyHashWithMatchingHash() throws {
    let testData = "Hello, World!".data(using: .utf8)!
    let expectedHash = "dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f"

    XCTAssertNoThrow(
      try HashUtils.verifyHash(data: testData, expectedHash: expectedHash),
      "Hash verification should succeed with matching hash"
    )
  }

  func testVerifyHashWithMismatchedHash() {
    let testData = "Hello, World!".data(using: .utf8)!
    let wrongHash = "0000000000000000000000000000000000000000000000000000000000000000"

    XCTAssertThrowsError(
      try HashUtils.verifyHash(data: testData, expectedHash: wrongHash),
      "Hash verification should fail with mismatched hash"
    )
  }
}
