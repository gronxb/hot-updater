# Test Resources

This directory contains resources used by unit tests, such as:

- Sample bundle ZIP files
- Mock JSON configuration files
- Test data files

Resources placed here will be accessible via the classpath during test execution.

## Usage in Tests

```kotlin
// Access a resource file
val resourceStream = javaClass.classLoader.getResourceAsStream("test-bundle.zip")
```
