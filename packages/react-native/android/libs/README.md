# Bundled Libraries

## hot-updater-brotli-dec-1.2.0.jar

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

The generated jar is then relocated before being bundled:

```gradle
relocate "org.brotli.dec", "com.hotupdater.vendor.brotli.dec"
```

The relocation keeps Hot Updater's security-fixed Brotli decoder isolated from
apps or frameworks that also depend on `org.brotli:dec`.

**Verification:**
- **Original SHA256:** `2d12a2d7fb52fd7f944564fb378aaccd41389cf02ea2e5eb6b3a6477188cced8`
- **Relocated SHA256:** `4e9aee81466e21e365fd291bd29ca0540dc174ce64d29a7613ff336e4276bcdf`
- **Size:** 99KB
- **Built:** 2026-02-12
- **Git Commit:** [028fb5a](https://github.com/google/brotli/commit/028fb5a23661f123017c060daa546b55cf4bde29) (v1.2.0 tag)
- **Relocated Package:** `com.hotupdater.vendor.brotli.dec`

**API Compatibility:**
The v1.2.0 decoder is API compatible with v0.1.2. Hot Updater imports the
relocated package internally, so apps can keep their own `org.brotli:dec`
dependency without duplicate classes:
- Relocated package: `com.hotupdater.vendor.brotli.dec`
- Same class: `BrotliInputStream`
- Same constructor: `BrotliInputStream(InputStream)`

**Why Not Apache Commons Compress?**
Apache Commons Compress depends on `org.brotli:dec:0.1.2` as an optional dependency, so switching to it would not fix the vulnerability—it would just make it transitive.

**Future Updates:**
When Google releases new versions of Brotli (e.g., v1.3.0), rebuild this JAR using the same process, relocate it into the Hot Updater vendor package, and update the SHA256 checksum and build date in this file.
