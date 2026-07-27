import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const workspaceRoot = path.resolve(import.meta.dirname, "../../../..");
const typescriptCli = path.join(
  workspaceRoot,
  "node_modules",
  "typescript",
  "bin",
  "tsc",
);
const packageLinks = [
  ["core", "packages/core"],
  ["test-utils", "packages/test-utils"],
  ["aws", "plugins/aws"],
  ["cloudflare", "plugins/cloudflare"],
  ["firebase", "plugins/firebase"],
  ["plugin-core", "plugins/plugin-core"],
  ["supabase", "plugins/supabase"],
] as const;
let fixtureDirectory: string;

const passSource = `
import { env, secret, binding } from "@hot-updater/core/config";
import { s3Storage as legacyS3Storage } from "@hot-updater/aws";
import { s3Storage as nodeS3Storage } from "@hot-updater/aws/storage/node";
import { createLambdaStorageContext, s3Storage as lambdaS3Storage } from "@hot-updater/aws/storage/lambda";
import { r2Storage as legacyR2Storage } from "@hot-updater/cloudflare";
import { r2Storage as nodeR2Storage } from "@hot-updater/cloudflare/storage/node";
import { createWorkerStorageContext, r2Storage as workerR2Storage } from "@hot-updater/cloudflare/storage/worker";
import { firebaseStorage as legacyFirebaseStorage } from "@hot-updater/firebase";
import { firebaseStorage as nodeFirebaseStorage } from "@hot-updater/firebase/storage/node";
import { createFunctionsStorageContext, firebaseStorage as functionsFirebaseStorage } from "@hot-updater/firebase/storage/functions";
import { supabaseStorage as legacySupabaseStorage } from "@hot-updater/supabase";
import { supabaseStorage as nodeSupabaseStorage } from "@hot-updater/supabase/storage/node";
import { createEdgeStorageContext, supabaseStorage as edgeSupabaseStorage } from "@hot-updater/supabase/storage/edge";
import { createStoragePlugin, type StoragePluginImplementation } from "@hot-updater/plugin-core/storage";
import { createNodeStorageContext } from "@hot-updater/plugin-core/storage/node";
import { setupStoragePluginTestSuite } from "@hot-updater/test-utils";

const implementation: StoragePluginImplementation = {
  async put() {
    return { kind: "stored", storageUri: "docs://bucket/object" };
  },
  async head() {
    return { kind: "not-found" };
  },
  async get() {
    return { kind: "not-found" };
  },
  async delete() {
    return { kind: "not-found" };
  },
};
const customStorage = () =>
  createStoragePlugin({ name: "docsStorage", protocol: "docs", plugin: () => implementation });
const awsConfig = {
  region: env("AWS_REGION"),
  bucketName: env("AWS_BUCKET"),
  credentials: {
    accessKeyId: secret("AWS_ACCESS_KEY_ID"),
    secretAccessKey: secret("AWS_SECRET_ACCESS_KEY"),
  },
  delivery: { type: "presigned" as const },
};
const firebaseConfig = {
  projectId: env("FIREBASE_PROJECT_ID"),
  storageBucket: env("FIREBASE_STORAGE_BUCKET"),
};
const supabaseConfig = {
  supabaseUrl: env("SUPABASE_URL"),
  supabaseServiceRoleKey: secret("SUPABASE_SERVICE_ROLE_KEY"),
  bucketName: env("SUPABASE_BUCKET"),
};
const plugins = [
  nodeS3Storage(awsConfig),
  lambdaS3Storage(awsConfig),
  nodeR2Storage({
    accountId: env("CLOUDFLARE_ACCOUNT_ID"),
    bucketName: env("R2_BUCKET"),
    credentials: { accessKeyId: secret("R2_ACCESS_KEY_ID"), secretAccessKey: secret("R2_SECRET_ACCESS_KEY") },
  }),
  workerR2Storage({ bucket: binding("BUNDLES"), bucketName: env("R2_BUCKET") }),
  nodeFirebaseStorage(firebaseConfig),
  functionsFirebaseStorage(firebaseConfig),
  nodeSupabaseStorage(supabaseConfig),
  edgeSupabaseStorage(supabaseConfig),
  customStorage(),
];
const legacyPlugins = [
  legacyS3Storage({ region: "us-east-1", bucketName: "bucket" }),
  legacyR2Storage({ accountId: "account", bucketName: "bucket", credentials: { accessKeyId: "access", secretAccessKey: "secret" } }),
  legacyFirebaseStorage({ projectId: "project", storageBucket: "bucket" }),
  legacySupabaseStorage({ supabaseUrl: "https://example.supabase.co", supabaseServiceRoleKey: "key", bucketName: "bucket" }),
];
const nodeContext = createNodeStorageContext({ environment: {} });
setupStoragePluginTestSuite({
  name: "documented custom storage",
  context: nodeContext,
  createPlugin: customStorage,
});
void [
  plugins,
  legacyPlugins,
  createLambdaStorageContext({ environment: {}, bindings: {} }),
  createWorkerStorageContext({ environment: {}, bindings: {} }),
  createFunctionsStorageContext({ environment: {}, bindings: {} }),
  createEdgeStorageContext({ target: "edge", environment: {} }),
];
`;

