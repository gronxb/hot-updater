# Native E2E Integration Testing Plan for Hot Updater React Native Package

## Overview
This document describes **E2E integration tests** for the core OTA functionality of the `@hot-updater/react-native` package.

Tests are implemented in the `fixtures/unit-native` directory, completely separate from the main package. Tests use **real implementation code** with **mocked network only**.

## Test Infrastructure

### Location
All native tests are located in:
```
fixtures/unit-native/
├── ios/          # iOS Swift tests (E2E with Tuist)
├── android/      # Android Kotlin tests (Placeholder)
└── test-resources/  # Shared test bundle files
```

### iOS (Swift) - Full E2E Tests
- **Framework**: Swift Testing (modern async testing framework)
- **Build System**: Tuist (project generation tool)
- **Location**: `fixtures/unit-native/ios/`
- **Source Strategy**: References original implementation from `packages/react-native/ios/HotUpdater/Internal/` directly (no file copying)
- **Excluded Files**: React Native dependent files (HotUpdaterImpl.swift, HotUpdaterFactory.swift, HotUpdater.kt)
- **Dependencies**: SWCompression (for TAR.GZ/TAR.BR decompression)
- **Command**: `pnpm test:ios` or `cd ios && mise exec -- tuist test`
- **Prerequisites**: Requires `mise` tool manager with Tuist installed

### Android (Kotlin) - Placeholder Tests
- **Framework**: JUnit 5 (Jupiter)
- **Build System**: Android Gradle Plugin 8.1.0
- **Location**: `fixtures/unit-native/android/`
- **Current Status**: Placeholder tests only (basic infrastructure verification)
- **Limitation**: Android Gradle Plugin cannot selectively include/exclude source files like Tuist
- **Command**: `pnpm test:android` or `cd android && ./gradlew test`
- **Note**: Full E2E tests require React Native environment due to Gradle source set limitations

## 🎯 E2E Test Scenarios

### Current Implementation Status

#### iOS: `HotUpdaterIntegrationTests.swift` ✅
- **Status**: Infrastructure ready, basic tests passing
- **Tests**: 2 basic validation tests
  - ✅ Basic test - Check if test framework works
  - ✅ Check if original sources are accessible
- **Ready for**: Full E2E scenario implementation

#### Android: `PlaceholderTest.kt` ⚠️
- **Status**: Placeholder tests only
- **Tests**: 2 infrastructure tests
  - ✅ Basic test - Verify test framework works
  - ✅ Test infrastructure is properly configured
- **Limitation**: Cannot reference original sources without React Native dependencies

### Planned E2E Test Scenarios (iOS Only)

**1. Basic OTA Flow (3 tests)** - TO BE IMPLEMENTED

⏳ **testCompleteOTAUpdate_FirstInstall** - Complete first-time OTA update flow
⏳ **testCompleteOTAUpdate_Upgrade** - Upgrade from existing bundle to new version
⏳ **testUpdateWithProgress** - Track complete progress (0% → 80% download, 80% → 100% extraction)

**2. File System Isolation (3 tests)** - TO BE IMPLEMENTED

⏳ **testIsolation_DifferentAppVersions** - Isolation by app version (1.0.0 vs 2.0.0)
⏳ **testIsolation_DifferentFingerprints** - Isolation by fingerprint hash (abc123 vs def456)
⏳ **testIsolation_DifferentChannels** - Isolation by channel (production vs staging)

**3. Cache & Persistence (3 tests)** - TO BE IMPLEMENTED

⏳ **testBundlePersistence_AfterRestart** - Preserve OTA bundle after app restart
⏳ **testUpdateBundle_SameBundleId** - Reinstall with same bundleId (cache reuse)
⏳ **testRollback_ToFallback** - Rollback to fallback bundle

**4. Error Handling (5 tests)** - TO BE IMPLEMENTED

