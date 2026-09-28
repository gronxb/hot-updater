/**
 * The acceptance manifest (PRD "Final acceptance"): one row per
 * implementation, with the files S1, S2, S6, and S7 measure, the suites S3
 * and S4 read, and the e2e profiles S5 reads.
 */

export interface AcceptanceSuite {
  /** The vitest project that runs the spec. */
  readonly project: string;
  readonly file: string;
  /** The suite's describe name: every test under it must pass. */
  readonly describe: string;
}

export interface AcceptanceRow {
  readonly name: string;
  /**
   * Repo-relative entry files. The walk follows their relative imports and
   * `@hot-updater/server` subpath imports, resolved to their source.
   */
  readonly entries: readonly string[];
  /** Shared code the walk stops at: another row's code, or DB tooling. */
  readonly shared: readonly string[];
  /** S2 budget in non-blank, non-comment lines. */
  readonly budget: number;
  /** How the budget reads in the table, when not "≤ budget". */
  readonly budgetLabel?: string;
  /** The Atomicity column. */
  readonly atomicity: string;
  /** S3 and S4: the adapter conformance and read-budget suites on the row's backend. */
  readonly suites: readonly AcceptanceSuite[];
  /** Whether the backend caps one atomic write, so S3's over-limit case runs. */
  readonly writeLimit: boolean;
  /** S5: `hot-updater-agent` profiles; none is N/A. */
  readonly profiles: readonly string[];
  /** How the backend's native reads relate to the logical rows S4 budgets. */
  readonly multiplier: string;
}

/** The storage engine layer: engine, SQL core, KV helper, and schema fence. */
const SERVER_DATABASE = "packages/server/src/database/**";
/**
 * `hot-updater db` tooling and the built-in database: migrators, schema
 * generators, and the built-in schema every provider is fenced and migrated
 * with.
 */
const DB_TOOLING = "packages/server/src/db/**";
/** What every provider's database builds on, through `@hot-updater/server/database` and `/db`. */
const SERVER_SHARED = [SERVER_DATABASE, DB_TOOLING];
/** The provider check the server's SQL adapters share. */
const SQL_PROVIDERS = "packages/server/src/adapters/sqlProviders.ts";

const conformance = (
  file: string,
  name: string,
  project = "integration:default",
): AcceptanceSuite => ({
  project,
  file,
  describe: `${name} database adapter conformance`,
});

const readBudgets = (
  file: string,
  name: string,
  project = "integration:default",
): AcceptanceSuite => ({
  project,
  file,
  describe: `${name} read budgets`,
});

