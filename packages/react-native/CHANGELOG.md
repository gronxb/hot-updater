# @hot-updater/react-native

## 0.31.2

### Patch Changes

- @hot-updater/cli-tools@0.31.2
- @hot-updater/core@0.31.2
- @hot-updater/js@0.31.2
- @hot-updater/plugin-core@0.31.2

## 0.31.1

### Patch Changes

- @hot-updater/cli-tools@0.31.1
- @hot-updater/core@0.31.1
- @hot-updater/js@0.31.1
- @hot-updater/plugin-core@0.31.1

## 0.31.0

### Minor Changes

- 5b0a0f5: Add signed manifest-based diff update support across deploy, server, provider storage, console tooling, and React Native runtime.
- 5b0a0f5: Add Hermes bundle patch metadata and runtime BSDIFF patch application support.

### Patch Changes

- e975b3f: chore(react-native): deprecated wrap updateMode
- 5b0a0f5: feat: add internal files directory retrieval in FileManagerService
- Updated dependencies [5b0a0f5]
- Updated dependencies [5b0a0f5]
  - @hot-updater/core@0.31.0
  - @hot-updater/cli-tools@0.31.0
  - @hot-updater/js@0.31.0
  - @hot-updater/plugin-core@0.31.0

## 0.30.12

### Patch Changes

- 1498fe3: feat(react-native): support dynamic `baseURL` resolvers for `HotUpdater.init`
  and `HotUpdater.wrap`

  `baseURL` can now be a string or a function returning a string or promise. The
  default resolver calls the function before each update check so apps can resolve
  the update server URL at runtime.

  - @hot-updater/cli-tools@0.30.12
  - @hot-updater/core@0.30.12
  - @hot-updater/js@0.30.12
  - @hot-updater/plugin-core@0.30.12

## 0.30.11

### Patch Changes

- @hot-updater/cli-tools@0.30.11
- @hot-updater/core@0.30.11
- @hot-updater/js@0.30.11
- @hot-updater/plugin-core@0.30.11

## 0.30.10

### Patch Changes

- @hot-updater/cli-tools@0.30.10
- @hot-updater/core@0.30.10
- @hot-updater/js@0.30.10
- @hot-updater/plugin-core@0.30.10

## 0.30.9

### Patch Changes

- e10d15f: fix(react-native): HotUpdater.init type
  - @hot-updater/cli-tools@0.30.9
  - @hot-updater/core@0.30.9
  - @hot-updater/js@0.30.9
  - @hot-updater/plugin-core@0.30.9

## 0.30.8

### Patch Changes

- Updated dependencies [6019156]
  - @hot-updater/cli-tools@0.30.8
  - @hot-updater/plugin-core@0.30.8
  - @hot-updater/core@0.30.8
  - @hot-updater/js@0.30.8

## 0.30.7

### Patch Changes

- f22ab70: Prevent duplicate progress events from notifying the React Native store when
  the computed update state has not changed.
- 03fd179: Run the `hot-updater` CLI from native ESM on Node 20 so TypeScript config
  files load through ESM import conditions.

  Require Node.js 20.19.0 or newer for the CLI package surface.

  Run the `hot-updater` CLI bin from the native ESM entrypoint and stop emitting
  a CommonJS build for the CLI entry.

  Bump the `hot-updater` CLI package's vulnerable `kysely` and
  `fast-xml-parser` dependency entries to patched versions without pnpm
  overrides.

- Updated dependencies [03fd179]
  - @hot-updater/cli-tools@0.30.7
  - @hot-updater/core@0.30.7
  - @hot-updater/js@0.30.7
  - @hot-updater/plugin-core@0.30.7

## 0.30.6

### Patch Changes

- @hot-updater/cli-tools@0.30.6
- @hot-updater/core@0.30.6
- @hot-updater/js@0.30.6
- @hot-updater/plugin-core@0.30.6

## 0.30.5

### Patch Changes

