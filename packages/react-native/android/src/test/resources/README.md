# Test Resources

This directory contains test bundle files for native Android unit tests.

## Required Files

- `test-bundle.zip` - Normal React Native bundle ZIP file for testing
- `corrupted-bundle.zip` - Invalid ZIP file for testing error handling
- `invalid-structure-bundle.zip` - Valid ZIP but missing index.android.bundle

## Creating Test Bundles

### Normal Test Bundle
```bash
# Create a minimal React Native bundle
mkdir -p temp-bundle
echo "// Test bundle" > temp-bundle/index.android.bundle
cd temp-bundle && zip -r ../test-bundle.zip . && cd ..
rm -rf temp-bundle
```

### Corrupted Bundle
```bash
# Create an invalid ZIP file
echo "This is not a valid ZIP file" > corrupted-bundle.zip
```

### Invalid Structure Bundle
```bash
# Create a ZIP without the required bundle file
mkdir -p temp-invalid
echo "// Other file" > temp-invalid/other.js
cd temp-invalid && zip -r ../invalid-structure-bundle.zip . && cd ..
rm -rf temp-invalid
```

## Pre-calculated Hashes

For hash verification tests, use these SHA256 hashes:
- `test-bundle.zip`: (to be calculated after creating the actual file)
- Expected hash for testing success case
- Wrong hash for testing failure case

## Usage in Tests

These resources are loaded in `HotUpdaterIntegrationTest.kt` using:
```kotlin
val testBundleUrl = javaClass.classLoader?.getResource("test-bundle.zip")
val testBundleFile = File(testBundleUrl?.toURI())
```