export const rows: readonly AcceptanceRow[] = [
  {
    name: "Postgres plugin",
    entries: ["plugins/postgres/src/postgres.ts"],
    // The Kysely adapter it re-exports is a row of its own.
    shared: [
      ...SERVER_SHARED,
      SQL_PROVIDERS,
      "packages/server/src/adapters/kysely.ts",
      "packages/server/src/adapters/kyselyExecutor.ts",
    ],
    budget: 50,
    budgetLabel: "Re-export",
    atomicity: "Through the Kysely executor",
    suites: [
      conformance(
        "plugins/postgres/src/postgres.conformance.integration.spec.ts",
        "postgres (PGlite)",
      ),
      readBudgets(
        "plugins/postgres/src/postgres.readBudgets.integration.spec.ts",
        "postgres (PGlite)",
      ),
    ],
    writeLimit: false,
    profiles: ["standalone-kysely"],
    multiplier:
      "Rows examined equal logical rows: EXPLAIN allows 1 per key and row, 0 per read.",
  },
  {
    name: "Kysely adapter",
    entries: [
      "packages/server/src/adapters/kysely.ts",
      "packages/server/src/adapters/kyselyExecutor.ts",
    ],
    shared: [SERVER_DATABASE, DB_TOOLING, SQL_PROVIDERS],
    budget: 300,
    atomicity: "Transaction + row guards",
    suites: [
      conformance(
        "packages/server/src/adapters/kysely.conformance.integration.spec.ts",
        "kysely (PGlite)",
      ),
      readBudgets(
        "packages/server/src/adapters/kysely.readBudgets.integration.spec.ts",
        "kysely (PGlite)",
      ),
    ],
    writeLimit: false,
    profiles: ["standalone-kysely"],
    multiplier:
      "Rows examined equal logical rows: EXPLAIN allows 1 per key and row, 0 per read.",
  },
  {
    name: "Prisma adapter",
    entries: [
      "packages/server/src/adapters/prisma.ts",
      "packages/server/src/adapters/prismaExecutor.ts",
    ],
    shared: [SERVER_DATABASE, DB_TOOLING, SQL_PROVIDERS],
    budget: 300,
    atomicity: "`$transaction` + row guards",
    suites: [
      conformance(
        "packages/server/src/adapters/prisma.conformance.integration.spec.ts",
        "prisma (PGlite)",
      ),
      readBudgets(
        "packages/server/src/adapters/prisma.readBudgets.integration.spec.ts",
        "prisma (PGlite)",
      ),
    ],
    writeLimit: false,
    profiles: ["standalone-prisma"],
    multiplier:
      "Rows examined equal logical rows: EXPLAIN allows 1 per key and row, 0 per read.",
  },
  {
    name: "MongoDB adapter",
    entries: [
      "packages/server/src/adapters/mongodb.ts",
      "packages/server/src/adapters/mongodbAdapter.ts",
    ],
    shared: [SERVER_DATABASE, DB_TOOLING],
    budget: 300,
    atomicity: "`withTransaction` + conditional writes",
    suites: [
      conformance(
        "packages/server/src/adapters/mongodb.integration.spec.ts",
        "mongodb (replica set)",
      ),
      readBudgets(
        "packages/server/src/adapters/mongodb.readBudgets.integration.spec.ts",
        "mongodb (replica set)",
      ),
    ],
    writeLimit: false,
    profiles: ["standalone-mongodb"],
    multiplier:
      "Native reads equal logical rows, a `batchSize` page at a time.",
  },
  {
    name: "Drizzle adapter",
    entries: [
      "packages/server/src/adapters/drizzle.ts",
      "packages/server/src/adapters/drizzleExecutor.ts",
    ],
    shared: [SERVER_DATABASE, DB_TOOLING, SQL_PROVIDERS],
    budget: 300,
    atomicity: "Transaction checked on first use",
    suites: [
      conformance(
        "packages/server/src/adapters/drizzle.conformance.integration.spec.ts",
        "drizzle (PGlite)",
      ),
      readBudgets(
        "packages/server/src/adapters/drizzle.readBudgets.integration.spec.ts",
        "drizzle (PGlite)",
      ),
    ],
    writeLimit: false,
    profiles: ["standalone-drizzle"],
    multiplier:
      "Rows examined equal logical rows: EXPLAIN allows 1 per key and row, 0 per read.",
  },
  {
    name: "Supabase",
    entries: [
      "plugins/supabase/src/supabaseDatabase.ts",
      "plugins/supabase/src/supabaseExecutor.ts",
      "plugins/supabase/src/supabaseMigration.ts",
      "plugins/supabase/src/supabaseSchema.ts",
    ],
    shared: SERVER_SHARED,
    budget: 300,
    budgetLabel: "≤ 300, apply RPC included",
    atomicity: "Generic apply RPC",
    suites: [
      conformance(
        "plugins/supabase/src/supabaseDatabase.conformance.integration.spec.ts",
        "supabase apply RPC (PGlite)",
      ),
      readBudgets(
        "plugins/supabase/src/supabaseDatabase.readBudgets.integration.spec.ts",
        "supabase apply RPC (PGlite)",
      ),
    ],
    writeLimit: true,
    profiles: ["supabase"],
    multiplier:
      "Rows examined equal logical rows: EXPLAIN of the core's statement allows 1 per key and row, 0 per read.",
  },
  {
    name: "Cloudflare D1",
    entries: [
      "plugins/cloudflare/src/d1Database.ts",
      "plugins/cloudflare/src/d1Executor.ts",
      "plugins/cloudflare/src/worker/d1Database.ts",
    ],
    shared: SERVER_SHARED,
    budget: 300,
    atomicity: "`batch()` + `_hu_write` guard",
    suites: [
      conformance(
        "plugins/cloudflare/worker/src/d1.conformance.integration.spec.ts",
        "d1 (workerd)",
        "integration:cloudflare",
      ),
      readBudgets(
        "plugins/cloudflare/worker/src/d1.readBudgets.integration.spec.ts",
        "d1 (workerd)",
        "integration:cloudflare",
      ),
    ],
    writeLimit: true,
    profiles: ["cloudflare"],
    multiplier:
      "`rows_read` at most 2 per key and row, plus 1 per get or query.",
  },
  {
    name: "Firebase",
    entries: [
      "plugins/firebase/src/firebaseDatabase.ts",
      "plugins/firebase/src/firestoreStore.ts",
    ],
    shared: SERVER_SHARED,
    budget: 300,
    atomicity: "`runTransaction` on guarded documents",
    suites: [
      conformance(
        "plugins/firebase/src/firebaseDatabase.integration.spec.ts",
        "key-value (Firestore emulator)",
      ),
      readBudgets(
        "plugins/firebase/src/firebaseDatabase.readBudgets.integration.spec.ts",
        "key-value (Firestore emulator)",
      ),
    ],
    writeLimit: true,
    profiles: ["firebase"],
    multiplier:
      "Index reads return row copies, so a transaction reads the rows it guards again whole (deploy's catalog compile: 6 gets of 9 keys for 4 of 4), and copies of a table with counters (reference counters, or an aggregate's metrics) add a get of their rows per read.",
  },
  {
    name: "DynamoDB",
    entries: [
      "plugins/aws/src/dynamoDB.ts",
      "plugins/aws/src/dynamoDBStore.ts",
    ],
    // CloudFront invalidation is the AWS deployment's CDN, not storage.
    shared: [...SERVER_SHARED, "plugins/aws/src/cloudFrontInvalidation.ts"],
    budget: 300,
    atomicity: "`TransactWriteItems` + conditions",
    suites: [
      conformance(
        "plugins/aws/src/dynamoDB.integration.spec.ts",
        "key-value (DynamoDB Local)",
      ),
      readBudgets(
        "plugins/aws/src/dynamoDB.readBudgets.integration.spec.ts",
        "key-value (DynamoDB Local)",
      ),
    ],
    writeLimit: true,
    profiles: ["standalone-dynamodb", "aws"],
    multiplier:
      "Index reads return row copies, so a transaction reads the rows it guards again whole (deploy's catalog compile: 6 gets of 9 keys for 4 of 4), and copies of a table with counters (reference counters, or an aggregate's metrics) add a get of their rows per read.",
  },
  {
    name: "Memory (reference)",
    entries: ["plugins/plugin-core/src/database/memoryAdapter.ts"],
    // The adapter contract and value helpers every adapter imports.
    shared: [
      "plugins/plugin-core/src/database/adapter.ts",
      "plugins/plugin-core/src/database/values.ts",
    ],
    budget: 300,
    atomicity: "Copy-on-write swap",
    suites: [
      conformance(
        "packages/test-utils/src/databaseAdapterConformance.integration.spec.ts",
        "memory",
      ),
      readBudgets(
        "packages/server/src/database/memory.readBudgets.integration.spec.ts",
        "memory",
      ),
    ],
    writeLimit: false,
    profiles: [],
    multiplier: "Native reads equal logical rows.",
  },
  {
    name: "Shared `sqlAdapter` core",
    entries: ["packages/server/src/database/sql/sqlAdapter.ts"],
    // Table DDL is its own module outside the runtime core (decision 38).
    shared: ["packages/server/src/database/sql/sqlSchema.ts"],
    budget: 500,
    atomicity: "Owns SQL semantics",
    suites: [
      conformance(
        "packages/server/src/database/sql/sqlAdapter.integration.spec.ts",
        "sql (pooled PostgreSQL)",
      ),
      conformance(
        "packages/server/src/database/sql/sqlAdapter.integration.spec.ts",
        "sql (pooled MySQL)",
      ),
      conformance(
        "packages/server/src/database/sql/sqlAdapter.integration.spec.ts",
        "sql batch (pooled PostgreSQL)",
      ),
      readBudgets(
        "packages/server/src/database/sql/sqlAdapter.readBudgets.integration.spec.ts",
        "sql (pooled PostgreSQL)",
      ),
      readBudgets(
        "packages/server/src/database/sql/sqlAdapter.readBudgets.integration.spec.ts",
        "sql (pooled MySQL)",
      ),
    ],
    writeLimit: true,
    profiles: [
      "standalone-kysely",
      "standalone-drizzle",
      "standalone-prisma",
      "supabase",
      "cloudflare",
    ],
    multiplier:
      "Rows examined equal logical rows on pooled PostgreSQL and MySQL (EXPLAIN ANALYZE), 1 per key and row.",
  },
  {
    name: "Shared KV helper",
    entries: ["packages/server/src/database/kv/kvAdapter.ts"],
    shared: [],
    budget: 400,
    atomicity: "Owns index and unique items",
    suites: [
      conformance(
        "packages/server/src/database/kv/kvAdapter.conformance.integration.spec.ts",
        "key-value (in-memory store)",
      ),
      readBudgets(
        "packages/server/src/database/kv/kvAdapter.readBudgets.integration.spec.ts",
        "key-value (in-memory store)",
      ),
    ],
    writeLimit: true,
    profiles: ["standalone-dynamodb", "aws", "firebase"],
    multiplier:
      "Index reads return row copies, so a transaction reads the rows it guards again whole (deploy's catalog compile: 6 gets of 9 keys for 4 of 4), and copies of a table with counters (reference counters, or an aggregate's metrics) add a get of their rows per read.",
  },
  {
    name: "Schema fence",
    // The adapter decorator every provider's database gets from
    // createEngineDatabase: it checks the settings rows before the first read.
    entries: ["packages/server/src/database/fence.ts"],
    shared: [],
    budget: 150,
    atomicity: "Reads the settings rows once; writes nothing",
    suites: [
      {
        project: "unit:default",
        file: "packages/server/src/database/fence.spec.ts",
        describe: "schema fence",
      },
      {
        project: "unit:default",
        file: "packages/server/src/database/fence.spec.ts",
        describe: "a provider's fenced database on PGlite",
      },
    ],
    writeLimit: false,
    profiles: [
      "standalone-kysely",
      "standalone-drizzle",
      "standalone-prisma",
      "standalone-mongodb",
      "standalone-dynamodb",
      "supabase",
      "cloudflare",
      "firebase",
      "aws",
    ],
    multiplier: "One settings read per process, then none.",
  },
  {
    name: "Engine",
    // Reads, transactions, and aggregates; schema resolution and validation.
    entries: [
      "packages/server/src/database/engine.ts",
      "packages/server/src/database/resolveSchema.ts",
    ],
    shared: [],
    budget: 1500,
    atomicity: "Owns transactions and aggregates",
    // Every row's suites run on the engine; its own fault injection and contention specs:
    suites: [
      {
        project: "unit:default",
        file: "packages/server/src/database/engineTransaction.spec.ts",
        describe: "engine transactions",
      },
      {
        project: "unit:default",
        file: "packages/server/src/database/engineAggregates.spec.ts",
        describe: "engine aggregates",
      },
      {
        project: "unit:default",
        file: "packages/server/src/database/engineReads.spec.ts",
        describe: "engine reads",
      },
    ],
    writeLimit: false,
    profiles: [
      "standalone-kysely",
      "standalone-drizzle",
      "standalone-prisma",
      "standalone-mongodb",
      "standalone-dynamodb",
      "supabase",
      "cloudflare",
      "firebase",
      "aws",
    ],
    multiplier:
      "Counts logical rows at its boundary; each backend's multiplier applies below it.",
  },
];

/**
 * Layers that must stay free of the domain as a whole, beyond the rows in
 * them: every file passes S1's rules on its own. The storage engine layer
 * holds the engine, the SQL core, the KV helper, and the schema fence; the
 * built-in database, which binds core's schema, lives in `db/` tooling.
 */
export const layers = [
  {
    name: "Storage engine layer",
    files: ["packages/server/src/database/**"],
  },
];

/** Imports that bring domain code into an implementation (S1). */
export const domainImports = {
  files: [
    "packages/server/src/core/**",
    "packages/server/src/plugins/**",
    "packages/server/src/assembly/**",
  ],
  packages: [
    "@hot-updater/core",
    "@hot-updater/server",
    "@hot-updater/server/plugins",
    "@hot-updater/server/plugins/*",
  ],
};

/**
 * Schema field names that name no domain concept: words any storage code
 * uses, including `message`, which every Error has. Engine columns (`_v`,
 * `_shard`) are skipped where names are read.
 */
export const genericFieldNames = [
  "id",
  "name",
  "type",
  "kind",
  "key",
  "value",
  "message",
];
