# G1 internal integration contract

Status: internal feasibility protocol, not a frozen public API.

## Worktree and ownership

All work uses `/Users/gronxb/workspace/hot-updater-lynx` on
`codex/lynx-support`. iOS owns `examples/lynx/ios`, Android owns
`examples/lynx/android`, and framework fixtures own the example's React/Vue/Octane
source, build scripts and private `spike` code. The primary agent owns package
dependencies, lockfile, shared contract decisions and execution evidence.

Device interactions use the repository's `agent-device` skill, exact targets and
separate sessions. iOS is reserved on simulator
`0368C5D9-63CF-447E-B6BB-0E3184B1CD0A`; Android on `emulator-5558`. The example's
native identifier is `com.hotupdater.lynxexample` on each OS.

## Real artifact fixtures

Compiler-generated A/B output lives under ignored
`examples/lynx/.hot-updater/g1/<framework>/<A|B>/`. Preserve emitted native entry
names and file bytes. Native integration must identify the actual entry; it must
not infer it from the number of `.bundle` files.

Start with visible A/B identity, one same-name/different-byte managed image and
background native module calls. Expand to the required managed resources and
startup scenarios. `asset:///` is an initial resource-mapping candidate to test,
not an assumption that the host already redirects every loader correctly.

No fixture generation or ordinary metadata file is native verification evidence.

Root provides `scripts/lynx-g1-stage.mjs` for manual G1 placement. Arguments:
`--source <native-output> --output <staging-parent> --entry <relative-entry>
--platform <ios|android> --runtime-id <native-profile>`.
It preserves input files, creates fresh Bundle/Release IDs, emits provisional
`hot-updater-lynx.json` with `{ schemaVersion: 1, bundleId, platform, entry,
runtimeId }`, and hashes every managed file including that sidecar into the
existing `manifest.json` shape. Its JSON result supplies the manifest hash and
selection identity to the trusted native test setup. This unsigned local fixture
preparation is not a signature test or evidence of actual CLI deployment.

## Native module probe

Private module name: `NativeModules.HotUpdaterLynxSpike`.

| Method | Purpose |
| --- | --- |
| `getLaunchInfo(callback)` | Return the native-owned launch snapshot |
| `notifyReady(callback)` | Submit readiness from the bound native context |
| `probeError(callback)` | Return a deterministic G1-only error to verify transport |

Callbacks use either `{ ok: true, data: ... }` or
`{ ok: false, error: { code, message } }`. The launch snapshot reports
`platform`, `bundleId`, `releaseId`, `runtimeId`, `attemptId`, and `contextId`;
unknown/not-yet-assigned values are explicit rather than fabricated success.

Native associates a module call with its actual context and attempt. JS does not
provide authority by passing a bundle ID. Runtime imports have no native-call
side effects; method calls originate in background scripting. A ready call alone
cannot bypass native initial-content evidence or an invalidated attempt.

The probe is not the public runtime SDK or a substitute for its eventual API.
Report genuine native limitations before changing the cross-platform protocol.

## Recovery journal proposal for native verification

This is a concrete G1 proposal to test on both hosts, not completed evidence.

- Scope durable state to the native binary and catalog scope. The private fixture
  driver supplies its scope; production must derive it from native configuration
  and authenticated catalog state. Framework labels cannot supply compatibility.
- Keep verified fatal startup outcomes in crashed-Bundle history and unexplained
  pre-ready exits in a separate set of excluded Release IDs. A new Release may
  retry the latter's cached bytes; it cannot bypass the former's crash policy.
- Persist an attempt before any candidate evaluation. Confirmation atomically
  clears that attempt and saves the confirmed selection. A failed durable write
  cannot return success or allow candidate evaluation. Recovery records the
  exclusion and clears the pending attempt in the same durable transition.
- Initially allow at most 128 unconfirmed Release exclusions per binary/scope.
  Never evict a still-selectable exclusion. Reserve capacity before starting a
  new candidate attempt; at capacity, refuse new unconfirmed candidate attempts
  and retain an eligible confirmed selection or compatible embedded fallback.
  Merely running the already confirmed selection does not consume a new slot.
  Do not throw out of native application startup because capacity was reached.
- Every candidate, rollback, cached-byte retry and prepared installation must
  consult the same native exclusions. A changed set changes the selection
  context and invalidates earlier prepared authorization. The shared selector's
  optional `unconfirmedReleaseIds` input supports this; native enforcement and
  persistence are still required.
- A new authorized Release for unconfirmed cached bytes receives a fresh attempt.
  Only an already confirmed, currently running selection may use normal
  metadata-only adoption. No signal from the old attempt carries forward.

The capacity is a conservative initial bound. A future compaction rule must
prove that removed IDs can never be selected again in this scope. Ordinary
restarts or catalog-generation changes are not such a proof.

## Required follow-on contract decisions

G1 still must establish actual loader/cache mappings, native compatibility
identity/provenance, manifest-bound metadata, durable attempt/exclusion semantics,
and concrete startup observations. Neither the pre-existing experimental package
nor this small probe is evidence that those requirements are complete.