⏳ **testUpdateFailure_NetworkError** - Handle network errors during download
⏳ **testUpdateFailure_CorruptedBundle** - Handle corrupted bundle files (extraction fails)
⏳ **testUpdateFailure_InvalidBundleStructure** - Handle invalid bundle structure (missing index.*.bundle)
⏳ **testUpdateFailure_InsufficientDiskSpace** - Handle insufficient disk space (required: fileSize * 2)
⏳ **testUpdateInterruption_AndRetry** - Retry after interrupted update (.tmp cleanup)

**5. Hash Verification (2 tests)** - TO BE IMPLEMENTED

⏳ **testUpdateWithHashVerification_Success** - Complete OTA flow with hash verification
⏳ **testUpdateWithHashVerification_Failure** - Handle hash mismatch (file deletion)

**6. Concurrency (1 test)** - TO BE IMPLEMENTED

⏳ **testConcurrentUpdates_Sequential** - Sequential update handling without conflicts

---

### Detailed Test Scenarios

#### testCompleteOTAUpdate_FirstInstall
- **Scenario**: Download bundle → Extract → Save to file system → Update Preferences → Return bundle path
- **Verify**: All steps succeed, correct bundle path returned

#### testCompleteOTAUpdate_Upgrade
- **Scenario**: Install v1 → Install v2 → Verify v1 deletion via cleanupOldBundles
- **Verify**: v2 activated, v1 deleted

#### testIsolation_DifferentAppVersions
- **Scenario**: Save bundles with different app versions (1.0.0 vs 2.0.0)
- **Verify**: Different isolationKey, Preferences isolated, file systems independent

#### testIsolation_DifferentFingerprints
- **Scenario**: Save bundles with different fingerprints (abc123 vs def456)
- **Verify**: Different isolationKey, Preferences isolated

#### testIsolation_DifferentChannels
- **Scenario**: Save bundles to different channels (production vs staging)
- **Verify**: Different isolationKey, each channel manages bundles independently

#### testRollback_ToFallback
- **Scenario**: Install OTA bundle → Call updateBundle(bundleId, fileUrl: nil) → Verify fallback
- **Verify**: Cached bundle removed, falls back to fallback bundle

#### testConcurrentUpdates_Sequential
- **Scenario**: Start update A → Start update B before A completes
- **Verify**: No conflicts, B activated in the end

#### testUpdateWithProgress
- **Scenario**: Monitor progress during complete OTA update
- **Verify**: 0% → 80% (download), 80% → 100% (extraction), callbacks called sequentially

#### testUpdateFailure_NetworkError
- **Scenario**: Simulate network disconnection during download
- **Verify**: Error returned, incomplete files deleted, existing bundle preserved, no Preferences changes

#### testUpdateFailure_CorruptedBundle
- **Scenario**: Download succeeds but provides invalid ZIP → Attempt extraction
- **Verify**: Extraction fails, .tmp directory cleaned, existing bundle preserved, error thrown

#### testUpdateFailure_InvalidBundleStructure
- **Scenario**: ZIP extraction succeeds but index.*.bundle is missing
- **Verify**: Validation fails, .tmp directory cleaned, existing bundle preserved, error thrown

#### testBundlePersistence_AfterRestart
- **Scenario**: Install OTA bundle → Recreate HotUpdaterImpl (simulate restart) → Call getBundleURL()
- **Verify**: Path restored from Preferences, correct path returned, file exists, cached bundle prioritized

#### testUpdateBundle_SameBundleId
- **Scenario**: Install bundle → Call updateBundle with same bundleId again
- **Verify**: Cached bundle reused, download skipped, fast response (< 100ms)

#### testUpdateFailure_InsufficientDiskSpace
- **Scenario**: Attempt large bundle download → Disk space check fails
- **Verify**: Space checked before download, error thrown, no network requests, existing bundle preserved

#### testUpdateWithHashVerification_Success
- **Scenario**: Call updateBundle with fileHash → Download → Extract → Verify SHA256 hash
- **Verify**: Hash verification performed, installation proceeds when match, bundle activated

