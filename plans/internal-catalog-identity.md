# Internally managed Catalog identity

## Goal

Users must never configure, copy, synchronize, or interpret an `authorityId`.
Catalog history still needs a stable identity so devices do not confuse two
independent histories or accept older Catalog generations.

## Design

- Remove authority from configuration, generated provider environment variables,
  server construction, deployment inputs, CLI summaries, and public SDK state.
- Keep a deterministic database lookup scope consisting only of strategy,
  platform, channel key, and (for fingerprint strategy) fingerprint hash.
- Store an opaque `catalog_id` in each Catalog row. Generate it when the row is
  first committed, in the same compare-and-set transaction as its generation.
  Reuse it on every subsequent mutation, rebuild, and tombstone/recreation.
- A concurrent first writer that loses the transaction retries against the
  persisted row and adopts the winning ID. Failed transactions leave no identity
  or partial Release behind.
- Read the Catalog generation before its Releases so concurrent writes are
  detected by compare-and-set. If the first commit occurs between those reads,
  reread the newly created Catalog and its Releases instead of reporting lost
  identity.
- Server reads return the stored ID as internal protocol metadata (`catalogId`).
  Neither server startup nor client reads create identity or require new writes.
  CLI and server agree automatically because they use the same Catalog row.
- Native receipts and generation tracking retain the opaque ID. Public React
  Native state exposes Release/Bundle/channel state, not Catalog bookkeeping.
- The new ID is not derived from URLs, cloud resource names, or process memory.
  Restarting processes, changing endpoints, and restoring the same database keep
  identity. A genuinely separate database/history receives a different identity.
- If Releases exist but their Catalog row is missing, do not invent identity or
  reset generation. Require restoring the Catalog row from backup.

## Compatibility boundary

This updates the unreleased `next` v1 schema and internal JS/native protocol
together. It does not introduce a v0 migration, reset any actual database, or
deploy infrastructure. Existing experimental `next` schemas/native builds must
be updated together; identity must never be silently regenerated for an existing
Catalog whose history is being retained.

## Verification

1. Initial deployment without identity configuration creates a Catalog ID.
2. Updates, no-op/changed rebuilds, and tombstone/recreation preserve that ID.
3. Concurrent first commits converge on one ID and monotonic generations.
4. Independent repositories with the same scope get different IDs.
5. Server instances read the committed ID without configuration or writes.
6. Native/client stale-generation and unsolicited-Catalog checks remain intact.
7. Public configuration types reject authority/catalog identity options; generated
   config, provider environments, CLI output, and public SDK state omit them.
8. Build, type checks, lint, unit tests, and relevant integration/native checks pass.

## Progress

- [x] Inspect and choose the persistence design.
- [x] Implement identity lifecycle and remove public configuration.
- [x] Align providers, schemas, native state, examples, and documentation.
- [x] Add scenario regressions and verify.

## Verified result (2026-08-30)

- `.agents/skills/fix-ci/scripts/run_fixci.sh all`: all five ordered steps
  passed against the final code (`.codex/fix-ci/20260830-191402/`).
- Unit tests: 262 files, 2,338 tests passed.
- Integration tests: 25 files, 295 tests passed.
- `pnpm -w test:swift`: 37 tests passed.
- `./gradlew :hot-updater_react-native:testDebugUnitTest --build-cache`
  from `examples/v0.85.0/android`: 42 tests passed.
- `git diff --check`: passed. No production database, infrastructure, commit,
  or push was performed.
