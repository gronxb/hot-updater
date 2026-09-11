# Native reuse assessment

Status: G1 source assessment. Device feasibility and the public API remain open.

The native adversary reviewed the existing React Native engines and private Lynx
hosts on 2026-09-11. The smallest useful boundary is verified files plus catalog
receipts. Lynx must own entry selection, compatibility, process attempts,
resources and retention. This assessment did not run native tests.

## Reuse candidates

| Responsibility | iOS | Android | Required boundary |
| --- | --- | --- | --- |
| Download | `DownloadService`, `URLSessionDownloadService` | `DownloadService`, `OkHttpDownloadService` | No RN dependency; isolate session IDs and persisted download state |
| Safe extraction | `DecompressService`, ZIP/TAR extractors, `ArchiveExtractionUtilities` | `DecompressService`, ZIP/TAR strategies, `RelativePathResolver` | Preserve existing path/link and compression handling, including Brotli dependencies |
| Hashes and signatures | `HashUtils`, `SignatureVerifier` | `HashUtils`, `SignatureVerifier` | Native configuration owns the trusted public key; preserve unsigned-input rejection when configured |
| Manifest verification | Helpers inside `BundleFileStorageService` | Helpers inside `BundleFileStorageService` | Extract validation without RN entry discovery or activation |
| Catalog caching | `ReleaseCatalogCacheService` | `ReleaseCatalogCacheService` | Cache eviction must not erase durable authority or exclusions |
| Selection authority | High-water/selection metadata and acceptance guards | High-water/selection metadata and acceptance guards | Retain generation/hash/context checks and recheck immediately before commit |

iOS sources are under
[`packages/react-native/ios/HotUpdater/Internal`](../../packages/react-native/ios/HotUpdater/Internal).
Android sources are under
[`packages/react-native/android/src/main/java/com/hotupdater`](../../packages/react-native/android/src/main/java/com/hotupdater).

## Why the existing installer is not the boundary

- Entry discovery assumes RN `.bundle` / `main.jsbundle` conventions instead of
  a verified explicit entry. Multiple Lynx bundles must remain ordinary managed
  files with their original names.
- `BundleFileStorageService` combines file preparation, RN entry discovery,
  staging metadata and cleanup. Lynx admission must happen before publication or
  activation. A partially copied installation must never become visible.
- Cleanup retains a small set of bundle IDs and does not model live Lynx
  contexts or in-flight resource reads. Lynx needs process-pinned retention.
- Android storage reaches into `HotUpdaterImpl` for channel, fingerprint and
  minimum identity; the full Gradle library also depends on React Native.
- RN recovery observes React markers, RCT notifications and React error handlers.
  Those observations cannot confirm or classify a Lynx startup.
- The existing iOS `HotUpdaterArchive` Swift package target excludes the RN entry
  bridge, but its useful types are mostly internal. It is a source boundary,
  not an already consumable generic installation API.

## Proposed implementation sequence after G1

1. Adapt only the required native file-processing leaves inside the Lynx
   native target, with original source provenance and a private Android
   namespace. Prepare verified files without choosing a runtime entry or
   mutating launch state. Keep the full RN library and its app setup unchanged.
2. Let Lynx validate manifest-bound entry/compatibility metadata, current catalog
   authority and exclusions, then publish an immutable installation atomically.
3. Let the host select one release per process and own durable attempt creation,
   attributed confirmation, recovery and resource lifetime.

The exact source/package layout needs implementation review once the native
loader and callback evidence is complete. The private staging provider and local
fixture receipts are test infrastructure; they cannot enter the production
download or authorization path.

## Packaging decision after source review

The native adversary independently inspected locally installed React Native CLI
18.0.0, 19.1.2 and 20.1.0 dependency discovery, Gradle settings autolinking, and
RN 0.79 CocoaPods autolinking. Their input is the application's direct dependency
list plus application configuration. They do not register native modules merely
because another npm dependency requires them transitively.

A separate local `@hot-updater/native-core` Gradle project/Pod would therefore
require setup changes in existing RN applications. Compiling the same Android
classes in both runtime modules would instead create duplicate classes when both
are linked. Generated namespace relocation or publishing Maven/Pod artifacts
would introduce a larger build and release change than this task requires.

The chosen initial boundary keeps RN source and setup intact. Lynx contains only
necessary adapted file-processing sources, their original license/provenance,
and its own native namespaces. Strict extraction changes and existing wire-format
compatibility need scenario tests. This intentionally duplicates a bounded set
of low-level code: fixes must be propagated to both copies. Centralizing the
sources remains a later change that must first demonstrate packaged RN/Lynx
coexistence without app setup regressions.

The installer prepares files under a private path. Its caller must hold the
native authority/state lock across the final catalog/revision/exclusion check,
immutable file publication, and durable next-selection publication. An unlocked
Boolean authorization check followed by rename is insufficient. A crash after
file publication may leave an inert verified orphan; durable state must never
point to partially installed files.
