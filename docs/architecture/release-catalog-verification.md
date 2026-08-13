# Release Catalog verification evidence

This file records reproducible evidence for the Release Catalog migration. The
baseline is the exact #1141 commit
`38d899088aa1f621dbc5f13e798f40cd489e85e5`. Measurements below were produced
on 2026-08-13 on arm64 macOS 26.3 with Node 24.15.0 and pnpm 11.6.0.

## Local RED to GREEN benchmark

The benchmark keeps the checked-in name
`fixed-model plugin paged update check`, so the same command measures the old
per-install decision path and the new shared catalog path.

RED was run from a detached worktree at the exact baseline:

```text
pnpm bench:update-check:plugin

hz       1.0191
mean     981.25 ms
p75      978.82 ms
p99      1,149.10 ms
samples  20
```

GREEN was run from the Release Catalog implementation after the configured
warm-up had populated the bounded origin cache:

```text
pnpm bench:update-check:plugin

hz       47,894.41
mean     0.0209 ms
p75      0.0213 ms
p99      0.0497 ms
samples  23,948
```

The measured mean is 46,950 times lower. This is local runtime evidence, not a
substitute for managed-CDN counters.

## Catalog origin and compiler evidence

`packages/server/src/releaseCatalogRoutes.integration.spec.ts` proves that:

- a successful catalog response has the canonical cache headers and ETag;
- 100 simultaneous cold requests singleflight into one exact catalog-row
  read;
- warm/revalidated reads do not perform another database read;
- malformed versions and wrong authorities remain non-cacheable.

`plugins/plugin-core/src/releaseCatalogCompiler.spec.ts` records the following
focused run:

```text
100,000 overlapping app-version Releases  1,944 ms, 11 descriptors
1,680 fingerprint Releases                    83 ms, 11 descriptors
20,000 adversarial rollout Releases            61 ms, CATALOG_OVERSIZE
```

The mutation suite separately proves that oversize and CAS failures preserve
both canonical Releases and the prior compiled catalog.

## Managed cache contracts

The checked-in provider contract tests inspect the effective deployment
configuration rather than treating `Cache-Control` as proof:

- AWS: `plugins/aws/iac/cloudfront.spec.ts` verifies a distinct canonical v2
  behavior and cache policy keyed by `x-api-key` and encoding.
- Cloudflare: `plugins/cloudflare/iac/releaseCatalogCacheConfig.spec.ts`
  verifies the supported Wrangler version/date and pre-Worker cache switch.
- Firebase: `plugins/firebase/iac/releaseCatalogHosting.spec.ts` verifies the
  Hosting rewrite and public endpoint.
- Supabase: doctor and IAC tests require an explicit external catalog CDN for
  the stress-safe profile and reject a direct Edge Function URL as such.

Live CloudFront/Lambda/DynamoDB, Cloudflare edge-shell/D1, Firebase
Hosting/Function/Firestore, and Supabase external-CDN/Edge/Postgres counters
remain deployment evidence: this repository does not infer those counters
from headers or emulator behavior.

## Device/provider matrix

The final ordered repository gate passed from
`.codex/fix-ci/20260813-205845`:

```text
build             passed
test:type         passed (33 projects)
lint              passed (0 warnings, 0 errors)
test              passed (243 files, 2,410 tests)
test:integration  passed (25 files, 1,429 tests)
```

The architecture-valid standalone verification profiles are
`standalone-dynamodb`, `standalone-drizzle`, `standalone-prisma`,
`standalone-kysely`, and `standalone-mongodb`. The legacy `standalone-s3`
profile is excluded because #1141 removed `s3Database`; replacing its database
with process-local mock state would test S3 artifact storage, not a standalone
database provider.

The required standalone profile job IDs are appended here after the runs
complete.