- 6e2892f: fix(android): export resetChannel in old arch
  - @hot-updater/cli-tools@0.30.5
  - @hot-updater/core@0.30.5
  - @hot-updater/js@0.30.5
  - @hot-updater/plugin-core@0.30.5

## 0.30.4

### Patch Changes

- b2db3ca: fix(react-native): always delegate resetChannel to native
  - @hot-updater/cli-tools@0.30.4
  - @hot-updater/core@0.30.4
  - @hot-updater/js@0.30.4
  - @hot-updater/plugin-core@0.30.4

## 0.30.3

### Patch Changes

- 2f32e43: feat: add internal files directory retrieval in FileManagerService
  - @hot-updater/cli-tools@0.30.3
  - @hot-updater/core@0.30.3
  - @hot-updater/js@0.30.3
  - @hot-updater/plugin-core@0.30.3

## 0.30.2

### Patch Changes

- 763d2b2: fix(native): launched bundle identity reporting
  - @hot-updater/cli-tools@0.30.2
  - @hot-updater/core@0.30.2
  - @hot-updater/js@0.30.2
  - @hot-updater/plugin-core@0.30.2

## 0.30.1

### Patch Changes

- @hot-updater/cli-tools@0.30.1
- @hot-updater/core@0.30.1
- @hot-updater/js@0.30.1
- @hot-updater/plugin-core@0.30.1

## 0.30.0

### Minor Changes

- 83c01c8: fix: keep target cohorts additive to rollout

### Patch Changes

- Updated dependencies [83c01c8]
  - @hot-updater/core@0.30.0
  - @hot-updater/cli-tools@0.30.0
  - @hot-updater/js@0.30.0
  - @hot-updater/plugin-core@0.30.0

## 0.29.8

### Patch Changes

- @hot-updater/cli-tools@0.29.8
- @hot-updater/core@0.29.8
- @hot-updater/js@0.29.8
- @hot-updater/plugin-core@0.29.8

## 0.29.7

### Patch Changes

- 8301941: fix(android): handle downloads without content length
  - @hot-updater/cli-tools@0.29.7
  - @hot-updater/core@0.29.7
  - @hot-updater/js@0.29.7
  - @hot-updater/plugin-core@0.29.7

## 0.29.6

### Patch Changes

- Updated dependencies [80cce61]
  - @hot-updater/cli-tools@0.29.6
  - @hot-updater/core@0.29.6
  - @hot-updater/js@0.29.6
  - @hot-updater/plugin-core@0.29.6

## 0.29.5

### Patch Changes

- b653286: fix(ios): avoid false invalid zip errors during bundle extraction
- Updated dependencies [52208f4]
  - @hot-updater/plugin-core@0.29.5
  - @hot-updater/cli-tools@0.29.5
  - @hot-updater/core@0.29.5
  - @hot-updater/js@0.29.5

## 0.29.4

### Patch Changes

- aa96e1a: fix(android): oldarch sync methods crash with WritableNativeMap/Array return types
  - @hot-updater/cli-tools@0.29.4
  - @hot-updater/core@0.29.4
  - @hot-updater/js@0.29.4
  - @hot-updater/plugin-core@0.29.4

## 0.29.3

### Patch Changes

- b4b2078: fix(ios): improve archive validation and download persistence
- b4b2078: fix(react-native): stream ios bundle extraction work after download
- Updated dependencies [d1ffb83]
  - @hot-updater/plugin-core@0.29.3
  - @hot-updater/cli-tools@0.29.3
  - @hot-updater/core@0.29.3
  - @hot-updater/js@0.29.3

## 0.29.2

### Patch Changes

- Updated dependencies [2a1bc80]
  - @hot-updater/cli-tools@0.29.2
  - @hot-updater/core@0.29.2
  - @hot-updater/js@0.29.2
  - @hot-updater/plugin-core@0.29.2

## 0.29.1

### Patch Changes

- @hot-updater/cli-tools@0.29.1
- @hot-updater/core@0.29.1
- @hot-updater/js@0.29.1
- @hot-updater/plugin-core@0.29.1

## 0.29.0

### Minor Changes

