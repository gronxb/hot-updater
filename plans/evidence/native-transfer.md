# Native installer transfer evidence

This is the historical manifest-only measurement. The subsequent tar.br implementation and 80-run comparison are recorded in [native-tar-br-transfer.md](native-tar-br-transfer.md); the results below remain unchanged.

Measured on 2026-09-21 using the production Swift installer and
URLSession downloader on an iPhone 17 / iOS 26.4.1 simulator.
The archive baseline is `ec78756926ca`, the sequential manifest baseline
is `c93799afabf6`, and the corrected manifest implementation is `8081720c09df`.

## Result

Four concurrent downloads reduce the 1,000-file install median from 35,206.9 ms
to 10,186.4 ms (71.1%). The old ZIP installer takes 1,096.8 ms under the same
network conditions. The remaining 9.3x cost is substantial; M3 is **not accepted**
on this evidence. Concurrency fixes the avoidable serialization, but it cannot
remove 1,001 individual requests. The deleted archive path remains a draft PR
change; this report does not authorize merging or declare the deletion gate passed.

The first OTA reuses all 17 PNGs and the font from the native bundle fixture,
requesting only the manifest and changed HBC original. A subsequent real HBC
patch uses 112,294 bytes against 1,055,203 ZIP bytes. On this uncapped loopback
link the extra requests and local verification still cost more elapsed time than ZIP.
Do not extrapolate these elapsed times to mobile bandwidth or HTTP/2.

| Scenario | Installer | Body bytes | Requests | Max concurrent | Median install (ms) |
| --- | --- | ---: | ---: | ---: | ---: |
| first-js-only | archive | 1,055,203 | 1 | 1 | 90.9 |
| first-js-only | manifest-sequential | 827,405 | 2 | 1 | 121.9 |
| first-js-only | manifest | 827,405 | 2 | 1 | 181.5 |
| small-ota-patch | archive | 1,055,203 | 1 | 1 | 112.5 |
| small-ota-patch | manifest-sequential | 112,294 | 2 | 1 | 138.4 |
| small-ota-patch | manifest | 112,294 | 2 | 1 | 212.0 |
| empty-base | archive | 1,055,203 | 1 | 1 | 90.4 |
| empty-base | manifest-sequential | 836,146 | 20 | 1 | 712.8 |
| empty-base | manifest | 836,146 | 20 | 4 | 260.5 |
| 1000-full-change | archive | 4,257,803 | 1 | 1 | 1,096.8 |
| 1000-full-change | manifest-sequential | 4,197,935 | 1001 | 1 | 35,206.9 |
| 1000-full-change | manifest | 4,197,935 | 1001 | 4 | 10,186.4 |

## Local work and sampled resource use

All values below are medians of five runs. Disk includes the existing OTA base,
installer store, staging, and scratch files. It excludes read-only package
resources and system URLSession temporary files. RSS measures the test process,
including framework/test allocations; it is not the installer's exclusive memory.
Sampling every 50 ms can miss short peaks. RSS peak includes the initial RSS
sample, correcting the original collector's omission; every underlying measured
initial value is retained in the JSON. Other host work was not suspended.

| Scenario | Installer | Preparation (ms) | After network (ms) | Sampled peak store/temp bytes | Sampled peak RSS bytes | RSS growth bytes |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| first-js-only | archive | 0.0 | 45.7 | 2,298,442 | 239,632,384 | 262,144 |
| first-js-only | manifest-sequential | 40.3 | 19.1 | 2,307,567 | 249,757,696 | 278,528 |
| first-js-only | manifest | 83.9 | 35.5 | 2,312,987 | 231,096,320 | 16,384 |
| small-ota-patch | archive | 0.0 | 62.9 | 4,596,233 | 237,469,696 | 16,384 |
| small-ota-patch | manifest-sequential | 22.0 | 42.2 | 4,596,819 | 250,019,840 | 49,152 |
| small-ota-patch | manifest | 40.0 | 87.6 | 4,601,579 | 229,965,824 | 0 |
| empty-base | archive | 0.0 | 52.4 | 2,298,443 | 231,063,552 | 16,384 |
| empty-base | manifest-sequential | 2.6 | 29.7 | 2,299,029 | 235,241,472 | 638,976 |
| empty-base | manifest | 17.7 | 26.3 | 2,304,459 | 227,491,840 | 458,752 |
| 1000-full-change | archive | 0.0 | 984.7 | 7,681,590 | 229,720,064 | 2,637,824 |
| 1000-full-change | manifest-sequential | 16.9 | 170.5 | 4,321,875 | 207,405,056 | 573,440 |
| 1000-full-change | manifest | 408.5 | 332.6 | 4,322,532 | 232,030,208 | 1,228,800 |

Preparation spans manifest response completion to the first file request and
includes local resolver, hash, and copy work. After-network spans the last
response to activation. Hashing/decompression/patching can overlap other network
requests; these columns do **not** isolate total validation CPU time.

## Method and reproduction

- HTTP/1.0 loopback server, 20 ms delay before each response, no bandwidth cap.
- Four fixtures: first JS-only OTA, small OTA-to-OTA patch, empty base, and 1,000 deterministic high-entropy 4 KiB files.
- The first three fixtures use bare/Hermes iOS Release outputs from `examples/v0.85.0`, with 17 PNGs, one font, and the HBC file.
- The first-OTA resolver reads an actual fixture bundle through `IOSBuiltInAssetResolver`. It is not a stub resolver. Installed Release-app E2E remains separate packaging evidence.
- Both installers use identical target bytes. All installed target SHA-256 values are verified after every run; patches use the actual bsdiff implementation.
- Request/body-byte counts cover manifest, original, and patch downloads. They exclude headers/TLS and are not billing measurements.
- All 60 individual runs, revisions, and medians are retained in [`native-transfer.json`](native-transfer.json).

Build the workspace, create isolated worktrees at the baseline revisions above,
and create a dedicated simulator. The runner temporarily injects its test/resources
into the provided checkouts and restores them in `finally`. Do not run it concurrently
with edits or fingerprint generation in those checkouts.

```sh
node plans/evidence/prepare_native_transfer_inputs.mjs /tmp/native-transfer
python3 plans/evidence/run_native_transfer_benchmark.py \
  /tmp/native-transfer "$SIMULATOR_UDID" "$ARCHIVE_WORKTREE" "$CORRECTED_WORKTREE"
python3 plans/evidence/run_native_transfer_benchmark.py \
  /tmp/native-transfer "$SIMULATOR_UDID" "$ARCHIVE_WORKTREE" "$SEQUENTIAL_WORKTREE" \
  --only manifest --manifest-label manifest-sequential
```

The earlier [`manifest-transfer.md`](manifest-transfer.md) is a Node artifact
microbenchmark. Its 35.5% regression is not a native performance result and
cannot replace this measurement or establish the M3 gate.
