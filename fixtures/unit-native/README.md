# Unit Native Tests

Native unit tests for `@hot-updater/react-native` iOS and Android implementations.

This fixture provides a dedicated testing environment for the native code in the `@hot-updater/react-native` package without modifying the package itself.

## Overview

- **iOS Tests**: Swift Testing framework for iOS native code
- **Android Tests**: JUnit 5 (Jupiter) for Android native code
- **Test Target**: Services and implementations in `packages/react-native`

## Quick Start

### Run All Tests

```bash
# From repository root
cd fixtures/unit-native
pnpm test
```

### Run Platform-Specific Tests

```bash
# iOS only
pnpm test:ios

# Android only
pnpm test:android
```

## Project Structure

```
unit-native/
├── package.json           # Test scripts and configuration
├── ios/                   # iOS Swift tests
│   ├── Package.swift      # Swift Package Manager config
│   ├── Tests/             # Test files
│   └── README.md          # iOS testing guide
└── android/               # Android Kotlin tests
    ├── build.gradle       # Gradle configuration
    ├── settings.gradle    # Project settings
    ├── src/test/          # Test files
    └── README.md          # Android testing guide
```

## Test Coverage

Both iOS and Android tests cover:

- **HotUpdaterImpl** - Main implementation logic
- **BundleFileStorageService** - Bundle storage management
- **DecompressService** - Compression/decompression strategies (ZIP, TAR.GZ, TAR.BR)
- **HashUtils** - SHA256 hash calculation and verification
- **FileManagerService** - File system operations

## Requirements

### iOS
- Xcode 15.0+
- Swift 6.0+
- macOS 10.15+

### Android
- JDK 17+
- Gradle 7.2+
- Kotlin 1.9+

## Platform-Specific Guides

For detailed platform-specific instructions, see:
- [iOS Testing Guide](./ios/README.md)
- [Android Testing Guide](./android/README.md)

## CI/CD Integration

These tests can be integrated into GitHub Actions workflow for automated testing on every commit or pull request.

## Development Workflow

1. **Make changes** to native code in `packages/react-native/ios` or `packages/react-native/android`
2. **Write tests** in this directory to verify the changes
3. **Run tests** locally to ensure everything works
4. **Commit** both code changes and new tests together

## Troubleshooting

### iOS Build Issues
- Ensure Xcode Command Line Tools are installed: `xcode-select --install`
- Try rebuilding: `swift package clean && swift test --package-path ios`

### Android Build Issues
- Clear Gradle cache: `cd android && ./gradlew clean --refresh-dependencies`
- Verify JDK version: `java -version` (should be 17+)

### Missing Dependencies
- Ensure `@hot-updater/react-native` is built first from repository root: `pnpm build`

## Contributing

When adding new features to the native code:
1. Add corresponding test files in this directory
2. Follow existing test patterns and naming conventions
3. Ensure tests pass before submitting PR

## License

Same as the main HotUpdater project.
