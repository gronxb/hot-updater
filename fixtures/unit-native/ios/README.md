# iOS Native Unit Tests

This directory contains native unit tests for the `@hot-updater/react-native` iOS implementation using Swift Testing framework.

## Prerequisites

- Xcode 15.0 or later
- Swift 6.0 or later (installed via mise)
- macOS 10.15 or later

### Installing Swift 6 with mise

This project uses [mise](https://mise.jdx.dev/) to manage Swift version. Swift 6 is automatically activated when you're in the `fixtures/unit-native` directory.

```bash
# Install mise (one-time setup)
curl https://mise.run | sh

# Navigate to the directory (Swift 6 auto-installs and activates)
cd fixtures/unit-native

# Verify Swift version
swift --version
# Should output: Swift version 6.0.x or later
```

## Test Structure

```
ios/
├── Package.swift                          # Swift Package Manager configuration
└── Tests/
    └── HotUpdaterTests/
        ├── HotUpdaterImplTests.swift      # Tests for main HotUpdater implementation
        ├── BundleFileStorageServiceTests.swift
        ├── DecompressServiceTests.swift   # Tests for decompression strategies
        ├── HashUtilsTests.swift           # Tests for SHA256 hash utilities
        └── FileManagerServiceTests.swift  # Tests for file system operations
```

## Running Tests

### Command Line

From the repository root:

```bash
cd fixtures/unit-native
pnpm test:ios
```

Or directly with Swift Package Manager:

```bash
cd fixtures/unit-native
swift test --package-path ios
```

> **Note**: Swift 6 is automatically activated by mise when you're in the `fixtures/unit-native` directory.

### Xcode

1. Open the package in Xcode:
   ```bash
   open ios/Package.swift
   ```

2. Press `Cmd + U` to run all tests
3. Or navigate to the Test Navigator (`Cmd + 6`) and run individual tests

## Test Framework

This project uses **Swift Testing** (`import Testing`), the modern testing framework introduced in Swift 6.0.

### Basic Test Structure

```swift
import Testing
@testable import HotUpdater

@Suite("My Test Suite")
struct MyTests {
  @Test("Test description")
  func testSomething() throws {
    #expect(someCondition == true)
  }
}
```

## Dependencies

The tests have access to all classes and services from the main HotUpdater package:

- `HotUpdaterImpl` - Main implementation
- `HotUpdaterFactory` - Factory for creating instances
- `BundleFileStorageService` - Bundle storage management
- `DecompressService` - Decompression with strategy pattern
- `HashUtils` - SHA256 hash calculation and verification
- `FileManagerService` - File system operations
- Decompression strategies (ZIP, TAR.GZ, TAR.BR)

## CI/CD Integration

Tests are automatically run in GitHub Actions workflow. See `.github/workflows/` for configuration.

## Writing New Tests

1. Create a new `.swift` file in `Tests/HotUpdaterTests/`
2. Import the Testing framework and HotUpdater module:
   ```swift
   import Testing
   @testable import HotUpdater
   ```
3. Define a test suite with `@Suite`
4. Add test methods with `@Test` attribute
5. Use `#expect()` for assertions

## Troubleshooting

### Build Errors

If you encounter build errors, ensure:
- The main `@hot-updater/react-native` package is built first
- All dependencies are up to date
- Xcode Command Line Tools are installed: `xcode-select --install`

### Test Failures

- Check that you're testing against the correct version of the native code
- Ensure test fixtures and mock data are properly set up
- Review the test output for detailed error messages

## References

- [Swift Testing Documentation](https://developer.apple.com/documentation/testing)
- [Swift Package Manager](https://swift.org/package-manager/)
- [HotUpdater Documentation](../../../docs)
