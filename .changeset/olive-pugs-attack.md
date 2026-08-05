---
"hot-updater": patch
---

fix: bump the bundled `@bacons/xcode` to 1.0.0-alpha.33

alpha.24 was published in December 2024 and still uses the old Chevrotain-based
pbxproj parser. alpha.31 picked up the single-pass rewrite from
EvanBacon/xcode#37, which is 42x faster on their benchmarks and considerably more
than that on large files.

On a 12.5MB `project.pbxproj`, `XcodeProject.open()` goes from 286s and 1.8GB of
peak RSS down to 0.2s and 285MB, returning the same 48,670 objects. The only API
used here is `XcodeProject.open().toJSON()` in `getIOSVersion`, which is unchanged
between the two versions.