#### testUpdateWithHashVerification_Failure
- **Scenario**: Call updateBundle with incorrect fileHash → Verify after download
- **Verify**: Hash mismatch detected, error thrown, file deleted, .tmp cleaned, existing bundle preserved

#### testUpdateInterruption_AndRetry
- **Scenario**: Start update → Interrupt during extraction (leave .tmp) → Retry with same bundleId
- **Verify**: .tmp auto-cleaned, new update proceeds normally, bundle installs successfully, no conflicts

---

## Test Execution Strategy

### 1. Mock Strategy (iOS Only)
- **Network**: Mock HTTP server using URLProtocol (to be implemented with MockURLProtocol.swift helper)
- **File System**: Real file system operations using FileManagerService
- **Dependencies**: Real implementation services (FileManagerService, DecompressService, etc.)
- **Source Code**: References original implementation from `packages/react-native/ios/` via Tuist glob patterns

### 2. Test Data (Prepared)
- **Location**: `fixtures/unit-native/test-resources/`
- **Bundle Files**:
  - `index.ios.bundle` - Minimal React Native iOS bundle
  - `index.android.bundle` - Minimal React Native Android bundle
- **ZIP Archives**:
  - `test-bundle-valid.zip` - Valid bundle for success scenarios
  - `test-bundle-corrupted.zip` - Corrupted file for error handling tests
  - `test-bundle-invalid.zip` - Invalid structure for validation tests
- **Hash Values**: Pre-calculated SHA256 hashes documented in `test-resources/HASHES.md`

### 3. CI Integration (To be configured)

Tests will run in GitHub Actions workflows:

**iOS** (`.github/workflows/integration-ios.yml`):
```yaml
unit-tests:
  runs-on: macos-14
  name: iOS Native E2E Tests
  steps:
    - uses: actions/checkout@v3
    - name: Setup pnpm
      uses: pnpm/action-setup@v2
    - name: Setup Node.js
      uses: actions/setup-node@v3
      with:
        node-version-file: .node-version
        cache: "pnpm"
    - run: pnpm install

    # Install mise and Tuist
    - name: Install mise
      run: |
        curl https://mise.run | sh
        echo "$HOME/.local/bin" >> $GITHUB_PATH
    - name: Install Tuist via mise
      run: |
        mise install tuist@latest
        mise use tuist@latest

    - name: Run iOS Native E2E Tests
      run: |
        cd fixtures/unit-native
        pnpm test:ios
```

**Android** (`.github/workflows/integration-android.yml`):
```yaml
unit-tests:
  runs-on: ubuntu-latest
  name: Android Placeholder Tests
  steps:
    - uses: actions/checkout@v3
    - name: Setup pnpm
      uses: pnpm/action-setup@v2
    - name: Setup Node.js
      uses: actions/setup-node@v3
      with:
        node-version-file: .node-version
        cache: "pnpm"
    - run: pnpm install

    - name: Run Android Placeholder Tests
      run: |
        cd fixtures/unit-native
        pnpm test:android
```

**Triggers**:
- iOS tests run when files change in:
  - `packages/react-native/ios/HotUpdater/Internal/**`
  - `fixtures/unit-native/ios/**`
  - `fixtures/unit-native/test-resources/**`
- Android tests run when files change in:
  - `fixtures/unit-native/android/**`

### 4. Coverage Goals
- **iOS Target**: E2E coverage of core OTA flow (17 scenarios)
- **Android Target**: Infrastructure validation only
- **Focus**: Integration tests for complete user flows
- **Tools**: Tuist test coverage reports (iOS only)

## Test File Structure

