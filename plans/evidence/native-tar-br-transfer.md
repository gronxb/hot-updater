# Native tar.br transfer follow-up

The final Swift installer removes the measured many-file request bottleneck. On the retained 1,000-file input, the uncapped median falls from 9,174.0 ms / 1,001 requests to 904.8 ms / 2 requests. The tar.br route transfers 4,434 more payload bytes. With a 512 KiB/s aggregate body cap, medians are 9,107.8 and 9,031.9 ms: essentially unchanged, so this experiment does not establish a bandwidth-limited speedup.

First JS-only and small-patch updates retain two requests and exactly the same body-byte totals. All 80 runs verified every installed target SHA-256. These are five-run medians, not p95 estimates or universal latency guarantees.

## Same-input comparison

Each run uses an iPhone 17 simulator (iOS 26.4.1), the production Swift installer and URLSession downloader, and HTTP/1.0 loopback with 20 ms response delay. Both versions receive the same manifest and raw target bytes. The baseline is `1aa201bbd`; it ignores optional tar.br metadata. The final implementation source hashes, fixture identities, all individual runs, and summaries are in [native-tar-br-transfer.json](native-tar-br-transfer.json).

| Network | Scenario | Per-file ms | tar.br-capable ms | Per-file requests | Final requests / archive | Per-file bytes | Final bytes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Uncapped | first-js-only | 191.6 | 121.8 | 2 | 2 / 0 | 828,366 | 828,366 |
| Uncapped | small-ota-patch | 202.7 | 129.3 | 2 | 2 / 0 | 113,255 | 113,255 |
| Uncapped | empty-base | 251.2 | 106.4 | 20 | 2 / 1 | 837,107 | 834,942 |
| Uncapped | 1000-full-change | 9,174.0 | 904.8 | 1001 | 2 / 1 | 4,238,168 | 4,242,602 |
| 512 KiB/s | first-js-only | 1,700.9 | 1,722.6 | 2 | 2 / 0 | 828,366 | 828,366 |
| 512 KiB/s | small-ota-patch | 349.9 | 361.8 | 2 | 2 / 0 | 113,255 | 113,255 |
| 512 KiB/s | empty-base | 1,810.7 | 1,693.9 | 20 | 2 / 1 | 837,107 | 834,942 |
| 512 KiB/s | 1000-full-change | 9,107.8 | 9,031.9 | 1001 | 2 / 1 | 4,238,168 | 4,242,602 |

## Resource cost and interpretation

The 1,000-file sampled peak store plus temporary disk grows from 4,362,798 to 12,947,626 bytes in the uncapped runs. iOS retains compressed input, the decoded TAR, and extracted target files while validating. Moving the verified directory into staging avoids a redundant full copy and second hash/signature pass; the intermediate implementation took 2,042 ms and sampled 16.9 MB before this correction. Android already uses directory renames and streaming Brotli/TAR extraction. No Android latency claim is made by the Swift benchmark.

RSS is whole test-process resident memory, including initial framework allocations; disk excludes read-only package resources and URLSession system temporary files. Both are sampled every 50 ms and can miss brief peaks. Exact preparation, after-network time, RSS, and disk values remain in JSON. These phases do not isolate validation CPU because work can overlap network activity. Other host work was not suspended; small timing differences should not be overinterpreted. The local body scheduler uses 16 KiB chunks and does not emulate a remote CDN, HTTP/2, TLS, or mobile loss.

The earlier [ZIP comparison](native-transfer.md) measured 1,096.8 ms for 1,000 files under the same nominal uncapped delay using the older installer. That is historical context, not a newly interleaved ZIP run. The new evidence directly compares the final manifest-only baseline and final tar.br-capable installer.

## Selection and fallback contract

The high-entropy fixture produces 4,100,438 archive bytes versus 4,096,004 individual bytes. A strict byte-only comparison would preserve the request bottleneck. The [adversarial agreement](tar-br-consensus.md) therefore permits signed TAR framing bytes only when every target file needs the network and no patch is offered. Partial-reuse and patch plans retain strict comparison. The fixture selects archive with one archive request; JS-only and patch fixtures select none.

Native fault tests cover invalid lengths/hashes, malformed TAR paths/entries, one archive attempt followed by the ordinary file pass, local-reuse preservation, and abort when staging cannot be restored. Release E2E additionally checks successful archive transfer and corrupt-archive recovery. Full standalone E2E acceptance is tracked separately in the PRD; benchmark success does not mark that gate passed.

## Reproduction

Reuse the input preparation from [native-transfer.md](native-transfer.md), then add real deterministic tar.br files. Use isolated source copies and a dedicated simulator: the harness injects test resources temporarily and restores them in `finally`.

```sh
node plans/evidence/prepare_tar_br_transfer_inputs.mjs /tmp/native-transfer /tmp/tar-native-transfer
python3 plans/evidence/run_native_transfer_benchmark.py /tmp/tar-native-transfer "$SIMULATOR_UDID" "$BASELINE_ROOT" "$BASELINE_ROOT" --only manifest --manifest-label baseline-uncapped
python3 plans/evidence/run_native_transfer_benchmark.py /tmp/tar-native-transfer "$SIMULATOR_UDID" "$BASELINE_ROOT" "$FINAL_ROOT" --only manifest --manifest-label tar-br-final-uncapped --tar-br
# Repeat both calls with new labels and --bandwidth-kib 512.
```