const secondThunkSource = `
import { r2Storage } from "@hot-updater/cloudflare/storage/node";
const config = {
  accountId: "account",
  bucketName: "bucket",
  credentials: { accessKeyId: "access", secretAccessKey: "secret" },
};
const invalidStorage = r2Storage(config)();
void invalidStorage;
`;

const liveViteSource = `
import { r2Storage } from "@hot-updater/cloudflare/storage/node";
type ConsoleViteOptions = Readonly<{
  configFile: URL;
  runtimeEntry?: URL;
}>;
declare const hotUpdaterConsole: (options: ConsoleViteOptions) => void;
hotUpdaterConsole({
  configFile: new URL("./hot-updater.config.ts", import.meta.url),
  storage: r2Storage({
    accountId: "account",
    bucketName: "bucket",
    credentials: { accessKeyId: "access", secretAccessKey: "secret" },
  }),
});
`;

const compile = (file: string) =>
  spawnSync(
    process.execPath,
    [typescriptCli, "--project", path.join(fixtureDirectory, `${file}.json`)],
    { cwd: workspaceRoot, encoding: "utf8" },
  );

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(
    path.join(workspaceRoot, ".storage-docs-fixture-"),
  );
  const packageScope = path.join(
    fixtureDirectory,
    "node_modules",
    "@hot-updater",
  );
  const typeScope = path.join(fixtureDirectory, "node_modules", "@types");
  await Promise.all([
    mkdir(packageScope, { recursive: true }),
    mkdir(typeScope, { recursive: true }),
  ]);
  await Promise.all([
    ...packageLinks.map(([name, source]) =>
      symlink(
        path.join(workspaceRoot, source),
        path.join(packageScope, name),
        "dir",
      ),
    ),
    symlink(
      path.join(workspaceRoot, "packages/test-utils/node_modules/@types/node"),
      path.join(typeScope, "node"),
      "dir",
    ),
  ]);
  const sources = [
    ["pass.mts", passSource],
    ["second-thunk.mts", secondThunkSource],
    ["live-vite.mts", liveViteSource],
  ] as const;
  await Promise.all(
    sources.flatMap(([file, source]) => [
      writeFile(path.join(fixtureDirectory, file), source),
      writeFile(
        path.join(fixtureDirectory, `${file}.json`),
        JSON.stringify({
          compilerOptions: {
            baseUrl: workspaceRoot,
            exactOptionalPropertyTypes: true,
            ignoreDeprecations: "6.0",
            lib: ["ES2022", "DOM"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            noUncheckedIndexedAccess: true,
            skipLibCheck: true,
            strict: true,
            target: "ES2022",
            types: ["node"],
            verbatimModuleSyntax: true,
          },
          files: [path.join(fixtureDirectory, file)],
        }),
      ),
    ]),
  );
});

afterAll(async () => {
  await rm(fixtureDirectory, { force: true, recursive: true });
});

describe("Storage v2 documentation examples", () => {
  it("compiles direct providers, target entries, contexts, and conformance setup", () => {
    const result = compile("pass.mts");
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it("rejects second-thunk and live Vite plugin examples", () => {
    const secondThunk = compile("second-thunk.mts");
    const liveVite = compile("live-vite.mts");
    const secondThunkOutput = `${secondThunk.stdout}${secondThunk.stderr}`;
    const liveViteOutput = `${liveVite.stdout}${liveVite.stderr}`;

    expect(secondThunk.status).not.toBe(0);
    expect(secondThunkOutput).toContain("TS2349");
    expect(liveVite.status).not.toBe(0);
    expect(liveViteOutput).toContain("TS2353");
    expect(liveViteOutput).toContain("storage");
  });
});
