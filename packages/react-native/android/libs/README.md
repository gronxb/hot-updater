# Bundled Libraries

## org.brotli.dec-1.2.0.jar

**Why bundled:** The official `org.brotli:dec` package on Maven Central is stuck at v0.1.2 (released May 2017) and contains critical security vulnerabilities. Google has not published newer versions to Maven Central despite releasing v1.2.0 with security fixes.

**Source:** Built from [google/brotli v1.2.0](https://github.com/google/brotli/releases/tag/v1.2.0)

**Security Fixes:**
- CVE-2020-8927: Buffer overflow in Brotli versions < 1.0.8
- CVE-2025-6176: DoS vulnerability in versions ≤ 1.1.0 (fixed in v1.2.0)

**Build Command:**
```bash
git clone --depth 1 --branch v1.2.0 https://github.com/google/brotli.git
cd brotli/java/org/brotli/dec
mvn clean package -DskipTests
cp target/org.brotli.dec-1.2.0-SNAPSHOT.jar <destination>/org.brotli.dec-1.2.0.jar
```

**Verification:**
- **SHA256:** `2d12a2d7fb52fd7f944564fb378aaccd41389cf02ea2e5eb6b3a6477188cced8`
- **Size:** 97KB
- **Built:** 2026-02-12
- **Git Commit:** [028fb5a](https://github.com/google/brotli/commit/028fb5a23661f123017c060daa546b55cf4bde29) (v1.2.0 tag)

**API Compatibility:**
The v1.2.0 decoder is 100% API compatible with v0.1.2. No code changes are required:
- Same package: `org.brotli.dec`
- Same class: `BrotliInputStream`
- Same constructor: `BrotliInputStream(InputStream)`

**Why Not Apache Commons Compress?**
Apache Commons Compress depends on `org.brotli:dec:0.1.2` as an optional dependency, so switching to it would not fix the vulnerability—it would just make it transitive.

**Future Updates:**
When Google releases new versions of Brotli (e.g., v1.3.0), rebuild this JAR using the same process and update the SHA256 checksum and build date in this file.
