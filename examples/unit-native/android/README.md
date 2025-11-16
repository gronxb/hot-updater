# Android Native Unit Tests

This directory contains unit tests for the Android native components of `@hot-updater/react-native`.

## Structure

- `build.gradle.kts` - Gradle build configuration
- `settings.gradle.kts` - Gradle settings
- `src/test/kotlin/com/hotupdater/` - Test files

## Running Tests

### Using Gradle

```bash
cd examples/unit-native/android
./gradlew test
```

### Using Gradle from project root

```bash
./gradlew :examples:unit-native:android:test
```

## Test Coverage

The tests cover the following components:

- **HashUtils** - SHA256 hash calculation and verification
- **VersionedPreferencesService** - Shared preferences with isolation keys

## Testing Framework

- **JUnit 5** - Testing framework
- **MockK** - Kotlin mocking library
- **Kotlin Coroutines Test** - For testing async code

## Adding New Tests

1. Create a new test file in `src/test/kotlin/com/hotupdater/`
2. Use JUnit 5 annotations (`@Test`, `@BeforeEach`, etc.)
3. Use MockK for mocking dependencies

Example:

```kotlin
package com.hotupdater

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertEquals

class MyTest {
  @Test
  fun `test something`() {
    val actual = 1 + 1
    assertEquals(2, actual)
  }
}
```

## Notes

- Tests use MockK to mock Android dependencies (Context, SharedPreferences, etc.)
- File-based tests create temporary files that are cleaned up after each test
