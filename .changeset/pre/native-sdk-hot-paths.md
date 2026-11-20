---
"@hot-updater/react-native": patch
---

**Less SDK work at launch and during installs.** The SDK does less work before your JavaScript runs and during each update check, and Android applies a bsdiff patch about three times as fast. Nothing changes in how you use it.

- iOS, with an update applied: the launch checks the update's files with one `lstat` each, instead of building a full attribute dictionary and two standardized URLs per file.
- The native module's constants are read once per runtime instead of 12–13 times per launch, each time reading the bundle metadata.
- A check that sees the catalog it already stored no longer rewrites the metadata. A key-value store write that changes nothing no longer rewrites and syncs `storage.json`.
- Android applies a bsdiff patch with buffered input and output; before, the bzip2 decoder read the patch file one byte per system call.
- Copying files from the built-in bundle looks up the package and the asset index once, not once per file.
