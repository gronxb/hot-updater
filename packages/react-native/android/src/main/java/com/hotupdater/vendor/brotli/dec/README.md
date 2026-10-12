# Vendored Brotli decoder

These files are the Java Brotli decoder from
[google/brotli v1.2.0](https://github.com/google/brotli/tree/v1.2.0/java/org/brotli/dec)
(commit [028fb5a](https://github.com/google/brotli/commit/028fb5a23661f123017c060daa546b55cf4bde29)),
under its MIT license in [LICENSE](LICENSE).

**Why vendored:** the official `org.brotli:dec` package on Maven Central is
stuck at v0.1.2 (May 2017), which has known vulnerabilities. v1.2.0 fixes them:

- CVE-2020-8927: buffer overflow in Brotli versions before 1.0.8
- CVE-2025-6176: denial of service in versions up to 1.1.0

**Why sources, not a jar:** the decoder compiles into Hot Updater's own classes.
Tools that merge a React Native app and its native modules into one AAR, such as
React Native Brownfield's Gradle plugin, keep each module's classes but drop the
jars a module depends on through `files(...)`.

**Changes from upstream:** only the package. `package org.brotli.dec;` and
`import static org.brotli.dec.` became `com.hotupdater.vendor.brotli.dec`, so
Hot Updater's decoder never clashes with an app's own `org.brotli:dec`. The
test files, `BUILD.bazel`, `pom.xml`, and the Kotlin port are not included.

`proguard-rules.pro` keeps `com.hotupdater.vendor.brotli.**`: `Dictionary` loads
`DictionaryData` by name.

**Update:** copy the non-test `java/org/brotli/dec/*.java` files of the new
release, rewrite the package lines as above, and update the version, commit,
and CVE notes here.

```bash
git clone --depth 1 --branch <tag> https://github.com/google/brotli.git
for f in brotli/java/org/brotli/dec/*.java; do
  case "$f" in *Test.java|*TestUtils.java) continue ;; esac
  sed -e 's/^package org\.brotli\.dec;/package com.hotupdater.vendor.brotli.dec;/' \
    -e 's/^import static org\.brotli\.dec\./import static com.hotupdater.vendor.brotli.dec./' \
    "$f" > "$(basename "$f")"
done
```
