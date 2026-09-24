/**
 * The acceptance manifest (PRD "Final acceptance"): one row per
 * implementation, with the files S1 and S2 measure, the suites S3 and S4
 * read, and the e2e profiles S5 reads.
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
  /** Repo-relative entry files; S1 and S2 follow their relative imports. */
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
}

/** Engine, SQL core, KV helper, schema fence, and the built-in database. */
const SERVER_DATABASE = "packages/server/src/database/**";
/** `hot-updater db` tooling: migrators and schema generators. */
const DB_TOOLING = "packages/server/src/db/**";
/** The provider check the server's SQL adapters share. */
const SQL_PROVIDERS = "packages/server/src/adapters/sqlProviders.ts";

const conformance = (
  project: string,
  file: string,
  name: string,
): AcceptanceSuite => ({
  project,
  file,
  describe: `${name} database adapter conformance`,
});

const readBudgets = (
  project: string,
  file: string,
  name: string,
): AcceptanceSuite => ({
  project,
  file,
  describe: `${name} read budgets`,
});

export const rows: readonly AcceptanceRow[] = [
  {
    name: "Postgres plugin",
    entries: ["plugins/postgres/src/postgres.ts"],
    shared: [],
    budget: 50,
    budgetLabel: "Re-export",
    atomicity: "Through the Kysely executor",
    suites: [],
    writeLimit: false,
    profiles: ["standalone-kysely"],
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
        "integration:default",
        "packages/server/src/adapters/kysely.integration.spec.ts",
        "kysely (PGlite)",
      ),
      readBudgets(
        "integration:default",
        "packages/server/src/adapters/kysely.integration.spec.ts",
        "kysely (PGlite)",
      ),
    ],
    writeLimit: false,
    profiles: ["standalone-kysely"],
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
        "integration:default",
        "packages/server/src/adapters/prisma.integration.spec.ts",
        "prisma (PGlite)",
      ),
      readBudgets(
        "integration:default",
        "packages/server/src/adapters/prisma.integration.spec.ts",
        "prisma (PGlite)",
      ),
    ],
    writeLimit: false,
    profiles: ["standalone-prisma"],
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
        "integration:default",
        "packages/server/src/adapters/mongodb.integration.spec.ts",
        "mongodb (replica set)",
      ),
      readBudgets(
        "integration:default",
        "packages/server/src/adapters/mongodb.integration.spec.ts",
        "mongodb (replica set)",
      ),
    ],
    writeLimit: false,
    profiles: ["standalone-mongodb"],
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
        "integration:default",
        "packages/server/src/adapters/drizzle.integration.spec.ts",
        "drizzle (PGlite)",
      ),
      readBudgets(
        "integration:default",
        "packages/server/src/adapters/drizzle.integration.spec.ts",
        "drizzle (PGlite)",
      ),
    ],
    writeLimit: false,
    profiles: ["standalone-drizzle"],
  },
  {
    name: "Supabase",
    entries: [
      "plugins/supabase/src/supabaseDatabase.ts",
      "plugins/supabase/src/supabaseExecutor.ts",
      "plugins/supabase/src/supabaseSchema.ts",
    ],
    shared: [],
    budget: 300,
    budgetLabel: "≤ 300, apply RPC included",
    atomicity: "Generic apply RPC",
    suites: [
      conformance(
        "integration:default",
        "plugins/supabase/src/supabaseDatabase.integration.spec.ts",
        "supabase apply RPC (PGlite)",
      ),
      readBudgets(
        "integration:default",
        "plugins/supabase/src/supabaseDatabase.integration.spec.ts",
        "supabase apply RPC (PGlite)",
      ),
    ],
    writeLimit: true,
    profiles: ["supabase"],
  },
  {
    name: "Cloudflare D1",
    entries: [
      "plugins/cloudflare/src/d1Database.ts",
      "plugins/cloudflare/src/d1Executor.ts",
      "plugins/cloudflare/src/worker/d1Database.ts",
    ],
    shared: [],
    budget: 300,
    atomicity: "`batch()` + `_hu_write` guard",
    suites: [
      conformance(
        "integration:cloudflare",
        "plugins/cloudflare/worker/src/d1Adapter.integration.spec.ts",
        "d1 (workerd)",
      ),
      readBudgets(
        "integration:cloudflare",
        "plugins/cloudflare/worker/src/d1Adapter.integration.spec.ts",
        "d1 (workerd)",
      ),
    ],
    writeLimit: true,
    profiles: ["cloudflare"],
  },
  {
    name: "Firebase",
    entries: [
      "plugins/firebase/src/firebaseDatabase.ts",
      "plugins/firebase/src/firestoreStore.ts",
    ],
    shared: [],
    budget: 300,
    atomicity: "`runTransaction` on guarded documents",
    suites: [
      conformance(
        "integration:default",
        "plugins/firebase/src/firebaseDatabase.integration.spec.ts",
        "key-value (Firestore emulator)",
      ),
      readBudgets(
        "integration:default",
        "plugins/firebase/src/firebaseDatabase.integration.spec.ts",
        "key-value (Firestore emulator)",
      ),
    ],
    writeLimit: true,
    profiles: ["firebase"],
  },
  {
    name: "DynamoDB",
    entries: [
      "plugins/aws/src/dynamoDB.ts",
      "plugins/aws/src/dynamoDBStore.ts",
    ],
    // CloudFront invalidation is the AWS deployment's CDN, not storage.
    shared: ["plugins/aws/src/cloudFrontInvalidation.ts"],
    budget: 300,
    atomicity: "`TransactWriteItems` + conditions",
    suites: [
      conformance(
        "integration:default",
        "plugins/aws/src/dynamoDB.integration.spec.ts",
        "key-value (DynamoDB Local)",
      ),
      readBudgets(
        "integration:default",
        "plugins/aws/src/dynamoDB.integration.spec.ts",
        "key-value (DynamoDB Local)",
      ),
    ],
    writeLimit: true,
    profiles: ["standalone-dynamodb", "aws"],
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
        "integration:default",
        "packages/test-utils/src/databaseAdapterConformance.integration.spec.ts",
        "memory",
      ),
      readBudgets(
        "integration:default",
        "packages/test-utils/src/databaseAdapterConformance.integration.spec.ts",
        "memory",
      ),
    ],
    writeLimit: false,
    profiles: [],
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
        "integration:default",
        "packages/server/src/database/sql/sqlAdapter.integration.spec.ts",
        "sql (pooled PostgreSQL)",
      ),
      conformance(
        "integration:default",
        "packages/server/src/database/sql/sqlAdapter.integration.spec.ts",
        "sql (pooled MySQL)",
      ),
      conformance(
        "integration:default",
        "packages/server/src/database/sql/sqlAdapter.integration.spec.ts",
        "sql batch (pooled PostgreSQL)",
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
  },
  {
    name: "Shared KV helper",
    entries: ["packages/server/src/database/kv/kvAdapter.ts"],
    shared: [],
    budget: 400,
    atomicity: "Owns index and unique items",
    suites: [
      conformance(
        "integration:default",
        "packages/server/src/database/kv/kvAdapter.integration.spec.ts",
        "key-value (in-memory store)",
      ),
    ],
    writeLimit: true,
    profiles: ["standalone-dynamodb", "aws", "firebase"],
  },
  {
    name: "Engine",
    // Reads, transactions, and aggregates; schema resolution and validation; the fence.
    entries: [
      "packages/server/src/database/engine.ts",
      "packages/server/src/database/resolveSchema.ts",
      "packages/server/src/database/fence.ts",
    ],
    shared: [],
    budget: 1500,
    atomicity: "Owns transactions and aggregates",
    suites: [],
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
 * Schema field names that name no domain concept: engine columns, and words
 * any storage code uses.
 */
export const genericFieldNames = [
  "id",
  "name",
  "type",
  "kind",
  "key",
  "value",
  "message",
  "payload",
  "metadata",
  "hash",
  "prefix",
  "role",
  "operation",
  "revision",
  "generation",
  "identity",
  "strategy",
  "enabled",
  "day",
  "events",
];
