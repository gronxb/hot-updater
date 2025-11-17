# E2E Test Environment Setup Guide

This guide provides step-by-step instructions for setting up and running E2E tests for Hot Updater.

## Quick Start

```bash
# 1. Install dependencies
cd e2e
pnpm install

# 2. Select and run tests interactively
pnpm select

# 3. Or run tests directly
detox test --configuration expo52.ios
```

## Prerequisites

### Required Software

#### macOS (for iOS testing)
- Xcode 14.0 or later
- Xcode Command Line Tools
- applesimutils (for Detox)

```bash
# Install Command Line Tools
xcode-select --install

# Install applesimutils
brew tap wix/brew
brew install applesimutils
```

#### Android (for Android testing)
- Android Studio
- Android SDK (API level 35 recommended)
- Android Emulator or physical device
- JDK 17 or later

### System Setup

1. **Clone and install dependencies**
   ```bash
   git clone <repository>
   cd hot-updater
   pnpm install
   cd e2e
   pnpm install
   ```

2. **Verify iOS Simulator (macOS only)**
   ```bash
   xcrun simctl list devices available
   ```
   Make sure "iPhone 16" is available, or update `.detoxrc.js` with an available device.

3. **Verify Android Emulator**
   ```bash
   emulator -list-avds
   ```
   Make sure "Pixel_8_API_35" is available, or update `.detoxrc.js` with an available AVD.

## Android Configuration for Example Apps

Each example app needs Detox configuration in its Android code. Follow these steps:

### 1. Update `android/build.gradle`

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

Create `android/app/src/androidTest/java/com/hotupdaterexample/DetoxTest.java`:

```java
package com.hotupdaterexample;

import com.wix.detox.Detox;
import com.wix.detox.config.DetoxConfig;
import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.LargeTest;
import androidx.test.rule.ActivityTestRule;

@RunWith(AndroidJUnit4.class)
@LargeTest
public class DetoxTest {
    @Rule
    public ActivityTestRule<MainActivity> mActivityRule =
        new ActivityTestRule<>(MainActivity.class, false, false);

    @Test
    public void runDetoxTests() {
        DetoxConfig detoxConfig = new DetoxConfig();
        detoxConfig.idlePolicyConfig.masterTimeoutSec = 90;
        detoxConfig.idlePolicyConfig.idleResourceTimeoutSec = 60;
        detoxConfig.rnContextLoadTimeoutSec = (BuildConfig.DEBUG ? 180 : 60);

        Detox.runTests(mActivityRule, detoxConfig);
    }
}
```

### 4. Add Network Security Config

Create `android/app/src/main/res/xml/network_security_config.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">localhost</domain>
        <domain includeSubdomains="true">10.0.2.2</domain>
    </domain-config>
</network-security-config>
```

Update `AndroidManifest.xml`:

```xml
<application
    android:networkSecurityConfig="@xml/network_security_config"
    ...>
```

## Building Example Apps

### Using Interactive Selector

```bash
cd e2e
pnpm select
```

This will guide you through:
1. Selecting the app (expo52, v0810, v0770, v0761newarch)
2. Selecting the platform (iOS, Android)
3. Choosing action (build, test, or both)

### Using Build Script Directly

```bash
cd e2e

# Build all apps for all platforms
pnpm build:apps --target all --platform both

# Build specific app for iOS
pnpm build:apps --target expo52 --platform ios

# Build specific app for Android
pnpm build:apps --target v0810 --platform android
```

### Using Detox CLI

```bash
cd e2e

# Build iOS app
detox build --configuration expo52.ios

# Build Android app
detox build --configuration v0810.android
```

## Running Tests

### Interactive Mode (Recommended)

```bash
cd e2e
pnpm select
```

Select your target app, platform, and choose "Run tests" or "Build and test".

### Direct Commands

```bash
cd e2e

# Run tests for specific configuration
detox test --configuration expo52.ios
detox test --configuration v0810.android

# Run with cleanup (first time or after changes)
detox test --configuration expo52.ios --cleanup

# Run specific test file
detox test --configuration expo52.ios tests/basic/app-launch.e2e.ts
```

## Available Configurations

