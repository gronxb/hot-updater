# Prisma Insights CockroachDB evidence

Set `PRISMA_INSIGHTS_COCKROACH_URL` to a CockroachDB 25 URL whose user can
create schemas and run:

```sh
pnpm exec vitest run --project integration:default \
  packages/server/src/adapters/sqlInsights/prisma/cockroachdb.integration.spec.ts
```

The suite creates a uniquely named schema and drops it after each test. It
generates the fixture Prisma Client at runtime, so an environment-less test run
does not import or require a committed generated client.

The evidence covers concurrent idempotent layout creation, exact catalog
metadata for the stored binary legacy key, serializable retry and lease
fencing, and a 50,001-installation migration with exact published-search
totals and bounded DistSQL plans.