```
fixtures/unit-native/
├── .gitignore                              # Excludes build artifacts
├── README.md                               # Main testing guide
├── package.json                            # Test scripts (test:ios, test:android, test)
├── test-resources/                         # ✅ Shared test data
│   ├── HASHES.md                          # SHA256 hashes for test bundles
│   ├── index.ios.bundle                   # Minimal iOS bundle
│   ├── index.android.bundle               # Minimal Android bundle
│   ├── test-bundle-valid.zip              # Valid bundle
│   ├── test-bundle-corrupted.zip          # Corrupted file
│   └── test-bundle-invalid.zip            # Invalid structure
├── ios/                                    # ✅ Tuist-based E2E tests
│   ├── Project.swift                      # Tuist project configuration
│   ├── Tuist/
│   │   ├── Config.swift                   # Tuist settings
│   │   └── Package.swift                  # External dependencies (SWCompression)
│   ├── README.md                          # iOS testing guide
│   └── Tests/HotUpdaterTests/
│       ├── HotUpdaterIntegrationTests.swift # ✅ Basic infrastructure tests (2 passing)
│       ├── Helpers/
│       │   ├── MockURLProtocol.swift      # ✅ HTTP mocking helper
│       │   └── TestHelpers.swift          # ✅ Test utility functions
│       └── Resources/                     # Symlinks to test-resources/
└── android/                                # ✅ Placeholder tests only
    ├── build.gradle                        # Android Gradle Plugin 8.1.0
    ├── settings.gradle                     # Plugin management
    ├── gradle.properties                   # AndroidX enabled
    ├── gradle/wrapper/                     # Gradle 8.2 wrapper
    ├── gradlew & gradlew.bat              # Wrapper scripts
    ├── README.md                           # Android testing guide
    └── src/test/kotlin/com/hotupdater/
        └── PlaceholderTest.kt              # ✅ Basic infrastructure tests (2 passing)
```

### Current Status
- ✅ **iOS Infrastructure**: Tuist-based, references original sources, tests passing
- ✅ **Android Infrastructure**: Gradle-based, placeholder tests passing
- ✅ **Test Resources**: Bundle files and ZIPs created with documented hashes
- ✅ **Test Helpers**: MockURLProtocol, TestHelpers utilities ready
- ✅ **Package Scripts**: Both `pnpm test:ios` and `pnpm test:android` working
- ⏳ **E2E Scenarios**: 17 iOS scenarios to be implemented
- ⏳ **CI/CD**: Workflows need Tuist setup for iOS

## Implementation Priority

**Phase 0: Infrastructure Setup (COMPLETED ✅)**
- ✅ Migrated from Swift Package Manager to Tuist for iOS
- ✅ Created Tuist project with direct source references (no file copying)
- ✅ Configured Android Gradle Plugin 8.1.0 with AndroidX
- ✅ Created test bundle resources (index.ios.bundle, index.android.bundle)
- ✅ Generated test ZIP files (valid, corrupted, invalid)
- ✅ Calculated SHA256 hashes and documented in HASHES.md
- ✅ Created test helper utilities (MockURLProtocol, TestHelpers)
- ✅ Configured `.gitignore` for build artifacts
- ✅ Updated package.json with working test scripts
- ✅ Verified both iOS and Android tests pass

**Phase 1: iOS E2E Test Implementation (Next - 1-2 weeks)**
- ⏳ Implement 3 Basic OTA Flow tests
- ⏳ Implement 3 File System Isolation tests
- ⏳ Implement 3 Cache & Persistence tests
- ⏳ Implement 5 Error Handling tests
- ⏳ Implement 2 Hash Verification tests
- ⏳ Implement 1 Concurrency test
- ⏳ Verify all 17 scenarios pass

**Phase 2: CI/CD Integration (After Phase 1)**
- ⏳ Update `.github/workflows/integration-ios.yml` with Tuist setup
- ⏳ Configure mise installation in GitHub Actions
- ⏳ Test workflow runs successfully
- ⏳ Set up proper path triggers for iOS tests

## Success Criteria

### Phase 0 (Infrastructure) - ✅ COMPLETED
- ✅ iOS test infrastructure using Tuist with direct source references
- ✅ Android test infrastructure with placeholder tests
- ✅ Test resources created (bundles, ZIPs, hashes)
- ✅ Test helpers implemented (MockURLProtocol, TestHelpers)
- ✅ Both `pnpm test:ios` and `pnpm test:android` working

