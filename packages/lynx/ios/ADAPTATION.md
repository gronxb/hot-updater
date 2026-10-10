# Native source adaptation

This provisional iOS package adapts the MIT-licensed Hot Updater native archive
and integrity implementation from repository commit `17d1030a17217e4494006b72d4c1dd9b4bdf95c5`.
The canonical upstream paths at that revision are
`packages/react-native/ios/HotUpdater/Internal/<file>`.
React Native source files, package dependencies and CocoaPods setup remain unchanged.

| Source file | Original SHA-256 |
| --- | --- |
| `ArchiveExtractionUtilities.swift` | `0ae7ab37115852d29fafe16a15f49424d2c341b8b10e61714ead13d5132ece57` |
| `HashUtils.swift` | `3f5a9e4b493f778137606e50ce6ccf5b7c8f4cf7bb31226c4d5a86f802e39f8e` |
| `StreamingTarArchiveExtractor.swift` | `4598d69d9d0d251cb679f6d4402c5ca67af9f28b4ce71ff9ce9998c73534e516` |
| `TarArchiveExtractor.swift` | `dbad88e282069a42c00fd5a270d34bb14fd71ca26ff816bbe17ab36a4befad4a` |
| `SignatureVerifier.swift` | `43b6cc8ef639cdf3e4ab22e45b303c422b9b1274fe98d8f2255565c0eb256003` |
| `BsdiffPatchBridge.mm` | `8e544d41c02917cd1daf90e349d3c01c1b0140e6d3611f140fc653b90d2c1077` |

The copied cryptographic implementation is named `ArtifactSignatureVerifier` and
receives an immutable native configuration key explicitly. Its RSA-SHA256 wire
semantics remain unchanged. React Native's Info.plist/config lookup is excluded.
Archive extraction gains a strict mode used by `LynxArtifactInstaller`: invalid
paths, links, duplicates, case aliases and unsupported TAR types reject bulk
extraction. Entry count and expanded byte limits prevent unlimited extraction.
Brotli output is bounded before TAR extraction. The installer requires the
authenticated decoded size and exact file inventory; it does not detect formats
from archive bytes. If optional bulk transfer fails, manifest-v1 may install
verified original files instead. The copied ZIP/GZIP paths are not shipped.

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

Manifest-v1 delivery requires a manifest URL, a signature/hash token, and a
complete original asset map. Configured signing rejects an unsigned manifest
token. Optional bulk TAR.BR transport is bound by the authenticated manifest's
compressed hash, compressed size, decoded TAR size and exact asset inventory.
Manifest asset SHA-256 fields always match; when a key is configured, each
asset's separate `signature` field must also verify. No computed manifest digest
is substituted as server authorization. The native committed receipt may retain
that digest to revalidate its already verified tree.

This controlled adaptation avoids imposing a new native-core CocoaPod migration
on existing React Native applications. Future changes to the upstream leaves
require review against these recorded source hashes and native regression tests.

The strict profile bounds compressed archives and each managed file to 128 MiB,
expanded payloads to 512 MiB, entries to 10,000, and entry names to 1,024 UTF-8
bytes. Manifest JSON is bounded to 1 MiB and the Lynx sidecar to 16 KiB before
reading into memory; both reject duplicate object keys and nesting beyond 32
levels. Native bulk extraction checks exact manifest membership and logical
sizes before writing. TAR framing, checksums, padding and local PAX records are
validated; links and unsupported metadata reject the artifact. iOS platform
identity is fixed by native code; blank runtime profiles reject initialization.
TAR numeric fields accept unsigned octal only, matching the current React Native
extractor; binary and signed encodings reject before writing a file.

The unused copied automatic-format service, strategy wrappers and format-sniffing
helpers are not shipped. The installer uses the strict extractors directly.
This cleanup does not remove the remaining archive implementation duplication
or establish complete mixed-host or device acceptance.