- a935992: feat: Rollout feature with control from 1% to 100%

### Patch Changes

- d0fe908: fix(console): rebuild copied bundles with fresh uuidv7 ids
- Updated dependencies [a935992]
- Updated dependencies [d0fe908]
  - @hot-updater/plugin-core@0.29.0
  - @hot-updater/cli-tools@0.29.0
  - @hot-updater/core@0.29.0
  - @hot-updater/js@0.29.0

## 0.28.0

### Minor Changes

- 09e3217: fix(react-native): improve rollback recovery

### Patch Changes

- @hot-updater/cli-tools@0.28.0
- @hot-updater/core@0.28.0
- @hot-updater/js@0.28.0
- @hot-updater/plugin-core@0.28.0

## 0.27.1

### Patch Changes

- @hot-updater/cli-tools@0.27.1
- @hot-updater/core@0.27.1
- @hot-updater/js@0.27.1
- @hot-updater/plugin-core@0.27.1

## 0.27.0

### Minor Changes

- 81f9437: feat(android): for safe reloading, Android reloads the process (#869)

### Patch Changes

- Updated dependencies [81f9437]
  - @hot-updater/cli-tools@0.27.0
  - @hot-updater/core@0.27.0
  - @hot-updater/js@0.27.0
  - @hot-updater/plugin-core@0.27.0

## 0.26.2

### Patch Changes

- @hot-updater/cli-tools@0.26.2
- @hot-updater/core@0.26.2
- @hot-updater/js@0.26.2
- @hot-updater/plugin-core@0.26.2

## 0.26.1

### Patch Changes

- 041236c: fix(android): use \_jsBundleLoader backing field for Expo SDK 55+ compatibility
  - @hot-updater/cli-tools@0.26.1
  - @hot-updater/core@0.26.1
  - @hot-updater/js@0.26.1
  - @hot-updater/plugin-core@0.26.1

## 0.26.0

### Minor Changes

- c43a01d: feat(react-native): runtime channel switch

### Patch Changes

- @hot-updater/cli-tools@0.26.0
- @hot-updater/core@0.26.0
- @hot-updater/js@0.26.0
- @hot-updater/plugin-core@0.26.0

## 0.25.14

### Patch Changes

- @hot-updater/cli-tools@0.25.14
- @hot-updater/core@0.25.14
- @hot-updater/js@0.25.14
- @hot-updater/plugin-core@0.25.14

## 0.25.13

### Patch Changes

- @hot-updater/cli-tools@0.25.13
- @hot-updater/core@0.25.13
- @hot-updater/js@0.25.13
- @hot-updater/plugin-core@0.25.13

## 0.25.12

### Patch Changes

- @hot-updater/cli-tools@0.25.12
- @hot-updater/core@0.25.12
- @hot-updater/js@0.25.12
- @hot-updater/plugin-core@0.25.12

## 0.25.11

### Patch Changes

- 70f3057: Add namespace fallback for string resource lookup
  - @hot-updater/cli-tools@0.25.11
  - @hot-updater/core@0.25.11
  - @hot-updater/js@0.25.11
  - @hot-updater/plugin-core@0.25.11

## 0.25.10

### Patch Changes

- Updated dependencies [90f9610]
- Updated dependencies [03c5adc]
  - @hot-updater/cli-tools@0.25.10
  - @hot-updater/plugin-core@0.25.10
  - @hot-updater/core@0.25.10
  - @hot-updater/js@0.25.10

## 0.25.9

### Patch Changes

- bd288a8: fix(android): brotil embed android for vulnerability
- Updated dependencies [6b22072]
  - @hot-updater/plugin-core@0.25.9
  - @hot-updater/cli-tools@0.25.9
  - @hot-updater/core@0.25.9
  - @hot-updater/js@0.25.9

## 0.25.8

### Patch Changes

- e7d3ffc: Add `bundle` parameter for XCFramework brownfield support on iOS
  - @hot-updater/cli-tools@0.25.8
  - @hot-updater/core@0.25.8
  - @hot-updater/js@0.25.8
  - @hot-updater/plugin-core@0.25.8

## 0.25.7

### Patch Changes

- 2922917: fix(iOS): Download progress percentage not displayed on iOS during OTA updates
- 17bc46a: feat(react-native): add brownfield support via HotUpdater.setReactHost()
  - @hot-updater/cli-tools@0.25.7
  - @hot-updater/core@0.25.7
  - @hot-updater/js@0.25.7
  - @hot-updater/plugin-core@0.25.7

## 0.25.6

### Patch Changes

- @hot-updater/cli-tools@0.25.6
- @hot-updater/core@0.25.6
- @hot-updater/js@0.25.6
- @hot-updater/plugin-core@0.25.6

## 0.25.5

### Patch Changes

- @hot-updater/cli-tools@0.25.5
- @hot-updater/core@0.25.5
- @hot-updater/js@0.25.5
- @hot-updater/plugin-core@0.25.5

## 0.25.4

### Patch Changes

- Updated dependencies [8c83ff2]
  - @hot-updater/cli-tools@0.25.4
  - @hot-updater/core@0.25.4
  - @hot-updater/js@0.25.4
  - @hot-updater/plugin-core@0.25.4

## 0.25.3

### Patch Changes

- @hot-updater/cli-tools@0.25.3
- @hot-updater/core@0.25.3
- @hot-updater/js@0.25.3
- @hot-updater/plugin-core@0.25.3

## 0.25.2

### Patch Changes

- 2c22c41: feat(expo): support bundle signing for eas build
  - @hot-updater/cli-tools@0.25.2
  - @hot-updater/core@0.25.2
  - @hot-updater/js@0.25.2
  - @hot-updater/plugin-core@0.25.2

## 0.25.1

### Patch Changes

- 820c276: fix(native): without request HEAD
  - @hot-updater/cli-tools@0.25.1
  - @hot-updater/core@0.25.1
  - @hot-updater/js@0.25.1
  - @hot-updater/plugin-core@0.25.1

## 0.25.0

### Minor Changes

- d22b48a: feat(expo): expo 'use dom' correct ota update

### Patch Changes

- @hot-updater/cli-tools@0.25.0
- @hot-updater/core@0.25.0
- @hot-updater/js@0.25.0
- @hot-updater/plugin-core@0.25.0

## 0.24.7

### Patch Changes

- 294e324: fix: update babel plugin path in documentation and plugin files
- Updated dependencies [294e324]
  - @hot-updater/cli-tools@0.24.7
  - @hot-updater/core@0.24.7
  - @hot-updater/js@0.24.7
  - @hot-updater/plugin-core@0.24.7

## 0.24.6

### Patch Changes

- Updated dependencies [9d7b6af]
  - @hot-updater/cli-tools@0.24.6
  - @hot-updater/core@0.24.6
  - @hot-updater/js@0.24.6
  - @hot-updater/plugin-core@0.24.6

## 0.24.5

### Patch Changes

- 93d3372: Use cachesDirectory on tvOS
  - @hot-updater/cli-tools@0.24.5
  - @hot-updater/core@0.24.5
  - @hot-updater/js@0.24.5
  - @hot-updater/plugin-core@0.24.5

## 0.24.4

### Patch Changes

- Updated dependencies [7ed539f]
  - @hot-updater/plugin-core@0.24.4
  - @hot-updater/cli-tools@0.24.4
  - @hot-updater/core@0.24.4
  - @hot-updater/js@0.24.4

## 0.24.3

### Patch Changes

- bbe71f7: Add tvOS support to HotUpdater
  - @hot-updater/cli-tools@0.24.3
  - @hot-updater/core@0.24.3
  - @hot-updater/js@0.24.3
  - @hot-updater/plugin-core@0.24.3

## 0.24.2

### Patch Changes

- 5a46549: fix(native): background update
  - @hot-updater/cli-tools@0.24.2
  - @hot-updater/core@0.24.2
  - @hot-updater/js@0.24.2
  - @hot-updater/plugin-core@0.24.2

## 0.24.1

### Patch Changes

- fe78d4f: feat(react-native): wrap with resolver
  - @hot-updater/cli-tools@0.24.1
  - @hot-updater/core@0.24.1
  - @hot-updater/js@0.24.1
  - @hot-updater/plugin-core@0.24.1

## 0.24.0

### Minor Changes

- 753208b: feat(native): notifyAppReady for auto rollback (invalid bundle)
- c51239c: fix(ios): getMinBundleId timezone issue

### Patch Changes

- @hot-updater/cli-tools@0.24.0
- @hot-updater/core@0.24.0
- @hot-updater/js@0.24.0
- @hot-updater/plugin-core@0.24.0

## 0.23.1

### Patch Changes

- 7fa9a20: feat(expo): bundle-signing supports cng plugin
  - @hot-updater/cli-tools@0.23.1
  - @hot-updater/core@0.23.1
  - @hot-updater/js@0.23.1
  - @hot-updater/plugin-core@0.23.1

## 0.23.0

### Minor Changes

- e41fb6b: feat: add bundle signing for cryptographic OTA verification

### Patch Changes

- Updated dependencies [e41fb6b]
  - @hot-updater/core@0.23.0
  - @hot-updater/js@0.23.0
  - @hot-updater/plugin-core@0.23.0
  - @hot-updater/cli-tools@0.23.0

## 0.22.2

### Patch Changes

- 82636ea: fix(expo): expo plugin transformer not found
  - hot-updater@0.22.2
  - @hot-updater/cli-tools@0.22.2
  - @hot-updater/core@0.22.2
  - @hot-updater/js@0.22.2
  - @hot-updater/plugin-core@0.22.2

## 0.22.1

### Patch Changes

- hot-updater@0.22.1
- @hot-updater/cli-tools@0.22.1
- @hot-updater/core@0.22.1
- @hot-updater/js@0.22.1
- @hot-updater/plugin-core@0.22.1

## 0.22.0

### Patch Changes

- hot-updater@0.22.0
- @hot-updater/cli-tools@0.22.0
- @hot-updater/core@0.22.0
- @hot-updater/js@0.22.0
- @hot-updater/plugin-core@0.22.0

## 0.21.15

### Patch Changes

- @hot-updater/cli-tools@0.21.15
- hot-updater@0.21.15
- @hot-updater/js@0.21.15
- @hot-updater/plugin-core@0.21.15
- @hot-updater/core@0.21.15

## 0.21.14

### Patch Changes

- 0b0152a: fix(ios): implement CustomNSError protocol for better error reporting…
  - hot-updater@0.21.14
  - @hot-updater/cli-tools@0.21.14
  - @hot-updater/core@0.21.14
  - @hot-updater/js@0.21.14
  - @hot-updater/plugin-core@0.21.14

## 0.21.13

### Patch Changes

- a6bda2b: refactor(expo): supports testcase RN82
- Updated dependencies [44f4e95]
  - hot-updater@0.21.13
  - @hot-updater/cli-tools@0.21.13
  - @hot-updater/core@0.21.13
  - @hot-updater/js@0.21.13
  - @hot-updater/plugin-core@0.21.13

## 0.21.12

### Patch Changes

- Updated dependencies [56e849b]
- Updated dependencies [5c4b98e]
  - hot-updater@0.21.12
  - @hot-updater/plugin-core@0.21.12
  - @hot-updater/cli-tools@0.21.12
  - @hot-updater/core@0.21.12
  - @hot-updater/js@0.21.12

## 0.21.11

### Patch Changes

- e2b67d7: fix(cli-tools): esm only package bundle
- Updated dependencies [d6c3a65]
- Updated dependencies [e2b67d7]
- Updated dependencies [2905e47]
  - @hot-updater/cli-tools@0.21.11
  - @hot-updater/core@0.21.11
  - hot-updater@0.21.11
  - @hot-updater/js@0.21.11
  - @hot-updater/plugin-core@0.21.11

## 0.21.10

### Patch Changes

- @hot-updater/cli-tools@0.21.10
- hot-updater@0.21.10
- @hot-updater/js@0.21.10
- @hot-updater/plugin-core@0.21.10
- @hot-updater/core@0.21.10

## 0.21.9

### Patch Changes

- Updated dependencies [396ae54]
- Updated dependencies [aa399a6]
  - hot-updater@0.21.9
  - @hot-updater/plugin-core@0.21.9
  - @hot-updater/cli-tools@0.21.9
  - @hot-updater/core@0.21.9
  - @hot-updater/js@0.21.9

## 0.21.8

### Patch Changes

- Updated dependencies [3fe8c81]
  - hot-updater@0.21.8
  - @hot-updater/plugin-core@0.21.8
  - @hot-updater/cli-tools@0.21.8
  - @hot-updater/core@0.21.8
  - @hot-updater/js@0.21.8

## 0.21.7

### Patch Changes

- 2b408f2: docs: revamp hot-updater.dev
- Updated dependencies [2b408f2]
  - @hot-updater/plugin-core@0.21.7
  - hot-updater@0.21.7
  - @hot-updater/core@0.21.7
  - @hot-updater/js@0.21.7

## 0.21.6

### Patch Changes

- 3e9681c: fix(android): Android API 25 compatibility with TarStream
- Updated dependencies [b12394d]
  - hot-updater@0.21.6
  - @hot-updater/core@0.21.6
  - @hot-updater/js@0.21.6
  - @hot-updater/plugin-core@0.21.6

## 0.21.5

### Patch Changes

- Updated dependencies [fc2bd56]
- Updated dependencies [a253498]
  - hot-updater@0.21.5
  - @hot-updater/core@0.21.5
  - @hot-updater/js@0.21.5
  - @hot-updater/plugin-core@0.21.5

## 0.21.4

### Patch Changes

- Updated dependencies [5d3070a]
  - @hot-updater/plugin-core@0.21.4
  - hot-updater@0.21.4
  - @hot-updater/js@0.21.4
  - @hot-updater/core@0.21.4

## 0.21.3

### Patch Changes

- c1125b4: chore(android): bump org.apache.commons:commons-compress:1.28.0
  - hot-updater@0.21.3
  - @hot-updater/core@0.21.3
  - @hot-updater/js@0.21.3
  - @hot-updater/plugin-core@0.21.3

## 0.21.2

### Patch Changes

- hot-updater@0.21.2
- @hot-updater/core@0.21.2
- @hot-updater/js@0.21.2
- @hot-updater/plugin-core@0.21.2

## 0.21.1

### Patch Changes

- Updated dependencies [7b7bc48]
  - @hot-updater/plugin-core@0.21.1
  - hot-updater@0.21.1
  - @hot-updater/core@0.21.1
  - @hot-updater/js@0.21.1

## 0.22.0

### Minor Changes

- 610b2dd: feat: supports `compressStrategy` => `tar.br` (brotli) / `tar.gz` (gzip)
- afb084b: feat: validate bundle file with fileHash

### Patch Changes

- Updated dependencies [610b2dd]
- Updated dependencies [afb084b]
- Updated dependencies [036f8f0]
  - hot-updater@0.22.0
  - @hot-updater/plugin-core@0.22.0
  - @hot-updater/core@0.22.0
  - @hot-updater/js@0.22.0

## 0.20.15

### Patch Changes

- Updated dependencies [526a5ba]
- Updated dependencies [ddf6f2c]
  - @hot-updater/plugin-core@0.20.15
  - hot-updater@0.20.15
  - @hot-updater/core@0.20.15
  - @hot-updater/js@0.20.15

## 0.20.14

### Patch Changes

- Updated dependencies [a61fa0e]
  - @hot-updater/plugin-core@0.20.14
  - hot-updater@0.20.14
  - @hot-updater/core@0.20.14
  - @hot-updater/js@0.20.14

## 0.20.13

### Patch Changes

- 05eeb89: feat(react-native): HotUpdater.isUpdateDownloaded()
  - hot-updater@0.20.13
  - @hot-updater/core@0.20.13
  - @hot-updater/js@0.20.13
  - @hot-updater/plugin-core@0.20.13

## 0.20.12

### Patch Changes

- 26be35b: fix: prevent re-download in js side
- f09a7ce: fix(android): await reload on ReactContextInitialized
  - hot-updater@0.20.12
  - @hot-updater/core@0.20.12
  - @hot-updater/js@0.20.12
  - @hot-updater/plugin-core@0.20.12

## 0.20.11

### Patch Changes

- afb3a6e: fix(fingerprint): separate fingerprint generation for cng
- Updated dependencies [afb3a6e]
- Updated dependencies [cb9c05b]
  - hot-updater@0.20.11
  - @hot-updater/plugin-core@0.20.11
  - @hot-updater/core@0.20.11
  - @hot-updater/js@0.20.11

## 0.20.10

### Patch Changes

- Updated dependencies [6b5435c]
  - hot-updater@0.20.10
  - @hot-updater/core@0.20.10
  - @hot-updater/js@0.20.10
  - @hot-updater/plugin-core@0.20.10

## 0.20.9

### Patch Changes

- a174bc5: Fix native code generation for Android when using Expo 54
  - hot-updater@0.20.9
  - @hot-updater/core@0.20.9
  - @hot-updater/js@0.20.9
  - @hot-updater/plugin-core@0.20.9

## 0.20.8

### Patch Changes

- Updated dependencies [ad7c999]
  - hot-updater@0.20.8
  - @hot-updater/plugin-core@0.20.8
  - @hot-updater/core@0.20.8
  - @hot-updater/js@0.20.8

## 0.20.7

### Patch Changes

- Updated dependencies [a92992c]
  - hot-updater@0.20.7
  - @hot-updater/plugin-core@0.20.7
  - @hot-updater/core@0.20.7
  - @hot-updater/js@0.20.7

## 0.20.6

### Patch Changes

- Updated dependencies [6a905d8]
  - @hot-updater/plugin-core@0.20.6
  - hot-updater@0.20.6
  - @hot-updater/core@0.20.6
  - @hot-updater/js@0.20.6

## 0.20.5

### Patch Changes

- 3383d38: fix(android): fix proguard syntax
  - hot-updater@0.20.5
  - @hot-updater/core@0.20.5
  - @hot-updater/js@0.20.5
  - @hot-updater/plugin-core@0.20.5

## 0.20.4

### Patch Changes

- Updated dependencies [5314b31]
- Updated dependencies [711392b]
  - hot-updater@0.20.4
  - @hot-updater/plugin-core@0.20.4
  - @hot-updater/core@0.20.4
  - @hot-updater/js@0.20.4

## 0.20.3

### Patch Changes

- e63056a: fix(cli): platform parser from hot-updater.config
- Updated dependencies [e63056a]
  - hot-updater@0.20.3
  - @hot-updater/plugin-core@0.20.3
  - @hot-updater/core@0.20.3
  - @hot-updater/js@0.20.3

## 0.20.2

### Patch Changes

- Updated dependencies [0e78fb0]
  - @hot-updater/plugin-core@0.20.2
  - hot-updater@0.20.2
  - @hot-updater/core@0.20.2
  - @hot-updater/js@0.20.2

## 0.20.1

### Patch Changes

- a3a4a28: feat(cli): set stringResourcePaths and infoPlistPaths in hot-updater.config.ts
- Updated dependencies [a3a4a28]
- Updated dependencies [42ff0e1]
  - hot-updater@0.20.1
  - @hot-updater/plugin-core@0.20.1
  - @hot-updater/core@0.20.1
  - @hot-updater/js@0.20.1

## 0.20.0

### Minor Changes

- a0e538c: feat(android): Support 0.81.0

### Patch Changes

- Updated dependencies [bc8e23d]
  - @hot-updater/plugin-core@0.20.0
  - hot-updater@0.20.0
  - @hot-updater/core@0.20.0
  - @hot-updater/js@0.20.0

## 0.19.10

### Patch Changes

- 4be92bd: link
- 8d2d55a: Injectable minimum bundle id for Android
- Updated dependencies [85b236d]
- Updated dependencies [8d2d55a]
- Updated dependencies [2bc52e8]
  - hot-updater@0.19.10
  - @hot-updater/plugin-core@0.19.10
  - @hot-updater/core@0.19.10
  - @hot-updater/js@0.19.10

## 0.19.9

### Patch Changes

- 7ce0af2: Skip fingerprint generation when using appVersion strategy
  - hot-updater@0.19.9
  - @hot-updater/core@0.19.9
  - @hot-updater/js@0.19.9
  - @hot-updater/plugin-core@0.19.9

## 0.19.8

### Patch Changes

- Updated dependencies [4a6a769]
  - hot-updater@0.19.8
  - @hot-updater/core@0.19.8
  - @hot-updater/js@0.19.8

## 0.19.7

### Patch Changes

- Updated dependencies [e28313d]
- Updated dependencies [bcc641e]
  - hot-updater@0.19.7
  - @hot-updater/core@0.19.7
  - @hot-updater/js@0.19.7

## 0.19.6

### Patch Changes

- 657a10e: Android Native Build - Gradle Build
- Updated dependencies [657a10e]
  - hot-updater@0.19.6
  - @hot-updater/core@0.19.6
  - @hot-updater/js@0.19.6

## 0.19.5

### Patch Changes

- 40d28c2: bump rnef
- d3ac760: fix: delete previous bundle when previous bundle access is needed
- Updated dependencies [40d28c2]
  - @hot-updater/core@0.19.5
  - hot-updater@0.19.5
  - @hot-updater/js@0.19.5

## 0.19.4

### Patch Changes

- hot-updater@0.19.4
- @hot-updater/core@0.19.4
- @hot-updater/js@0.19.4

## 0.19.3

### Patch Changes

- Updated dependencies [0c0ab1d]
  - hot-updater@0.19.3
  - @hot-updater/core@0.19.3
  - @hot-updater/js@0.19.3

## 0.19.2

### Patch Changes

- Updated dependencies [6aa6cd7]
  - hot-updater@0.19.2
  - @hot-updater/core@0.19.2
  - @hot-updater/js@0.19.2

## 0.19.1

### Patch Changes

- Updated dependencies [755b9fe]
  - hot-updater@0.19.1
  - @hot-updater/core@0.19.1
  - @hot-updater/js@0.19.1

## 0.19.0

### Minor Changes

- c408819: feat(expo): channel supports expo cng
- 886809d: fix(babel): make sure the backend can handle channel changes for a bundle and still receive updates correctly

### Patch Changes

- Updated dependencies [c408819]
- Updated dependencies [886809d]
  - hot-updater@0.19.0
  - @hot-updater/core@0.19.0
  - @hot-updater/js@0.19.0

## 0.18.5

### Patch Changes

- @hot-updater/core@0.18.5
- @hot-updater/js@0.18.5

## 0.18.4

### Patch Changes

- @hot-updater/core@0.18.4
- @hot-updater/js@0.18.4

## 0.18.3

### Patch Changes

- 34b96c1: fix(native): extracted bundle.zip directly into folder
  - @hot-updater/core@0.18.3
  - @hot-updater/js@0.18.3

## 0.18.2

### Patch Changes

- d8117b9: Stored bundle path should be separated by channel
- e6487bf: Attempt to move file to the same location
  - @hot-updater/core@0.18.2
  - @hot-updater/js@0.18.2

## 0.18.1

### Patch Changes

- 8bf8f8f: rspress 2.0.0 and llms.txt
  - @hot-updater/core@0.18.1
  - @hot-updater/js@0.18.1

## 0.18.0

### Minor Changes

- 73ec434: fingerprint-based update stratgy

### Patch Changes

- Updated dependencies [73ec434]
  - @hot-updater/core@0.18.0
  - @hot-updater/js@0.18.0
