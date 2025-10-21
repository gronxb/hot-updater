# @hot-updater/plugin-core

## 0.20.15

### Patch Changes

- 526a5ba: fix(aws): normalize targetAppVersion to prevent duplicate S3 paths
- ddf6f2c: Encodes paths before invalidation to handle special chars
  - @hot-updater/core@0.20.15

## 0.20.14

### Patch Changes

- a61fa0e: fix(aws): lambda using cloudfront private key from parameter store
  - @hot-updater/core@0.20.14

## 0.20.13

### Patch Changes

- @hot-updater/core@0.20.13

## 0.20.12

### Patch Changes

- @hot-updater/core@0.20.12

## 0.20.11

### Patch Changes

- cb9c05b: feat(fingerprint): bring back ignorePaths
  - @hot-updater/core@0.20.11

## 0.20.10

### Patch Changes

- @hot-updater/core@0.20.10

## 0.20.9

### Patch Changes

- @hot-updater/core@0.20.9

## 0.20.8

### Patch Changes

- ad7c999: feat(fingerprint): calculate OTA fingerprint only in native module
  - @hot-updater/core@0.20.8

## 0.20.7

### Patch Changes

- a92992c: chore(tsdown): failOnWarn true
- Updated dependencies [a92992c]
  - @hot-updater/core@0.20.7

## 0.20.6

### Patch Changes

- 6a905d8: fix(aws): widen invalidation scope when targetAppVersion covers a broader range
  - @hot-updater/core@0.20.6

## 0.20.5

### Patch Changes

- @hot-updater/core@0.20.5

## 0.20.4

### Patch Changes

- 5314b31: feat(rock): intergration formerly rnef
- 711392b: feat: default updateStrategy is 'appVersion'
  - @hot-updater/core@0.20.4

## 0.20.3

### Patch Changes

- e63056a: fix(cli): platform parser from hot-updater.config
  - @hot-updater/core@0.20.3

## 0.20.2

### Patch Changes

- 0e78fb0: fix(cli): Info.plist correct path
  - @hot-updater/core@0.20.2

## 0.20.1

### Patch Changes

- a3a4a28: feat(cli): set stringResourcePaths and infoPlistPaths in hot-updater.config.ts
  - @hot-updater/core@0.20.1

## 0.20.0

### Minor Changes

- bc8e23d: fix(cli): hot-updater.config.ts required updateStrategy field

### Patch Changes

- @hot-updater/core@0.20.0

## 0.19.10

### Patch Changes

- 2bc52e8: feat(storage): add support for target storage location and return storageUri (v0.18.0+)
  - @hot-updater/core@0.19.10

## 0.19.9

### Patch Changes

- @hot-updater/core@0.19.9

## 0.19.8

### Patch Changes

- @hot-updater/core@0.19.8

## 0.19.7

### Patch Changes

- @hot-updater/core@0.19.7

## 0.19.6

### Patch Changes

- 657a10e: Android Native Build - Gradle Build
  - @hot-updater/core@0.19.6

## 0.19.5

### Patch Changes

- 40d28c2: bump rnef
- Updated dependencies [40d28c2]
  - @hot-updater/core@0.19.5

## 0.19.4

### Patch Changes

- 0ddc955: fix(aws): cloudfront invalidate when update channel
  - @hot-updater/core@0.19.4

## 0.19.3

### Patch Changes

- 0c0ab1d: Add debug option while creating fingerprint
  - @hot-updater/core@0.19.3

## 0.19.2

### Patch Changes

- @hot-updater/core@0.19.2

## 0.19.1

### Patch Changes

- @hot-updater/core@0.19.1

## 0.19.0

### Minor Changes

- 886809d: fix(babel): make sure the backend can handle channel changes for a bundle and still receive updates correctly

### Patch Changes

- @hot-updater/core@0.19.0

## 0.18.5

### Patch Changes

- 494ce31: feat: delete Bundle
  - @hot-updater/core@0.18.5

## 0.18.4

### Patch Changes

- @hot-updater/core@0.18.4

## 0.18.3

### Patch Changes

- @hot-updater/core@0.18.3

## 0.18.2

### Patch Changes

- 437c98e: fix: pagination doesn't work (edit database spec)
  - @hot-updater/core@0.18.2

## 0.18.1

### Patch Changes

- @hot-updater/core@0.18.1

## 0.18.0

### Minor Changes

- 73ec434: fingerprint-based update stratgy

### Patch Changes

- Updated dependencies [73ec434]
  - @hot-updater/core@0.18.0
