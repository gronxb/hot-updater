---
"@hot-updater/react-native": patch
"@hot-updater/apple-helper": patch
---

Keep the iOS sandbox layer out of a build that overrides the pod's excluded files.

- An app's own `EXCLUDED_SOURCE_FILE_NAMES` replaced the only thing keeping the layer out, so a plain `xcodebuild` could show the sandbox screen. Its sources now compile to nothing without a condition only Hot Updater's build of a sandbox scheme sets, and it starts only with the `Info.plist` key that build writes
- On Android, a project that gave every library a build type or flavor named `sandbox` compiled the layer in, unused. Those source sets now stay empty
- A scheme's `xcconfig` that sets `SWIFT_ACTIVE_COMPILATION_CONDITIONS` or `GCC_PREPROCESSOR_DEFINITIONS` with a condition such as `[config=Release]` is now refused for a sandbox scheme, since it would outrank the build's own
