// @ts-check
/**
 * The TypeScript CI runs the integration projects of vitest.workspace.mts as
 * parallel jobs, one per group below. Every job has Docker, Bun, and Deno,
 * and specs start the containers they use; only a group that sets `firebase`
 * installs Java 21 and starts the Firebase emulators. `rest` runs every
 * integration file no other group claims, so a new spec always runs, and
 * check-integration-groups.mjs checks that the groups split the files
 * exactly. With no group selected, `pnpm test:integration` runs every file,
 * as it always has.
 *
 *   HOT_UPDATER_INTEGRATION_GROUP=sql pnpm test:integration
 *   node scripts/ci/integration-groups.mjs   # the GitHub Actions matrix
 */
import { pathToFileURL } from "node:url";

/** The environment variable that selects a group. */
export const INTEGRATION_GROUP_ENV = "HOT_UPDATER_INTEGRATION_GROUP";

/** The group that runs every integration file the others leave. */
export const REST_GROUP = "rest";

/**
 * @typedef {object} IntegrationGroup
 * @property {string} name
 * @property {string} [project] The Vitest project it runs files from. `rest`
 *   has none: it runs the files the other groups leave in every project.
 * @property {readonly string[]} [include] Globs from the repository root.
 *   Without them the group runs its whole project.
 * @property {boolean} [firebase] Starts the Firestore and Storage emulators,
 *   which need Java 21. Specs that use them belong to a group that sets it.
 */

/** @type {readonly IntegrationGroup[]} */
export const integrationGroups = [
  {
    // Pooled PostgreSQL 17 and MySQL 8 in Docker Compose
    // (packages/server/src/database/sql/docker-compose.yml).
    name: "sql",
    project: "integration:default",
    include: [
      "packages/server/src/database/sql/*.integration.spec.ts",
      "packages/server/src/adapters/prisma.integration.spec.ts",
      "packages/server/src/plugins/insights/insightsRollout.integration.spec.ts",
    ],
  },
  {
    // A MongoDB replica set in Docker Compose
    // (examples-server/hono-mongodb/docker-compose.yml).
    name: "mongodb",
    project: "integration:default",
    include: ["packages/server/src/adapters/mongodb*.integration.spec.ts"],
  },
  {
    // DynamoDB Local, LocalStack, and the Lambda Node.js image in Docker.
    name: "aws",
    project: "integration:default",
    include: ["plugins/aws/**/*.integration.spec.ts"],
  },
  {
    // The Firestore, Storage, and Functions emulators.
    name: "firebase",
    project: "integration:default",
    include: ["plugins/firebase/**/*.integration.spec.ts"],
    firebase: true,
  },
  {
    // A Supabase stack and the Deno edge runtime in Docker Compose, and the
    // PGlite database suites.
    name: "supabase",
    project: "integration:default",
    include: ["plugins/supabase/**/*.integration.spec.ts"],
  },
  {
    // Workers in workerd, with D1 and R2.
    name: "cloudflare",
    project: "integration:cloudflare",
  },
  {
    // Packs @hot-updater/test-utils and runs its suites from a consumer.
    name: "test-utils",
    project: "integration:default",
    include: ["packages/server/src/testUtils*.integration.spec.ts"],
  },
  // The example servers. Each starts its own Docker Compose stack, if any.
  {
    // DynamoDB Local with MinIO, and MongoDB.
    name: "examples-1",
    project: "integration:default",
    include: [
      "examples-server/hono-dynamodb/**/*.integration.spec.ts",
      "examples-server/hono-mongodb/**/*.integration.spec.ts",
    ],
  },
  {
    // MySQL, PGlite, and libSQL.
    name: "examples-2",
    project: "integration:default",
    include: [
      "examples-server/hono-kysely-mysql/**/*.integration.spec.ts",
      "examples-server/hono-kysely-pglite/**/*.integration.spec.ts",
      "examples-server/elysia-drizzle-libsql/**/*.integration.spec.ts",
    ],
  },
  {
    // PostgreSQL, PGlite, and SQLite.
    name: "examples-3",
    project: "integration:default",
    include: [
      "examples-server/hono-prisma-postgres/**/*.integration.spec.ts",
      "examples-server/hono-drizzle-pglite/**/*.integration.spec.ts",
      "examples-server/express-prisma-sqlite/**/*.integration.spec.ts",
    ],
  },
  {
    // In-memory, PGlite, and runtime bundle (Node.js, Bun, Deno, workerd)
    // specs today, and any new spec no group above claims.
    name: REST_GROUP,
  },
];

/**
 * The group called `name`, or undefined without a name, which runs every
 * integration file.
 * @param {string | undefined} name
 * @returns {IntegrationGroup | undefined}
 */
export function findIntegrationGroup(name) {
  if (!name) {
    return undefined;
  }
  const group = integrationGroups.find((candidate) => candidate.name === name);
  if (!group) {
    const names = integrationGroups.map((candidate) => candidate.name);
    throw new Error(
      `Unknown ${INTEGRATION_GROUP_ENV} "${name}". Groups: ${names.join(", ")}.`,
    );
  }
  return group;
}

/**
 * Whether the Firebase emulators start: in a group that sets `firebase`, and
 * whenever every integration file runs.
 * @param {IntegrationGroup | undefined} group
 */
export function startsFirebaseEmulators(group) {
  return group === undefined || group.firebase === true;
}

/**
 * @typedef {{
 *   test?: { name?: string; include?: string[]; exclude?: string[] };
 * }} VitestProject
 */

/**
 * The integration projects `group` runs, each narrowed to the group's files.
 * Without a group, the projects run as defined.
 * @template {VitestProject} Project
 * @param {IntegrationGroup | undefined} group
 * @param {readonly Project[]} projects
 * @returns {Project[]}
 */
export function selectIntegrationProjects(group, projects) {
  if (!group) {
    return [...projects];
  }
  return projects.flatMap((project) => {
    const files = groupFiles(group, project.test ?? {});
    return files ? [{ ...project, test: { ...project.test, ...files } }] : [];
  });
}

/**
 * The include and exclude globs `group` runs a project with, or undefined
 * when it runs none of the project's files.
 * @param {IntegrationGroup} group
 * @param {NonNullable<VitestProject["test"]>} test
 */
function groupFiles(group, { name, exclude }) {
  if (group.name !== REST_GROUP) {
    if (group.project !== name) {
      return undefined;
    }
    return group.include ? { include: [...group.include] } : {};
  }
  const claims = integrationGroups.filter(
    (other) => other.name !== REST_GROUP && other.project === name,
  );
  if (claims.some((other) => !other.include)) {
    // Another group runs this whole project.
    return undefined;
  }
  if (claims.length === 0) {
    return {};
  }
  if (!exclude) {
    throw new Error(
      `${name} needs an explicit exclude list for "${REST_GROUP}" to extend.`,
    );
  }
  return {
    exclude: [...exclude, ...claims.flatMap((other) => other.include ?? [])],
  };
}

/** The GitHub Actions matrix: one job per group. */
export function githubMatrix() {
  return {
    include: integrationGroups.map((group) => ({
      group: group.name,
      java: startsFirebaseEmulators(group),
    })),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(JSON.stringify(githubMatrix()));
}
