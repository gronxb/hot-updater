# Native source adaptation

This provisional iOS package adapts the MIT-licensed Hot Updater native archive
and integrity implementation from repository commit `17d1030a17217e4494006b72d4c1dd9b4bdf95c5`.
The canonical upstream paths at that revision are
`packages/react-native/ios/HotUpdater/Internal/<file>`.
React Native source files, package dependencies and CocoaPods setup remain unchanged.

| Source file | Original SHA-256 |
| --- | --- |
| `ArchiveExtractionUtilities.swift` | `0ae7ab37115852d29fafe16a15f49424d2c341b8b10e61714ead13d5132ece57` |
| `DecompressService.swift` | `0d00646c12375de485ccd8dd6fee634c9ff9e4e4be435a170e6c917969ba6dd7` |
| `DecompressionStrategy.swift` | `e9227f2461c6010d6434803af0502080c7acb30eff794c8c905e4037c8475d50` |
| `HashUtils.swift` | `3f5a9e4b493f778137606e50ce6ccf5b7c8f4cf7bb31226c4d5a86f802e39f8e` |
| `StreamingTarArchiveExtractor.swift` | `4598d69d9d0d251cb679f6d4402c5ca67af9f28b4ce71ff9ce9998c73534e516` |
| `TarArchiveExtractor.swift` | `dbad88e282069a42c00fd5a270d34bb14fd71ca26ff816bbe17ab36a4befad4a` |
| `TarBrDecompressionStrategy.swift` | `5f060bee691edca5a037b65ec1e849658c6f8cf7ef17e9c3b3acc038643e1e01` |
| `TarGzDecompressionStrategy.swift` | `f3ff0ce4211b4922f0cbb2b574aef8dd6e77493df79c69c35ba7579c8ff72a6b` |
| `ZipArchiveExtractor.swift` | `594b3f5f3690e17b1bb24434f0dcc8456ec65d1734db7a0490314f829e3dd1f8` |
| `ZipDecompressionStrategy.swift` | `8e1043ddc18d9fb5bd3fe4cbcf5a66c9af608468cb083669e0fcde5d8faaacfe` |
| `SignatureVerifier.swift` | `43b6cc8ef639cdf3e4ab22e45b303c422b9b1274fe98d8f2255565c0eb256003` |
| `BsdiffPatchBridge.mm` | `8e544d41c02917cd1daf90e349d3c01c1b0140e6d3611f140fc653b90d2c1077` |

The copied cryptographic implementation is named `ArtifactSignatureVerifier` and
receives an immutable native configuration key explicitly. Its RSA-SHA256 wire
semantics remain unchanged. React Native's Info.plist/config lookup is excluded.
Archive extraction gains a strict mode used by `LynxArtifactInstaller`: invalid
paths, links, duplicates, case aliases, local/central ZIP mismatches and unsupported
TAR types reject the entire preparation. Entry count and expanded byte limits
prevent unlimited extraction. ZIP output is checked while inflating; compressed
TAR output is bounded before extraction. The original permissive mode remains
available internally for comparison, but the installer always uses strict mode.

`URLSessionDownloadService` was not copied: it owns React Native/global background
session and persistent download state. `ArtifactDownload` instead gives each
preparation one ephemeral session, private destination, response-length/size
checks and cancellation. It has no global download-state file.

The BSDIFF bridge is compiled in a Lynx-only target and retains the
`ENDSLEY/BSDIFF43` wire format. The adaptation adds regular-file checks, checked
integer and output bounds, rejection of trailing patch content, and atomic
temporary output. It does not depend on React Native headers or configuration.

Preparation is not catalog authorization. Immutable publication occurs only when
the native finalization owner invokes a synchronous publish closure while retaining
its authorization/state lock. The package does not silently activate a download.
An interrupted preparation remains outside the published bundles directory.
A process lease prevents a second live store owner from deleting active staging;
on a later owner start, unpublished orphan staging is reclaimed.

Every archive must pass its configured signature/hash policy. A supplied manifest
token passes that same policy; configured signing rejects an unsigned supplied
token. A null manifest token is supported because the mandatory verified archive
binds its manifest bytes. Manifest asset SHA-256 fields always match; when a key
is configured, each asset's separate `signature` field must also verify. No
computed manifest digest is substituted as server authorization. The native
committed receipt may retain that digest to revalidate its already verified tree.

This controlled adaptation avoids imposing a new native-core CocoaPod migration
on existing React Native applications. Future changes to the upstream leaves
require review against these recorded source hashes and native regression tests.

The strict profile bounds compressed archives to 512 MiB, expanded payloads to
1 GiB, entries to 10,000, and entry names to 1,024 UTF-8 bytes. ZIP count and name
limits apply before collecting directory strings. TAR PAX records use checked
length/range validation and reject malformed or duplicate records. Manifest JSON
is bounded to 16 MiB and the Lynx sidecar to 16 KiB before reading into memory;
both reject duplicate object keys and nesting beyond 32 levels. The manifest
budget accommodates 10,000 bounded paths with hashes/signatures while remaining
independent of the much larger opaque payload budget. iOS platform identity is
fixed by native code; blank native runtime profiles reject store initialization.
