# Android Native Unit Tests

This directory contains native unit tests for the `@hot-updater/react-native` Android implementation using JUnit 5 (Jupiter).

## Prerequisites

- JDK 17 or later
- Gradle 7.2 or later
- Kotlin 1.9 or later

## Test Structure

```
android/
├── build.gradle                           # Gradle build configuration
├── settings.gradle                        # Project settings
├── gradle.properties                      # Gradle properties
└── src/
    └── test/
        └── kotlin/com/hotupdater/
            ├── HotUpdaterImplTest.kt      # Tests for main HotUpdater implementation
            ├── BundleFileStorageServiceTest.kt
            ├── DecompressServiceTest.kt   # Tests for decompression strategies
            ├── HashUtilsTest.kt           # Tests for SHA256 hash utilities
            └── FileManagerServiceTest.kt  # Tests for file system operations
```

## Running Tests

### Command Line

From the repository root:

```bash
cd fixtures/unit-native
pnpm test:android
```

Or directly from this directory:

```bash
cd fixtures/unit-native/android
./gradlew test
```

### Android Studio

1. Open the `android` directory in Android Studio
2. Wait for Gradle sync to complete
3. Right-click on the test directory or individual test file
4. Select "Run Tests" or press `Ctrl + Shift + F10` (Windows/Linux) / `Cmd + Shift + R` (macOS)

### Test Report

After running tests, view the HTML report at:
```
android/build/reports/tests/test/index.html
```

## Test Framework

This project uses **JUnit 5 (Jupiter)**, the latest version of JUnit with modern features for Kotlin.

### Basic Test Structure

```kotlin
package com.hotupdater

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Assertions.*

@DisplayName("My Test Suite")
class MyTest {

    @Test
    @DisplayName("Test description")
    fun `test something works correctly`() {
        // Arrange
        val expected = "value"

        // Act
        val actual = someFunction()

        // Assert
        assertEquals(expected, actual)
    }
}
```

## Dependencies

The tests have access to all classes and services from the main HotUpdater package:

- `HotUpdaterImpl` - Main implementation
- `HotUpdaterFactory` - Singleton factory with lazy initialization
- `BundleFileStorageService` - Bundle storage management
- `DecompressService` - Decompression with strategy pattern
- `HashUtils` - SHA256 hash calculation and verification
- `FileManagerService` - File system operations
- Decompression strategies (ZIP, TAR.GZ, TAR.BR)

### Test Dependencies

- **JUnit 5** - Modern testing framework
- **Mockito** - Mocking framework for unit tests
- **Kotlin Test** - Kotlin-specific test utilities
- **Coroutines Test** - Testing utilities for Kotlin coroutines

## Gradle Commands

```bash
# Run all tests
./gradlew test

# Run tests with detailed output
./gradlew test --info

# Run specific test class
./gradlew test --tests "com.hotupdater.HotUpdaterImplTest"

# Run specific test method
./gradlew test --tests "com.hotupdater.HotUpdaterImplTest.test getAppVersion returns valid version"

# Clean and test
./gradlew clean test

# Generate coverage report (if configured)
./gradlew test jacocoTestReport
```

## CI/CD Integration

Tests are automatically run in GitHub Actions workflow. See `.github/workflows/` for configuration.

## Writing New Tests

1. Create a new `.kt` file in `src/test/kotlin/com/hotupdater/`
2. Import necessary testing libraries:
   ```kotlin
   import org.junit.jupiter.api.Test
   import org.junit.jupiter.api.DisplayName
   import org.junit.jupiter.api.Assertions.*
   ```
3. Create a test class with `@DisplayName` annotation
4. Add test methods with `@Test` annotation
5. Use backtick syntax for readable test names in Kotlin

## Testing Best Practices

### Use Descriptive Test Names

```kotlin
@Test
@DisplayName("SHA256 hash calculation returns consistent results")
fun `test SHA256 hash consistency`() {
    // Test implementation
}
```

### Follow AAA Pattern

```kotlin
@Test
fun `test something`() {
    // Arrange - Set up test data
    val input = "test"

    // Act - Execute the code under test
    val result = functionUnderTest(input)

    // Assert - Verify the results
    assertEquals(expected, result)
}
```

### Use Mockito for Dependencies

```kotlin
import org.mockito.kotlin.mock
import org.mockito.kotlin.whenever

@Test
fun `test with mocked dependency`() {
    val mockService = mock<SomeService>()
    whenever(mockService.getData()).thenReturn("mocked data")

    // Use mockService in your test
}
```

## Troubleshooting

### Build Errors

If you encounter build errors:
- Ensure the main `@hot-updater/react-native` package is built first
- Run `./gradlew clean` and try again
- Check that JDK 17+ is installed: `java -version`
- Verify Gradle version: `./gradlew --version`

### Test Failures

- Review test output for detailed error messages
- Check that test fixtures and mock data are properly configured
- Ensure you're testing the correct version of the native code
- Use `--info` or `--debug` flags for more detailed output

### Dependency Issues

If dependencies can't be resolved:
- Check network connection
- Clear Gradle cache: `./gradlew clean --refresh-dependencies`
- Verify `settings.gradle` correctly references the main package

## References

- [JUnit 5 User Guide](https://junit.org/junit5/docs/current/user-guide/)
- [Kotlin Testing Documentation](https://kotlinlang.org/docs/jvm-test-using-junit.html)
- [Mockito Documentation](https://site.mockito.org/)
- [Gradle Testing Documentation](https://docs.gradle.org/current/userguide/java_testing.html)
- [HotUpdater Documentation](../../../docs)
