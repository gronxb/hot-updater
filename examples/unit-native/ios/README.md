# iOS Native Unit Tests

This directory contains unit tests for the iOS native components of `@hot-updater/react-native`.

## Structure

- `Package.swift` - Swift Package Manager configuration
- `Tests/HotUpdaterNativeTests/` - Test files

## Running Tests

### Using Swift Package Manager

```bash
cd examples/unit-native/ios
swift test
```

### Using Xcode

```bash
cd examples/unit-native/ios
open Package.swift
```

Then use Xcode's test navigator to run tests.

## Test Coverage

The tests cover the following components:

- **HashUtils** - SHA256 hash calculation and verification
- **VersionedPreferencesService** - Key-value storage with isolation keys

## Adding New Tests

1. Create a new test file in `Tests/HotUpdaterNativeTests/`
2. Import XCTest and the HotUpdater module
3. Create test classes extending `XCTestCase`
4. Write test methods with the `test` prefix

Example:

```swift
import XCTest
@testable import HotUpdater

final class MyTests: XCTestCase {
  func testSomething() {
    // Test code here
    XCTAssertEqual(actual, expected)
  }
}
```
