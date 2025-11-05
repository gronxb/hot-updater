# Test Resources

This directory contains test bundle files for native iOS unit tests.

## Required Files

- `test-bundle.zip` - Normal React Native bundle ZIP file for testing
- `corrupted-bundle.zip` - Invalid ZIP file for testing error handling
- `invalid-structure-bundle.zip` - Valid ZIP but missing index.ios.bundle

## Creating Test Bundles

### Normal Test Bundle
```bash
# Create a minimal React Native bundle
mkdir -p temp-bundle
echo "// Test bundle" > temp-bundle/index.ios.bundle
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

These resources are loaded in `HotUpdaterIntegrationTests.swift` using:
```swift
let bundle = Bundle.module
let testBundleURL = bundle.url(forResource: "test-bundle", withExtension: "zip")
```
