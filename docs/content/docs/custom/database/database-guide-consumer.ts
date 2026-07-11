import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

import { betterSqlite3Types, pgTypes } from "./database-guide-driver-types";

export type DatabaseGuideConsumer = {
  readonly customCliConfig: string;
  readonly customProvider: string;
  readonly customServerConfig: string;
  readonly drizzleCliConfig: string;
  readonly drizzleConfig: string;
  readonly drizzleHotUpdater: string;
  readonly drizzleSetup: string;
  readonly kyselyCliConfig: string;
  readonly kyselyHotUpdater: string;
  readonly kyselySetup: string;
};

type ConsumerFile = {
  readonly content: string;
  readonly relativePath: string;
};

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const serverRoot = path.join(repoRoot, "packages/server");
const rootRequire = createRequire(path.join(repoRoot, "package.json"));
const prismaRequire = createRequire(
  path.join(repoRoot, "examples-server/express-prisma-sqlite/package.json"),
);
const typescriptCli = rootRequire.resolve("typescript/bin/tsc");
const prismaCli = prismaRequire.resolve("prisma/build/index.js");
const tsxCli = prismaRequire.resolve("tsx/cli");

export type SchemaGeneratorName =
  | "generateDrizzleSchema"
  | "generatePrismaSchema";

const toModulePath = (consumerRoot: string, target: string): string =>
  path.relative(consumerRoot, target).split(path.sep).join("/");

const writeConsumerFile = async (
  consumerRoot: string,
  file: ConsumerFile,
): Promise<void> => {
  const filePath = path.join(consumerRoot, file.relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, file.content, "utf8");
};

const createTypeScriptConfig = (consumerRoot: string): string =>
  JSON.stringify(
    {
      compilerOptions: {
        esModuleInterop: true,
        forceConsistentCasingInFileNames: true,
        lib: ["ES2022", "DOM"],
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
        paths: {
          "@hot-updater/aws": [
            toModulePath(
              consumerRoot,
              path.join(repoRoot, "plugins/aws/src/index.ts"),
            ),
          ],
          "@hot-updater/bare": [
            toModulePath(
              consumerRoot,
              path.join(repoRoot, "plugins/bare/src/index.ts"),
            ),
          ],
          "@hot-updater/server": [
            toModulePath(consumerRoot, path.join(serverRoot, "src/index.ts")),
          ],
          "@hot-updater/server/adapters/drizzle": [
            toModulePath(
              consumerRoot,
              path.join(serverRoot, "src/adapters/drizzle.ts"),
            ),
          ],
          "@hot-updater/server/adapters/kysely": [
            toModulePath(
              consumerRoot,
              path.join(serverRoot, "src/adapters/kysely.ts"),
            ),
          ],
          "@hot-updater/standalone": [
            toModulePath(
              consumerRoot,
              path.join(repoRoot, "plugins/standalone/src/index.ts"),
            ),
          ],
          "better-sqlite3": ["./types/better-sqlite3.d.ts"],
          "drizzle-kit": [
            toModulePath(
              consumerRoot,
              path.join(
                repoRoot,
                "examples-server/elysia-drizzle-libsql/node_modules/drizzle-kit",
              ),
            ),
          ],
          "hot-updater": [
            toModulePath(
              consumerRoot,
              path.join(repoRoot, "packages/hot-updater/src/config.ts"),
            ),
          ],
          pg: ["./types/pg.d.ts"],
        },
        resolveJsonModule: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2022",
        types: ["node"],
      },
      include: ["**/*.ts", "**/*.d.ts"],
    },
    null,
    2,
  );

export const generateDatabaseGuideSchema = async (
  generator: SchemaGeneratorName,
): Promise<string> => {
  const script = `import { ${generator} } from "./packages/server/src/db/schemaGenerators.ts"; process.stdout.write(${generator}("sqlite"));`;
  const { stdout } = await execa(process.execPath, [tsxCli, "--eval", script], {
    cwd: repoRoot,
  });
  return stdout;
};

export const typecheckDatabaseGuideConsumer = async (
  consumer: DatabaseGuideConsumer,
): Promise<void> => {
  const consumerRoot = await mkdtemp(
    path.join(serverRoot, ".database-guide-consumer-"),
  );
  try {
    const drizzleSchema = await generateDatabaseGuideSchema(
      "generateDrizzleSchema",
    );
    const files: readonly ConsumerFile[] = [
      { relativePath: "kysely/src/kysely.ts", content: consumer.kyselySetup },
      {
        relativePath: "kysely/src/hotUpdater.ts",
        content: consumer.kyselyHotUpdater,
      },
      {
        relativePath: "kysely/hot-updater.config.ts",
        content: consumer.kyselyCliConfig,
      },
      {
        relativePath: "drizzle/src/drizzle.ts",
        content: consumer.drizzleSetup,
      },
      {
        relativePath: "drizzle/src/hotUpdater.ts",
        content: consumer.drizzleHotUpdater,
      },
      {
        relativePath: "drizzle/hot-updater.config.ts",
        content: consumer.drizzleCliConfig,
      },
      {
        relativePath: "drizzle/src/hot-updater-schema.ts",
        content: drizzleSchema,
      },
      {
        relativePath: "drizzle/drizzle.config.ts",
        content: consumer.drizzleConfig,
      },
      {
        relativePath: "custom/customKyselyDatabase.ts",
        content: consumer.customProvider,
      },
      {
        relativePath: "custom/hot-updater.config.ts",
        content: consumer.customCliConfig,
      },
      {
        relativePath: "custom/server.ts",
        content: consumer.customServerConfig,
      },
      {
        relativePath: "types/better-sqlite3.d.ts",
        content: betterSqlite3Types,
      },
      { relativePath: "types/pg.d.ts", content: pgTypes },
      {
        relativePath: "tsconfig.json",
        content: createTypeScriptConfig(consumerRoot),
      },
    ];
    await Promise.all(
      files.map((file) => writeConsumerFile(consumerRoot, file)),
    );
    await execa(
      process.execPath,
      [
        typescriptCli,
        "--project",
        "tsconfig.json",
        "--noEmit",
        "--pretty",
        "false",
      ],
      { cwd: consumerRoot },
    );
  } finally {
    await rm(consumerRoot, { recursive: true, force: true });
  }
};

export const validatePrismaGuideSchema = async (
  schema: string,
): Promise<void> => {
  const consumerRoot = await mkdtemp(
    path.join(tmpdir(), "hot-updater-prisma-guide-"),
  );
  try {
    const schemaPath = path.join(consumerRoot, "schema.prisma");
    await writeFile(schemaPath, schema, "utf8");
    await execa(
      process.execPath,
      [prismaCli, "validate", "--schema", schemaPath],
      {
        cwd: consumerRoot,
        env: { DATABASE_URL: "file:./guide.db" },
      },
    );
  } finally {
    await rm(consumerRoot, { recursive: true, force: true });
  }
};
