import XCTest
@testable import HotUpdater

final class VersionedPreferencesServiceTests: XCTestCase {
  var service: VersionedPreferencesService!
  let testIsolationKey = "test-isolation-key"

  override func setUp() {
    super.setUp()
    service = VersionedPreferencesService()
    service.configure(isolationKey: testIsolationKey)

    // Clean up any existing preferences
    cleanUpPreferences()
  }

  override func tearDown() {
    cleanUpPreferences()
    super.tearDown()
  }

  private func cleanUpPreferences() {
    let userDefaults = UserDefaults.standard
    let key = "\(testIsolationKey):test-key"
    userDefaults.removeObject(forKey: key)
  }

  func testSetAndGetItem() {
    let key = "test-key"
    let value = "test-value"

    service.setItem(key: key, value: value)
    let retrievedValue = service.getItem(key: key)

    XCTAssertEqual(retrievedValue, value, "Retrieved value should match set value")
  }

  func testGetNonExistentItem() {
    let key = "non-existent-key"
    let retrievedValue = service.getItem(key: key)

    XCTAssertNil(retrievedValue, "Non-existent key should return nil")
  }

  func testSetItemOverwritesExistingValue() {
    let key = "test-key"
    let firstValue = "first-value"
    let secondValue = "second-value"

    service.setItem(key: key, value: firstValue)
    service.setItem(key: key, value: secondValue)

    let retrievedValue = service.getItem(key: key)

    XCTAssertEqual(retrievedValue, secondValue, "Second value should overwrite first value")
  }

  func testIsolationKeyPreventsKeyCollision() {
    let key = "test-key"
    let value1 = "value1"
    let value2 = "value2"

    // Set value with first isolation key
    service.configure(isolationKey: "isolation-1")
    service.setItem(key: key, value: value1)

    // Set value with second isolation key
    service.configure(isolationKey: "isolation-2")
    service.setItem(key: key, value: value2)

    // Retrieve from first isolation key
    service.configure(isolationKey: "isolation-1")
    let retrievedValue1 = service.getItem(key: key)

    // Retrieve from second isolation key
    service.configure(isolationKey: "isolation-2")
    let retrievedValue2 = service.getItem(key: key)

    XCTAssertEqual(retrievedValue1, value1, "Value from isolation-1 should be preserved")
    XCTAssertEqual(retrievedValue2, value2, "Value from isolation-2 should be preserved")

    // Clean up
    UserDefaults.standard.removeObject(forKey: "isolation-1:test-key")
    UserDefaults.standard.removeObject(forKey: "isolation-2:test-key")
  }
}
