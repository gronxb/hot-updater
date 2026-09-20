# Manifest transfer evidence

Measured on 2026-09-20 at revision
`38d46c05df90e4f4c93e079d4aedacac9de0a111`.

## Result

For the 18-file Android Release example, manifest transfer removes bytes in
all three measured paths. A first OTA downloads 830,077 bytes instead of a
1,048,299-byte ZIP. An OTA-to-OTA Hermes patch downloads 115,353 bytes instead
of 1,048,348 bytes. A complete install with no base downloads 832,386 bytes
instead of 1,048,291 bytes.

The tradeoff is request count. The same paths use 14, 2, and 19 requests
respectively, including the manifest, while an archive uses one. A synthetic
1,000-file full replacement uses 1,001 requests and was 35.5% slower than ZIP
in the local installation microbenchmark. This is a real scalability boundary
for applications with very large numbers of changed files. The v1 design
accepts it in exchange for removing the second archive protocol; it does not
claim that manifest transfer always beats an archive.

| Scenario | Protocol | Bytes | Requests | Median install | Median peak temp disk | Median RSS delta |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| JS-only first OTA, Android Release | ZIP | 1,048,299 | 1 | 141.552 ms | 3,334,669 | 4,751,360 |
| JS-only first OTA, Android Release | manifest | 830,077 | 14 | 142.782 ms | 3,116,447 | 16,384 |
| Small OTA-to-OTA, real HBC patch | ZIP | 1,048,348 | 1 | 190.164 ms | 3,334,731 | 0 |
| Small OTA-to-OTA, real HBC patch | manifest | 115,353 | 2 | 100.449 ms | 2,401,736 | 4,620,288 |
| Empty base, Android Release | ZIP | 1,048,291 | 1 | 73.466 ms | 3,334,661 | 0 |
| Empty base, Android Release | manifest | 832,386 | 19 | 42.936 ms | 3,118,756 | 0 |
| 1,000 high-entropy 4 KiB files | ZIP | 4,266,001 | 1 | 2,499.169 ms | 8,362,001 | 1,409,024 |
| 1,000 high-entropy 4 KiB files | manifest | 4,202,065 | 1,001 | 3,386.835 ms | 8,298,065 | 0 |

The RSS delta is noisy because Node reuses previously allocated memory; zero
means no increase above that round's starting RSS, not zero memory use. The
device E2E evidence is recorded separately and is the correctness authority.
These seven-run medians are not p95 values.

## Method

The first three cases use Hermes and PNG outputs built by the `bare` plugin
from `examples/v0.85.0`. The OTA-to-OTA case changes only
`E2E_SCENARIO_MARKER`, rebuilds Hermes, and creates a real Hot Updater bsdiff
patch. The first-OTA reusable set comes from
[`builtin-packaging.json`](builtin-packaging.json), which measured the actual
xxhdpi split install set.

The archive baseline is the default `zip` strategy at the PRD base revision.
Both protocols install the same target bytes and verify every staged SHA-256.
Manifest transfer uses Brotli quality 11 for the Hermes original, matching the
deploy implementation. The stress fixture uses deterministic high-entropy
bytes so cross-file ZIP compression does not manufacture an unrelated size
advantage.

Transfer byte and request counts are exact artifact values. Install time,
temporary disk, and RSS are local Node microbenchmark observations on Darwin
25.3.0 arm64 with Node 24.15.0 and no simulated network latency. They compare
artifact shapes and local work; they are not native-device performance
measurements.

Reproduce after building the affected workspace packages. The preparation
script restores `patchSurface.ts` in a `finally` block:

```sh
node plans/evidence/prepare_manifest_transfer_inputs.mjs
node plans/evidence/measure_manifest_transfer.mjs \
  > plans/evidence/manifest-transfer.json
```

The machine-readable result is in
[`manifest-transfer.json`](manifest-transfer.json).
