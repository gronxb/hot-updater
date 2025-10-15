# iOS Compression Strategy Implementation - TODO

This document outlines the remaining tasks to complete the compression strategy feature for iOS.

## Current Status

### ✅ Completed
- Type definitions for CompressionStrategy added to plugin-core
- Compression utilities (tar+brotli, tar+gzip) implemented in plugin-core
- All storage plugins updated to handle Content-Encoding metadata
- Deploy command updated to use compressionStrategy from config
- Android implementation fully completed:
  - HttpDownloadService updated to capture Content-Encoding header
  - UniversalDecompressionService created supporting zip, tar+brotli, tar+gzip
  - BundleFileStorageService updated to use new decompression service
  - Apache Commons Compress dependency added to build.gradle

### ⏳ Pending - iOS Implementation

#### 1. Update iOS Download Service
**Files to modify:**
- `packages/react-native/ios/HotUpdater/Internal/DownloadService.swift` (or equivalent)

**Changes needed:**
- Update download method to capture `Content-Encoding` response header
- Return content encoding value along with downloaded file path
- Similar to Android `HttpDownloadService.kt:69`

#### 2. Create iOS Decompression Service
**New file to create:**
- `packages/react-native/ios/HotUpdater/Internal/UniversalDecompressionService.swift`

**Requirements:**
- Protocol: `DecompressionService`
  - Method: `extract(archivePath: String, destinationPath: String, contentEncoding: String?) throws`
- Implementation: `UniversalDecompressionService`
  - Support ZIP extraction (use existing SSZipArchive)
  - Support TAR+Brotli extraction
  - Support TAR+Gzip extraction

**Dependencies needed:**
Add to `hot-updater.podspec` or iOS project:
- For Brotli: Use existing Brotli framework or add `SwiftNIOBrotli` via SPM
- For TAR: Implement TAR extraction or use a Swift library like `ZIPFoundation` with tar support

**Reference implementation (Swift):**
```swift
protocol DecompressionService {
    func extract(archivePath: String, destinationPath: String, contentEncoding: String?) throws
}

class UniversalDecompressionService: DecompressionService {
    func extract(archivePath: String, destinationPath: String, contentEncoding: String?) throws {
        let encoding = contentEncoding?.lowercased()

        switch encoding {
        case "br", "brotli":
            try extractTarBrotli(archivePath: archivePath, destinationPath: destinationPath)
        case "gzip":
            try extractTarGzip(archivePath: archivePath, destinationPath: destinationPath)
        default:
            // Use existing SSZipArchive for ZIP
            try SSZipArchive.unzipFile(atPath: archivePath, toDestination: destinationPath)
        }
    }

    private func extractTarBrotli(archivePath: String, destinationPath: String) throws {
        // TODO: Implement Brotli decompression + TAR extraction
    }

    private func extractTarGzip(archivePath: String, destinationPath: String) throws {
        // TODO: Implement Gzip decompression + TAR extraction
    }
}
```

#### 3. Update iOS BundleFileStorageService
**Files to modify:**
- `packages/react-native/ios/HotUpdater/Internal/BundleFileStorageService.swift` (or equivalent)

**Changes needed:**
- Replace `SSZipArchiveUnzipService` with `UniversalDecompressionService`
- Pass contentEncoding from download result to decompression service
- Similar to Android `BundleFileStorageService.kt:162-173`

#### 4. Add iOS Dependencies
**File to modify:**
- `packages/react-native/hot-updater.podspec` or Xcode project settings

**Dependencies to add:**
```ruby
# For Brotli support
spec.dependency 'Brotli', '~> 0.1' # Or use SwiftNIOBrotli

# For TAR support (if needed)
# May need to implement custom TAR extraction or find suitable library
```

#### 5. Testing
- Test ZIP decompression (backward compatibility)
- Test TAR+Brotli decompression
- Test TAR+Gzip decompression
- Verify Content-Encoding header is properly captured from all storage backends
- Test with actual React Native bundle deployment

## Implementation Priority

1. **High Priority**: Update download service to capture Content-Encoding
2. **High Priority**: Implement UniversalDecompressionService with ZIP support (maintains backward compatibility)
3. **Medium Priority**: Add TAR+Gzip support (widely supported compression)
4. **Medium Priority**: Add TAR+Brotli support (best compression ratio)
5. **Low Priority**: Update podspec dependencies

## Notes

- The Android implementation is complete and can serve as a reference
- Maintain backward compatibility with existing ZIP-only bundles
- Content-Encoding should default to "identity" or null for ZIP files
- Consider using native iOS compression APIs where possible to minimize dependencies
- SSZipArchive can continue to be used for ZIP extraction

## Testing Plan

1. Deploy a bundle with `compressionStrategy: "zip"` - should work with existing logic
2. Deploy a bundle with `compressionStrategy: "tarGzip"` - verify download and extraction
3. Deploy a bundle with `compressionStrategy: "tarBrotli"` - verify download and extraction
4. Test on both iOS simulator and physical device
5. Verify bundle loads correctly after decompression
6. Check file sizes to confirm compression is working

## References

- Android implementation: `packages/react-native/android/src/main/java/com/hotupdater/DecompressionService.kt`
- Plugin-core compression: `plugins/plugin-core/src/compression.ts`
- Deploy command: `packages/hot-updater/src/commands/deploy.ts`
