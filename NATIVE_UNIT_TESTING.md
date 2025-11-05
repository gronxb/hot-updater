# Native Unit Testing Plan for Hot Updater React Native Package (Core OTA Only)

## Overview
This document focuses on unit testing for the **core OTA functionality** of the `@hot-updater/react-native` package.

**Reduced Scope Goal**: Verify **complete OTA flow and core scenarios** rather than individual services.

## Test Infrastructure

### iOS (Swift)
- **Framework**: Swift Testing (built-in)
- **Run Command**: `swift test --package-path ios/HotUpdater`
- **Test Location**: `packages/react-native/ios/HotUpdater/Tests/`
- **Mock Strategy**: Protocol-based dependency injection

### Android (Kotlin)
- **Framework**: JUnit 5 + Mockito/MockK
- **Run Command**: `./gradlew test` or `./gradlew testDebugUnitTest`
- **Test Location**: `packages/react-native/android/src/test/java/com/hotupdater/`
- **Mock Strategy**: Interface-based dependency injection with MockK

## 🎯 Core OTA Test Scenarios (Reduced Scope)

### Integration Tests (End-to-End OTA Flow)

#### iOS: `HotUpdaterIntegrationTests.swift` & Android: `HotUpdaterIntegrationTest.kt`

**1. Basic OTA Flow (3 tests)**

✓ **testCompleteOTAUpdate_FirstInstall** - Complete first-time OTA update flow
✓ **testCompleteOTAUpdate_Upgrade** - Upgrade from existing bundle to new version
✓ **testUpdateWithProgress** - Track complete progress (0% → 80% download, 80% → 100% extraction)

**2. File System Isolation (3 tests)**

✓ **testIsolation_DifferentAppVersions** - Isolation by app version (1.0.0 vs 2.0.0)
✓ **testIsolation_DifferentFingerprints** - Isolation by fingerprint hash (abc123 vs def456)
✓ **testIsolation_DifferentChannels** - Isolation by channel (production vs staging)

**3. Cache & Persistence (3 tests)**

✓ **testBundlePersistence_AfterRestart** - Preserve OTA bundle after app restart
✓ **testUpdateBundle_SameBundleId** - Reinstall with same bundleId (cache reuse)
✓ **testRollback_ToFallback** - Rollback to fallback bundle

**4. Error Handling (5 tests)**

✓ **testUpdateFailure_NetworkError** - Handle network errors during download
✓ **testUpdateFailure_CorruptedBundle** - Handle corrupted bundle files (extraction fails)
✓ **testUpdateFailure_InvalidBundleStructure** - Handle invalid bundle structure (missing index.*.bundle)
✓ **testUpdateFailure_InsufficientDiskSpace** - Handle insufficient disk space (required: fileSize * 2)
✓ **testUpdateInterruption_AndRetry** - Retry after interrupted update (.tmp cleanup)

**5. Hash Verification (2 tests)**

✓ **testUpdateWithHashVerification_Success** - Complete OTA flow with hash verification
✓ **testUpdateWithHashVerification_Failure** - Handle hash mismatch (file deletion)

**6. Concurrency (1 test)**

✓ **testConcurrentUpdates_Sequential** - Sequential update handling without conflicts

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

### 1. Mock Strategy
- **Network**: Mock HTTP server serving actual bundle ZIP files (iOS: URLProtocol, Android: MockWebServer)
- **File System**: Real file system in temp directory with guaranteed cleanup
- **Dependencies**: Real services (FileManagerService, DecompressService, BundleFileStorageService), mock network only

### 2. Test Data
- **Bundle Files**: Small ZIP files with actual React Native bundles (index.ios.bundle / index.android.bundle)
- **Hash Values**: Pre-calculated SHA256 hashes
- **Mock Server**: Local server serving actual ZIP files

### 3. CI Integration

**iOS**:
```yaml
- name: Run iOS Unit Tests
  run: |
    cd packages/react-native
    swift test --package-path ios/HotUpdater
```

**Android**:
```yaml
- name: Run Android Unit Tests
  run: |
    cd packages/react-native/android
    ./gradlew test
    ./gradlew testDebugUnitTest
```

### 4. Coverage Goals
- **Target**: 100% coverage of core OTA flow
- **Focus**: Integration tests for complete flow
- **Tools**: iOS: `swift test --enable-code-coverage`, Android: JaCoCo

## Test File Structure

```
packages/react-native/
├── ios/HotUpdater/Tests/
│   ├── HotUpdaterIntegrationTests.swift
│   └── Resources/test-bundle.zip
└── android/src/test/java/com/hotupdater/
    ├── HotUpdaterIntegrationTest.kt
    └── resources/test-bundle.zip
```

## Implementation Priority

**Phase 1: Test Setup (1-3 days)**
- Configure mock HTTP server (iOS: URLProtocol, Android: MockWebServer)
- Create test bundle ZIP files (normal, corrupted, invalid structure)
- Write test helper functions

**Phase 2: Core Integration Tests (1-1.5 weeks)**
- Write HotUpdaterIntegrationTests (iOS & Android)
- Implement 17 scenarios: Basic (3), Isolation (3), Cache (3), Errors (5), Hash (2), Concurrency (1)
- CI integration

## Success Criteria

✅ 17 core integration tests pass (iOS 17 + Android 17 = 34 total)
✅ Tests run automatically in CI
✅ E2E flow of OTA updates verified
✅ File system isolation works (by app version, fingerprint, channel)
✅ Error scenarios handled (network, corrupted bundle, invalid structure, hash mismatch, disk space, interruption)
✅ Progress tracking accurate
✅ Bundle persistence after restart verified
✅ Cache reuse for same bundleId verified

## Summary

### Before (Full Scope)
- **Total Tests**: ~115 tests across 7 categories
- **Estimated Time**: 5-8 weeks

### Current (Core OTA Only)
- **Total Tests**: 34 tests (iOS 17 + Android 17)
- **Test Categories**: 1 (End-to-End OTA Flow)
- **Estimated Time**: 1-2 weeks

### Test Coverage

**✅ Included (17 scenarios)**:
1. Basic OTA Flow (3): First install, Upgrade, Progress tracking
2. File System Isolation (3): By app version, fingerprint, channel
3. Cache & Persistence (3): After restart, Same bundleId reuse, Fallback rollback
4. Error Handling (5): Network error, Corrupted bundle, Invalid structure, Insufficient disk space, Interruption retry
5. Hash Verification (2): Success, Failure
6. Concurrency (1): Sequential updates

**❌ Excluded**:
- Individual service unit tests (DownloadService, DecompressService, etc.)
- Multiple compression formats (TAR.GZ, TAR.BR - ZIP only)
- File permission/security tests
- Individual function-level tests

## Notes

- **Real implementation testing**: Mock network only, use real implementation for everything else
- **Test bundles**: Small ZIP files with actual React Native bundles
- **Temp directory**: Tests run in temp with cleanup
- **CI Integration**: Run automatically in GitHub Actions
