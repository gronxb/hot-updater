import fs from "fs/promises";
import { createRequire } from "module";
import os from "os";
import path from "path";

import { InitError } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildLambdaFromDefinition } from "./managedLambda";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");

/** A project's server definition, as init writes it, with a plugin of its own. */
const DEFINITION = `import { dynamoDB, plugins, s3Storage } from "@hot-updater/aws";
import { createHotUpdater } from "@hot-updater/server";
import { definePlugin, defineTable } from "@hot-updater/server/plugins";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

const whoAmI = () => new STSClient({}).send(new GetCallerIdentityCommand({}));

const notes = definePlugin({
  id: "notes",
  schemaVersion: "1",
  schema: {
    notes: defineTable(
      { id: { type: "string" }, text: { type: "string" } },
      { key: ["id"] },
    ),
  },
  init: () => ({
    api: {},
    endpoints: [
      {
        method: "GET",
        path: "/notes/:id",
        access: "client",
        handler: async () =>
          Response.json({ from: "sample notes plugin", whoAmI: typeof whoAmI }),
      },
    ],
  }),
});

const awsOptions = {
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: {
    accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY!,
  },
};

export const hotUpdater = createHotUpdater({
  database: dynamoDB({
    ...awsOptions,
    tableName: process.env.HOT_UPDATER_DYNAMODB_TABLE_NAME!,
  }),
  storage: [
    s3Storage({
      ...awsOptions,
      bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
    }),
  ],
  plugins: [...plugins, notes],
});
`;

let project: string;
let lambdaDir: string;

beforeEach(async () => {
  project = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-lambda-"));
  // The project's dependencies, such as the server its plugin is written against.
  await fs.symlink(
    path.join(packageRoot, "node_modules"),
    path.join(project, "node_modules"),
  );
  lambdaDir = path.join(project, "lambda");
  await fs.mkdir(lambdaDir);
});

afterEach(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

describe("the managed Lambda@Edge function from a project's server definition", () => {
  it("bundles the definition on the table and bucket init set up, with the project's plugin", async () => {
    const definition = path.join(project, "hotUpdater.ts");
    await fs.writeFile(definition, DEFINITION);

    await buildLambdaFromDefinition({
      definition,
      packageRoot,
      projectRoot: project,
      lambdaDir,
    });

    // The function's code is one file; the entry that built it is gone.
    await expect(fs.readdir(lambdaDir)).resolves.toEqual(["index.cjs"]);
    const code = await fs.readFile(path.join(lambdaDir, "index.cjs"), "utf-8");
    expect(code).toContain("sample notes plugin");
    // Init replaces these with the table, bucket, and key pair it set up.
    expect(code).toContain("HotUpdater.DYNAMODB_TABLE_NAME");
    expect(code).toContain("HotUpdater.CLOUDFRONT_KEY_PAIR_ID");
    // The Lambda runtime provides the AWS SDK clients the prebuilt function
    // takes from it; a client a plugin brings is bundled at its version.
    expect(code).toMatch(/require\("@aws-sdk\/client-dynamodb"\)/u);
    expect(code).not.toMatch(/require\("@aws-sdk\/client-sts"\)/u);
    expect(code).toContain("GetCallerIdentityCommand");
    expect(code).not.toMatch(/require\("@hot-updater\//u);
    // None of the machine's paths are deployed: not the project's, the
    // repository's its packages come from, or the home directory, not even
    // in a module's name, which esbuild writes from the project.
    for (const local of [
      project,
      await fs.realpath(project),
      repositoryRoot,
      await fs.realpath(repositoryRoot),
      os.homedir(),
    ]) {
      expect(code).not.toContain(local);
    }

    // It loads as the function does, and exports its handler.
    globalThis.HotUpdater = {
      CLOUDFRONT_KEY_PAIR_ID: "KTEST",
      DYNAMODB_REGION: "us-east-1",
      DYNAMODB_TABLE_NAME: "hot-updater-metadata",
      SSM_PARAMETER_NAME: "/hot-updater/test",
      SSM_REGION: "us-east-1",
      S3_BUCKET_NAME: "hot-updater-bundles",
    };
    const loaded = createRequire(import.meta.url)(
      path.join(lambdaDir, "index.cjs"),
    ) as { handler?: unknown };
    expect(typeof loaded.handler).toBe("function");
  });

  it("names the function when the definition cannot be bundled", async () => {
    const definition = path.join(project, "hotUpdater.ts");
    await fs.writeFile(
      definition,
      `import { notes } from "@acme/missing-plugin";\nexport const hotUpdater = notes;\n`,
    );

    const failure = buildLambdaFromDefinition({
      definition,
      packageRoot,
      projectRoot: project,
      lambdaDir,
    });
    await expect(failure).rejects.toBeInstanceOf(InitError);
    await expect(failure).rejects.toThrow(
      /^Could not bundle hotUpdater\.ts into the AWS Lambda@Edge function: .*hotUpdater\.ts:1:\d+: ERROR: Could not resolve "@acme\/missing-plugin" Fix the server definition, or host the server yourself\.$/su,
    );
    await expect(fs.readdir(lambdaDir)).resolves.toEqual([]);
  });

  it("offers the definition every export of @hot-updater/aws", async () => {
    const names = Object.keys(await import("@hot-updater/aws")).sort();
    const definition = path.join(project, "hotUpdater.ts");
    await fs.writeFile(
      definition,
      `import { ${names.join(", ")} } from "@hot-updater/aws";
import { createHotUpdater } from "@hot-updater/server";

export const imported = [${names.join(", ")}];
export default createHotUpdater({
  database: dynamoDB({ tableName: "the CLI's" }),
  storage: [s3Storage({ bucketName: "the CLI's" })],
  plugins,
});
`,
    );

    await buildLambdaFromDefinition({
      definition,
      packageRoot,
      projectRoot: project,
      lambdaDir,
    });

    expect(names).toEqual(
      expect.arrayContaining(["dynamoDB", "plugins", "s3Storage"]),
    );
  });
});
