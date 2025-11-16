# Hot Updater E2E Tests

End-to-end testing suite for Hot Updater using Detox. This test suite validates the OTA update functionality across multiple React Native versions and configurations.

## Overview

This E2E test suite is designed to:

- Test Hot Updater functionality on multiple React Native versions (0.76.1, 0.77.0, 0.81.0, and Expo 52)
- Verify OTA update flows, including download, installation, and rollback
- Test different update strategies (Fingerprint and App Version)
- Support both iOS and Android platforms
- Run in CI/CD environments

## Project Structure

```
e2e/
├── .detoxrc.js              # Detox configuration for all example apps
├── package.json             # E2E-specific dependencies
├── tsconfig.json            # TypeScript configuration
├── e2e/
│   └── jest.config.js       # Jest test runner configuration
├── scripts/
│   ├── build-apps.ts        # Script to build example apps
│   ├── select-target.ts     # Helper to select test configurations
│   └── cleanup.ts           # Clean up build artifacts
├── tests/
│   ├── basic/
│   │   └── app-launch.e2e.ts       # Basic app launch tests
│   ├── update/
│   │   ├── ota-update.e2e.ts       # OTA update flow tests
│   │   ├── rollback.e2e.ts         # Update rollback tests
│   │   └── strategy.e2e.ts         # Update strategy tests
│   └── helpers/
│       └── test-utils.ts           # Test utilities and helpers
├── android-setup/           # Android Detox configuration templates
└── build/                   # Build artifacts (gitignored)
```

## Prerequisites

### System Requirements

- **Node.js**: v18 or later
- **macOS**: Required for iOS testing (with Xcode installed)
- **Android Studio**: Required for Android testing
- **Detox CLI**: `npm install -g detox-cli` (optional, can use `npx detox`)

### iOS Setup

1. Install Xcode from the App Store
2. Install Xcode command-line tools:
   ```bash
   xcode-select --install
   ```
3. Install applesimutils (required by Detox):
   ```bash
   brew tap wix/brew
   brew install applesimutils
   ```
4. Verify available simulators:
   ```bash
   xcrun simctl list devicetypes
   ```

### Android Setup

1. Install Android Studio
2. Set up Android SDK (API level 35 recommended)
3. Create an Android emulator:
   ```bash
   # List available emulator AVDs
   emulator -list-avds

   # Or create a new one via Android Studio AVD Manager
   ```
4. Update `.detoxrc.js` with your emulator name if different from `Pixel_8_API_35`

## Installation

From the root of the Hot Updater repository:

```bash
# Install E2E dependencies
cd e2e
pnpm install
```

## Android Configuration

Each example app needs Detox configuration in its Android native code. Follow these steps for each app you want to test:

### 1. Update `android/build.gradle`

Add Detox repository and Kotlin support (see `android-setup/build.gradle.additions`):

```gradle
buildscript {
    ext {
        kotlinVersion = "2.1.20"
    }
    dependencies {
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin")
    }
}

allprojects {
    repositories {
        maven {
            url "$rootDir/../node_modules/detox/Detox-android"
        }
    }
}
```

### 2. Update `android/app/build.gradle`

Add test runner and dependencies (see `android-setup/app-build.gradle.additions`):

```gradle
android {
    defaultConfig {
        testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner"
    }
}

dependencies {
    androidTestImplementation('com.wix:detox:+')
    androidTestImplementation 'junit:junit:4.13.2'
    androidTestImplementation 'androidx.test:runner:1.5.2'
    androidTestImplementation 'androidx.test:rules:1.5.0'
}
```

### 3. Create DetoxTest.java

Create `android/app/src/androidTest/java/com/[your-package]/DetoxTest.java` using the template in `android-setup/DetoxTest.java.template`.

### 4. Add Network Security Config

Create `android/app/src/main/res/xml/network_security_config.xml` from `android-setup/network_security_config.xml` and reference it in `AndroidManifest.xml` (see `android-setup/AndroidManifest.xml.additions`).

## Available Test Configurations

The following configurations are available:

| App | Platform | Configuration | React Native Version |
|-----|----------|---------------|---------------------|
| expo-52 | iOS | `expo52.ios` | 0.76.9 (via Expo 52) |
| expo-52 | Android | `expo52.android` | 0.76.9 (via Expo 52) |
| v0.81.0 | iOS | `v0810.ios` | 0.81.0 |
| v0.81.0 | Android | `v0810.android` | 0.81.0 |
| v0.77.0 | iOS | `v0770.ios` | 0.77.0 |
| v0.77.0 | Android | `v0770.android` | 0.77.0 |
| v0.76.1-new-arch | iOS | `v0761newarch.ios` | 0.76.1 (New Architecture) |
| v0.76.1-new-arch | Android | `v0761newarch.android` | 0.76.1 (New Architecture) |

