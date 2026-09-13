# Native source adaptation

The Android integration adapts selected MIT-licensed Hot Updater native file
processing from repository commit `17d1030a17217e4494006b72d4c1dd9b4bdf95c5`.
Original source paths are
`packages/react-native/android/src/main/java/com/hotupdater/<file>`.
The package includes the repository license at `../LICENSE`. Existing React
Native sources, native setup and dependencies remain unchanged.

| Original source | Original SHA-256 |
| --- | --- |
| `HashUtils.kt` | `dbf0ca316399df473d444d54ce6203665ba3c56564ccc2448c2068a59d70e970` |
| `TarArchiveInputStream.kt` | `49bfcf3433a782d325053fae5f62491e1fed48b15f0c561d7a7009dbaddfd181` |
| `RelativePathResolver.kt` | `bdb6cc2edfd7d1442113a26eb209728321c57c6df7a0cf874c612f7d0a0897de` |
| `SignatureVerifier.kt` | `20d49d23ee5d1996301ecea398ce5708f07e9dfc71e82939254a9881ee7d20cd` |
| `ZipDecompressionStrategy.kt` | `e5f04d18a5665a5d1d892b4967a3dc09bec43c6117610ff4fc918d98fecc9824` |

`HashUtils` and `TarArchiveInputStream` are adapted under
`com.hotupdater.lynx.internal`. The strict archive/path implementation and
`ArchiveIntegrity` preserve the relevant original extraction and signature
semantics while using native Lynx configuration explicitly. RSA-SHA256 verifies
the SHA-256 digest bytes, matching the existing CLI wire format. Native manifest,
entry and compatibility admission, immutable installation publication, catalog
policy, process selection and context-bound readiness belong to the Lynx layer.
These additions do not inherit React Native's entry discovery or lifecycle hooks.

The decoder JAR is separately relocated to
`com.hotupdater.lynx.vendor.brotli.dec`. Its upstream license remains inside
`META-INF/LICENSE`; hashes and reproduction instructions are in
[libs/README.md](./libs/README.md). Independent inspection found 15 classes in
each RN and Lynx decoder JAR and no shared class names. Class inventory separation
alone does not prove a complete mixed-host build.

The original file hashes identify the review baseline. Future upstream security
or extraction changes require an explicit comparison with these adapted files
and focused native regression checks. This bounded duplication avoids imposing
a new native-module installation step on existing React Native consumers.
