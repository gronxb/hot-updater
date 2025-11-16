# Native Unit Tests

This directory contains unit tests for the native components of `@hot-updater/react-native`.

## Overview

The tests are organized by platform:

- **ios/** - Swift tests for iOS native code
- **android/** - Kotlin tests for Android native code

## Running Tests

### All Tests

Run all native tests at once:

```bash
cd examples/unit-native
./run-tests.sh
```

### iOS Only

```bash
cd examples/unit-native/ios
swift test
```

### Android Only

```bash
cd examples/unit-native/android
./gradlew test
```

## Test Structure

### iOS Tests

- Uses Swift Package Manager and XCTest
- Tests located in `ios/Tests/HotUpdaterNativeTests/`
- Currently covers:
  - HashUtils (SHA256 operations)
  - VersionedPreferencesService (UserDefaults wrapper)

### Android Tests

- Uses Gradle with JUnit 5 and MockK
- Tests located in `android/src/test/kotlin/com/hotupdater/`
- Currently covers:
  - HashUtils (SHA256 operations)
  - VersionedPreferencesService (SharedPreferences wrapper)

## CI Integration

The tests are integrated into the GitHub Actions workflow and run automatically on:
- Push to main branch
- Pull requests

## Adding New Tests

See the README files in each platform directory for details on adding new tests:

- [iOS Testing Guide](./ios/README.md)
- [Android Testing Guide](./android/README.md)

## Notes

- These tests do not require building the entire React Native package
- Tests are isolated and mock external dependencies
- Test coverage focuses on core utility classes and services
