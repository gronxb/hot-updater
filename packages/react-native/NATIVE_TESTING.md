# Native Unit Testing for Hot Updater

This document describes the native unit testing infrastructure for the `@hot-updater/react-native` package.

## Overview

The native unit tests verify the **end-to-end OTA update flow** with the following characteristics:

- **Focus**: Integration scenarios (not internal service-by-service unit tests)
- **Scope**: Core OTA functionality only
- **Mock Strategy**: Only network layer is mocked; file operations and extraction use real implementations
- **Purpose**: Testing only - existing package configurations remain unchanged

## Test Coverage

### Test Categories

| Category | Tests | iOS | Android |
|--------|------|-----|---------|
| Basic OTA Flow | First install / Upgrade / Progress | 3 | 3 |
| File System Isolation | App version / Fingerprint / Channel | 3 | 3 |
| Cache & Persistence | Restart / Same bundle reuse / Rollback | 3 | 3 |
| Error Handling | Network / Corruption / Invalid structure / Disk / Interruption | 5 | 5 |
| Hash Verification | Success / Failure | 2 | 2 |
| Concurrency | Sequential update handling | 1 | 1 |
| **Total** | | **17** | **17** |

### Verification Focus

| Scenario | Expected Behavior |
|--------|------------|
| First Install | Download → Extract → Store → Activate |
| Upgrade | Old bundle cleaned, new activated |
| Progress | 0–80% download, 80–100% extract events |
| Isolation | Different (appVersion / fingerprint / channel) → Separate directories |
| Persistence | After restart, `getBundleURL()` restores correct bundle path |
| Same BundleId | No re-download → fast return (<100ms) |
| Rollback | No valid bundle → fallback bundle selected |
| Network Failure | No partially written files or state changes |
| Corrupt ZIP | Extract fails → `.tmp` cleaned → rollback |
| Missing Bundle Entry | Validation error → rollback |
| Insufficient Disk | Fail before download → preserve existing |
| Hash Mismatch | Delete downloaded file → fallback |
| Retry After Interruption | `.tmp` cleaned automatically, retry works cleanly |
| Concurrency | Updates applied **sequentially without race** |

## Running Tests

### iOS Tests

#### Prerequisites
- Xcode 14.0 or later
- Swift 6.0 or later

#### Run Tests
```bash
cd packages/react-native
swift test --package-path ios/HotUpdater
```

#### Run with Coverage
```bash
swift test --package-path ios/HotUpdater --enable-code-coverage
```

### Android Tests

#### Prerequisites
- JDK 8 or later
- Android SDK

#### Run Tests
```bash
cd packages/react-native/android
./gradlew test
```

#### Run Specific Test
```bash
./gradlew testDebugUnitTest
```

#### Run with Coverage
```bash
./gradlew testDebugUnitTestCoverage
```

## Test Structure

### iOS

```
packages/react-native/
  ios/HotUpdater/
    Tests/
      HotUpdaterIntegrationTests.swift    # All integration tests
    Test/
      TempTest.swift                       # Legacy test (kept for compatibility)
```

**Framework**: Swift Testing (built-in)
**Mock Strategy**: URLProtocol for network mocking

### Android

```
packages/react-native/
  android/src/test/java/com/hotupdater/
    HotUpdaterIntegrationTest.kt          # All integration tests
```

**Framework**: JUnit 5 + MockK
**Mock Strategy**: MockWebServer for network mocking

## Test Infrastructure

### iOS Mock Network
- Uses `URLProtocol` to intercept network requests
- Allows returning:
  - Valid ZIP bundles
  - Corrupted data
  - Network errors

### Android Mock Network
- Uses `MockWebServer` from OkHttp
- Enqueues responses for:
  - Valid ZIP bundles
  - Error responses
  - Timeouts

### Test Bundles
Tests dynamically create ZIP bundles containing:
- Valid bundle files (`index.ios.bundle`, `index.android.bundle`)
- Invalid structures for error testing
- Corrupted data for failure scenarios

## CI Integration

The tests are integrated into the GitHub Actions workflow:

### iOS CI
```yaml
- name: Run iOS Native Tests
  run: |
    cd packages/react-native
    swift test --package-path ios/HotUpdater --enable-code-coverage
```

### Android CI
```yaml
- name: Run Android Native Tests
  run: |
    cd packages/react-native/android
    ./gradlew test
```

## Configuration Notes

### Important: No Configuration Changes

The test infrastructure is designed to:
- **NOT** change Java or Kotlin versions in `build.gradle`
- **NOT** affect React Native integration
- **NOT** modify existing package configurations
- Only add test dependencies in `testImplementation` scope

### Test Isolation

Tests use:
- Temporary directories that are cleaned up after each test
- Mock network servers (no real network calls)
- Isolated preferences and storage for each test case

## Test Naming Convention

All tests follow the naming pattern:
```
test<Scenario>_<Variation>
```

Examples:
- `testCompleteOTAUpdate_FirstInstall`
- `testUpdateFailure_NetworkError`
- `testIsolation_DifferentChannels`

## Success Criteria

✅ All 34 tests pass (17 iOS + 17 Android)
✅ Tests run automatically in CI
✅ OTA flow validated: download → extract → activate
✅ File system isolation verified
✅ Rollback & failure paths confirmed
✅ Hash + restart persistence tested
✅ No shared-state race conditions

## Development Timeline

| Phase | Work | Est. Time |
|------|------|----------|
| Phase 1 | Prepare mock network + test bundles | 1–3 days |
| Phase 2 | Implement 17 tests for iOS + Android | 1–1.5 weeks |
| Phase 3 | CI + Coverage reporting | 1 day |

## Future Enhancements

Potential improvements for the test suite:
- Code coverage reporting
- Performance benchmarks
- Memory leak detection
- Stress testing with large bundles
- Multi-platform isolation tests

## Troubleshooting

### iOS Tests Not Running
- Ensure Xcode command line tools are installed: `xcode-select --install`
- Check Swift version: `swift --version`
- Clean build: `rm -rf .build && swift test`

### Android Tests Not Running
- Verify JDK version: `java -version`
- Clean Gradle cache: `./gradlew clean`
- Check test output: `./gradlew test --info`

### Network Mock Issues
- iOS: Verify `URLProtocol.registerClass` is called before tests
- Android: Ensure `MockWebServer.start()` completes before test execution

## Contributing

When adding new tests:
1. Follow the existing test structure
2. Use descriptive test names
3. Add appropriate test category comments
4. Update this README with new test counts
5. Ensure tests clean up resources properly
