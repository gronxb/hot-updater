# Prisma Insights MySQL evidence

Set `PRISMA_INSIGHTS_MYSQL_URL` to an administrator-capable MySQL 8 URL and run:

```sh
pnpm exec vitest run --project integration:default \
  packages/server/src/adapters/sqlInsights/prisma/mysql.integration.spec.ts
```

The suite creates a uniquely named database and drops it after each test. It
generates the fixture Prisma Client at runtime, so an environment-less test run
does not import or require a committed generated client.

The evidence covers concurrent DDL-ledger application, InnoDB and functional
index catalog metadata, append/search/report lifecycle behavior, and a 50,001
installation legacy migration with exact published-search totals and bounded
index plans.
