# tar.br adversarial design agreement

Date: 2026-09-21. User authorized two Sol Medium subagents to argue for and
against a tar.br-only auxiliary transport, then implement the agreement.
McClintock reviewed protocol/build/storage benefits; Singer challenged selection,
extraction, retry amplification and unsupported benchmark claims. Both accepted
the following after exchanging objections. This document records design acceptance;
verification results are tracked separately in the evidence reports.

- The verified target manifest remains authoritative. Optional `archive` has
  `downloadFileHash`, `downloadByteSize`, and `tarByteSize`; assets gain logical
  `byteSize`. TAR contains only sorted target regular files, without manifest.
- Generate deterministic `bundle.tar.br` before signing the complete manifest.
  Upload every original and the archive before publishing the Bundle/Release.
- Derive the archive Storage URI from the canonical manifest sibling. Artifact
  v1 adds optional `archiveUrl` and `patch.byteSize`; no archive DB columns,
  public compression option, or format negotiation is restored.
- After verified staging/OTA/builtin reuse, choose archive only with at least two
  remaining network files and archive bytes no greater than the sum of each
  file's `min(original downloadByteSize, offered patch byteSize)`. The measured
  full-download exception below additionally permits signed TAR framing bytes.
  Missing, invalid or overflowing costs decline archive. This guarantees neither
  minimum latency nor a bound on failed-attempt traffic; it avoids invented RTT weights.
- Verify archive compressed length/hash before decoding. Bound TAR and entry
  lengths, require exact target file set, reject duplicates, unsafe paths, links,
  unsupported entries and malformed termination; validate every final hash and
  signature before staging. Preserve atomic activation and catalog/recovery.
- The initial disagreement was whether archive errors should abort installation.
  Aborting makes deterministic retries repeatedly select a permanently corrupt
  optional archive despite valid originals. Both accepted exactly one archive
  attempt followed by one ordinary per-file pass on archive failure. Discard all
  archive scratch, retain prior verified local reuse, never reuse partial
  extraction, and never return to archive or race both routes. Manifest or
  descriptor verification failure still aborts; patch failure uses its original.
- Restore only direct TAR extraction plus the existing Brotli implementation.
  No ZIP/gzip OTA extraction, automatic format detection or strategy framework.
  APK resource reading and bsdiff's internal bzip2 remain necessary.

Tradeoffs retained: one complete compressed object per Bundle, extra deploy
compression/upload work, extraction scratch space, and possible duplicate
transfer on archive failure. A byte-smaller two-file archive can still have
greater extraction overhead. Tests must cover these selection boundaries,
corruption/security failures and retry behavior; actual tar.br native benchmarks
and all five standalone Release E2E profiles remain acceptance gates.

The existing HTTP/1.0 loopback benchmark establishes its measured request-delay
cost only. Repeat on the real installer with tar.br and disclose bandwidth,
protocol and platform limits; do not extrapolate it into universal CDN/HTTP/2
latency claims.

## Measurement-driven amendment

The retained 1,000-file full-change fixture has 4,096,004 original payload bytes,
but its deterministic tar.br is 4,100,438 bytes. The original strict comparison
would leave all 1,000 individual requests in place for 4,434 bytes of TAR overhead.
McClintock proposed a bounded full-download exception; Singer accepted it after
rejecting an unbounded “all files need network” exception:

```text
individualCost = sum(min(originalDownloadBytes, offeredPatchBytes))
T = archive.tarByteSize - sum(asset.byteSize)

archive is selected with >= 2 network files when:
  archive.downloadByteSize <= individualCost
  OR (all target files need network AND no patch is offered
      AND archive.downloadByteSize <= individualCost + T)
```

All metadata and intermediate sums must be nonnegative safe integers; invalid
framing or overflow declines archive. Partial reuse and offered-patch plans keep
the strict comparison. The premium is bounded by the signed TAR framing and
padding size, without a configurable ratio, file-count threshold or assumed RTT.
This remains a tradeoff: it permits extra bytes to reduce full-download request
fanout and does not prove optimal latency on every network. Measure both uncapped
and bandwidth-limited runs on the same retained inputs before acceptance.