| Configuration | App | Platform | RN Version |
|--------------|-----|----------|------------|
| `expo52.ios` | Expo 52 | iOS | 0.76.9 |
| `expo52.android` | Expo 52 | Android | 0.76.9 |
| `v0810.ios` | Bare RN | iOS | 0.81.0 |
| `v0810.android` | Bare RN | Android | 0.81.0 |
| `v0770.ios` | Bare RN | iOS | 0.77.0 |
| `v0770.android` | Bare RN | Android | 0.77.0 |
| `v0761newarch.ios` | Bare RN (New Arch) | iOS | 0.76.1 |
| `v0761newarch.android` | Bare RN (New Arch) | Android | 0.76.1 |

## Cleanup

```bash
cd e2e

# Clean all build artifacts
pnpm clean --target all

# Clean specific app
pnpm clean --target expo52

# Clean specific app and platform
pnpm clean --target expo52 --platform ios
```

## Writing Tests

### Test File Structure

```typescript
import {
  waitForAppReady,
  waitForElement,
  tapElement,
  element,
  by,
  detoxExpect,
} from "../helpers/test-utils";

describe("My Test Suite", () => {
  beforeAll(async () => {
    await waitForAppReady();
  });

  it("should do something", async () => {
    await waitForElement(element(by.id("my-element")));
    await tapElement(element(by.id("my-button")));
    await detoxExpect(element(by.text("Success"))).toBeVisible();
  });
});
```

### Test Utilities

Available helpers in `tests/helpers/test-utils.ts`:

- `waitForAppReady()` - Wait for app to launch
- `waitForElement(matcher, timeout?)` - Wait for element to appear
- `tapElement(matcher)` - Tap an element
- `typeText(matcher, text)` - Type text into element
- `takeScreenshot(name)` - Take screenshot
- `sleep(ms)` - Wait for specified time
- `clearAppDataAndRestart()` - Reset app state
- `describeIOS(name, fn)` - iOS-only tests
- `describeAndroid(name, fn)` - Android-only tests

## Troubleshooting

### iOS Simulator Issues

**Simulator doesn't start:**
```bash
# Kill all simulators
killall Simulator

# List available devices
xcrun simctl list devices available

# Boot specific device
xcrun simctl boot "iPhone 16"
```

**Build fails:**
```bash
# Clean iOS build
cd examples/expo-52/ios
rm -rf build Pods Podfile.lock
bundle install
bundle exec pod install
```

### Android Emulator Issues

**Emulator doesn't start:**
```bash
# Kill ADB server
adb kill-server
adb start-server

# List devices
adb devices

# Start emulator
emulator -avd Pixel_8_API_35
```

**Build fails:**
```bash
# Clean Android build
cd examples/v0.81.0/android
./gradlew clean
./gradlew assembleDebug assembleAndroidTest -DtestBuildType=debug
```

### Detox Issues

**Tests hang:**
- Ensure simulator/emulator is running
- Try with `--cleanup` flag
- Increase timeout in `.detoxrc.js`

**Element not found:**
- Add explicit `waitFor()` before interactions
- Verify element has correct `testID`
- Use `takeScreenshot()` to debug UI state

**Connection refused:**
- Check network security config (Android)
- Verify Metro bundler is running
- Check reverse port forwarding (Android)

## CI/CD Setup

Example GitHub Actions workflow:

```yaml
name: E2E Tests

on: [push, pull_request]

jobs:
  e2e-ios:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Setup
        run: |
          brew tap wix/brew
          brew install applesimutils

      - name: Install dependencies
        run: pnpm install

      - name: Build and test
        run: |
          cd e2e
          detox build --configuration expo52.ios
          detox test --configuration expo52.ios --cleanup

  e2e-android:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Setup Android SDK
        uses: android-actions/setup-android@v3

      - name: Install dependencies
        run: pnpm install

      - name: Build and test
        uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 35
          arch: x86_64
          script: |
            cd e2e
            detox build --configuration v0810.android
            detox test --configuration v0810.android
```

## Next Steps

1. Configure Android native code for each example app
2. Write app-specific tests based on Hot Updater functionality
3. Set up CI/CD pipeline
4. Add more test scenarios as needed

For more information, see the [main README](./README.md).
