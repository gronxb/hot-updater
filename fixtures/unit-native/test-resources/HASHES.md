# Test Bundle SHA256 Hashes

These hashes are used in the integration tests for verifying bundle integrity.

## File Hashes

- **test-bundle-valid.zip**: `9a885c0ebee4f7a9dce994f626b1fb4cebfde6e3608fb01f714061d7c4e70e3f`
- **test-bundle-corrupted.zip**: `38893dade3c03e3521f5750c4a8ee90cd6d7b1eeb30b410a0cce483ea6ede84b`
- **test-bundle-invalid.zip**: `accc5fb6b024d45a87a6013f3aff7ddd94de4463bfd7d3814d37e090d4fd594f`

## Bundle Contents

### test-bundle-valid.zip
Contains proper React Native bundle files:
- `index.ios.bundle` - Minimal iOS bundle
- `index.android.bundle` - Minimal Android bundle

### test-bundle-corrupted.zip
Invalid ZIP file (corrupted format) for testing error handling.

### test-bundle-invalid.zip
Valid ZIP structure but missing required index bundle files.
Contains only: `wrong-file.txt`