View all configurations:
```bash
pnpm select
```

## Usage

### Building Example Apps

Before running tests, you need to build the example apps:

```bash
# From the root directory
pnpm e2e:build

# Or build specific app
cd e2e
pnpm build:apps --target expo52 --platform ios
pnpm build:apps --target v0810 --platform android

# Build all apps for all platforms
pnpm build:apps --target all --platform both
```

### Running Tests

```bash
# From the root directory
pnpm e2e:test

# Or from e2e directory
cd e2e

# Run tests for a specific configuration
detox test --configuration expo52.ios
detox test --configuration v0810.android

# Run with cleanup (recommended for first run)
detox test --configuration expo52.ios --cleanup
```

### Building Apps via Detox

You can also use Detox to build apps:

```bash
# Build iOS app
detox build --configuration expo52.ios

# Build Android app
detox build --configuration v0810.android
```

### Cleanup

Clean up build artifacts:

```bash
# From root directory
pnpm e2e:clean

# Or from e2e directory
cd e2e

# Clean all builds
pnpm clean --target all

# Clean specific app
pnpm clean --target expo52 --platform ios
```

## Writing Tests

### Test Structure

Tests are organized by functionality:

- `tests/basic/` - Basic app functionality tests
- `tests/update/` - OTA update-related tests
- `tests/helpers/` - Shared utilities and helpers

### Test Utilities

The `test-utils.ts` file provides helper functions:

```typescript
import {
  waitForAppReady,
  waitForElement,
  tapElement,
  takeScreenshot,
  describeIOS,
  describeAndroid,
} from "../helpers/test-utils";

describe("My Test Suite", () => {
  beforeAll(async () => {
    await waitForAppReady();
  });

  it("should do something", async () => {
    await waitForElement(element(by.id("my-element")));
    await tapElement(element(by.id("my-button")));
    await takeScreenshot("after-tap");
  });
});

// Platform-specific tests
describeIOS("iOS-only tests", () => {
  it("should work on iOS", async () => {
    // iOS-specific test
  });
});
```

### Best Practices

1. **Use testID**: Add `testID` props to React Native components for reliable element selection
2. **Wait for elements**: Always use `waitFor()` before interacting with elements
3. **Take screenshots**: Use `takeScreenshot()` for debugging and documentation
4. **Platform-specific tests**: Use `describeIOS()` and `describeAndroid()` for platform-specific logic
5. **Clean state**: Use `clearAppDataAndRestart()` when you need a fresh app state

## Troubleshooting

### iOS Issues

**Simulator not found**:
```bash
# List available simulators
xcrun simctl list devices available

# Update .detoxrc.js with an available device
```

**Build fails**:
```bash
# Clean iOS build
cd examples/expo-52/ios
rm -rf build Pods
bundle install
bundle exec pod install
```

### Android Issues

**Emulator not found**:
```bash
# List emulators
emulator -list-avds

# Start emulator manually
emulator -avd Pixel_8_API_35
```

**Build fails**:
```bash
# Clean Android build
cd examples/v0.81.0/android
./gradlew clean

# Or use the cleanup script
pnpm e2e:clean --target v0810 --platform android
```

### General Issues

**Detox hangs**:
- Ensure the simulator/emulator is running
- Try with `--cleanup` flag
- Check that the app bundle is up to date

**Tests are flaky**:
- Increase timeout values in `.detoxrc.js`
- Add explicit waits in test code
- Ensure test environment is stable

## CI/CD Integration

### GitHub Actions Example

```yaml
name: E2E Tests

on: [push, pull_request]

jobs:
  e2e-ios:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: pnpm install

      - name: Build apps
        run: pnpm e2e:build --target expo52 --platform ios

      - name: Run tests
        run: cd e2e && detox test --configuration expo52.ios --cleanup

  e2e-android:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3

      - name: Set up Android SDK
        uses: android-actions/setup-android@v2

      - name: Build apps
        run: pnpm e2e:build --target v0810 --platform android

      - name: Run tests
        uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 35
          script: cd e2e && detox test --configuration v0810.android
```

## Contributing

When adding new tests:

1. Follow existing test structure and naming conventions
2. Use test utilities from `helpers/test-utils.ts`
3. Add appropriate `testID` props to components
4. Document any special setup requirements
5. Ensure tests pass on both iOS and Android (if applicable)

## Resources

- [Detox Documentation](https://wix.github.io/Detox/)
- [Jest Documentation](https://jestjs.io/)
- [React Native Testing](https://reactnative.dev/docs/testing-overview)