### Phase 1 (E2E Tests) - ⏳ PENDING
- ⏳ 17 iOS E2E integration tests implemented and passing
- ⏳ E2E flow of OTA updates verified
- ⏳ File system isolation works (by app version, fingerprint, channel)
- ⏳ Error scenarios handled (network, corrupted bundle, invalid structure, hash mismatch, disk space, interruption)
- ⏳ Progress tracking accurate
- ⏳ Bundle persistence after restart verified
- ⏳ Cache reuse for same bundleId verified

### Phase 2 (CI/CD) - ⏳ PENDING
- ⏳ iOS tests run automatically in GitHub Actions
- ⏳ Tuist and mise properly installed in CI environment
- ⏳ Tests triggered on relevant file changes

## Summary

### Architecture Decision
- **iOS**: Full E2E tests with Tuist (references original sources directly)
- **Android**: Placeholder tests only (Gradle limitation prevents selective source inclusion)
- **Total**: 2 infrastructure tests (iOS) + 2 placeholder tests (Android) = 4 tests passing
- **Planned**: 17 E2E scenarios for iOS

### Test Scope

**✅ Phase 0 Completed (Infrastructure)**:
- Tuist-based iOS test project
- Direct source references (no file copying)
- Test resources and helpers
- Working test commands

**⏳ Phase 1 Planned (17 iOS E2E scenarios)**:
1. Basic OTA Flow (3): First install, Upgrade, Progress tracking
2. File System Isolation (3): By app version, fingerprint, channel
3. Cache & Persistence (3): After restart, Same bundleId reuse, Fallback rollback
4. Error Handling (5): Network error, Corrupted bundle, Invalid structure, Insufficient disk space, Interruption retry
5. Hash Verification (2): Success, Failure
6. Concurrency (1): Sequential updates

**❌ Out of Scope**:
- Android E2E tests (Gradle limitation)
- Individual service unit tests
- Multiple compression formats beyond what implementation supports
- File permission/security-specific tests

## Key Technical Decisions

### Why Tuist for iOS?
1. **Direct Source References**: Can reference files from `packages/react-native/ios/` without copying
2. **Selective Inclusion**: Glob patterns allow excluding React Native dependent files
3. **Modern Tooling**: Better than SPM for complex source layouts
4. **No File Duplication**: Maintains single source of truth

### Why Placeholder Tests for Android?
1. **Gradle Limitation**: Android Gradle Plugin includes ALL files in a srcDir
2. **Cannot Exclude**: No equivalent to Tuist's exclude patterns that actually work
3. **React Native Dependency**: Original sources require React Native classes
4. **Pragmatic Choice**: Infrastructure validation is valuable, full E2E requires RN environment

### Test Data Strategy
- **Minimal Bundles**: Smallest valid React Native bundles (< 1KB each)
- **Real ZIP Files**: Actual compressed archives, not mocked
- **Pre-calculated Hashes**: SHA256 values documented for verification tests
- **Shared Resources**: Both platforms can use same test bundles

## Quick Start

### Prerequisites
- **iOS**: Requires `mise` tool manager installed (`curl https://mise.run | sh`)
- **Android**: Standard Java/Gradle setup (JDK 17+)

### Running Tests Locally

```bash
# From repository root
cd fixtures/unit-native

# Install Tuist (iOS only, first time)
mise install tuist@latest
mise use tuist@latest

# Run all tests (iOS + Android)
pnpm test

# Run iOS tests only
pnpm test:ios

# Run Android tests only
pnpm test:android
```

### Current Test Status

**iOS**: 2 infrastructure tests passing ✅
- Basic test - Check if test framework works
- Check if original sources are accessible (FileManagerService, DecompressService)

**Android**: 2 placeholder tests passing ✅
- Basic test - Verify test framework works
- Test infrastructure is properly configured

**Next**: Implement 17 E2E scenarios for iOS

