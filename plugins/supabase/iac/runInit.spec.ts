import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: {
    createBucket: vi.fn(),
    getInfrastructureState: vi.fn(),
    listBuckets: vi.fn(),
  },
  createProject: vi.fn(),
  execa: vi.fn(),
  linkSupabase: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  makeEnv: vi.fn(),
  printAppSetup: vi.fn(),
  provisionClientCredential: vi.fn(),
  pushDB: vi.fn(),
}));

vi.mock("execa", async (importOriginal) => ({
  ...(await importOriginal<typeof import("execa")>()),
  execa: mocks.execa,
}));

vi.mock("./supabaseInitInputs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supabaseInitInputs")>()),
  assertSupabaseNonInteractiveInputs: vi.fn(),
  inputSupabaseDatabasePassword: vi.fn(async () => "database-password"),
  inputSupabaseDeploymentInputs: vi.fn(async () => ({
    accessToken: "access-token",
    functionName: "hot-updater-v1",
  })),
  resolveSupabaseInitInputs: vi.fn(() => ({
    bucketName: "bundles",
    projectId: "project-ref",
  })),
}));

vi.mock("./supabaseManagementApi", () => ({
  supabaseManagementApi: vi.fn(() => ({
    createProject: mocks.createProject,
    listFunctions: vi.fn(async () => []),
    listOrganizations: vi.fn(async () => []),
  })),
}));

vi.mock("./supabaseApi", () => ({
  supabaseApi: vi.fn(() => mocks.api),
}));

vi.mock("./supabaseInfrastructureState", () => ({
  assertSupabaseFunctionCanInitialize: vi.fn(),
  assertSupabaseInfrastructureCanInitialize: vi.fn(),
}));

vi.mock("./supabaseCli", () => ({
  confirmSupabaseDatabaseMigrations: vi.fn(async () => true),
  linkSupabase: mocks.linkSupabase,
  pushDB: mocks.pushDB,
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    confirmInitInputPersistence: vi.fn(async () => false),
    // The managed server's plugins, over the project's database.
    provisionClientCredential: mocks.provisionClientCredential,
    makeEnv: mocks.makeEnv,
    printAppSetup: mocks.printAppSetup,
    p: {
      ...actual.p,
      log: mocks.log,
      spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
      tasks: vi.fn(
        async (
          tasks: readonly {
            task: (message: (value: string) => void) => Promise<unknown>;
          }[],
        ) => {
          for (const task of tasks) await task.task(vi.fn());
        },
      ),
    },
    readHotUpdaterInitEnv: vi.fn(async () => ({
      env: {},
      inputEnv: {},
      managedEnv: {},
    })),
  };
});

import { runInit } from "./index";
import { inputSupabaseDeploymentInputs } from "./supabaseInitInputs";

const MIGRATION = "0001_hot-updater_1.0.0.sql";
const CREDENTIAL = {
  label: "API key",
  header: "x-api-key",
  env: "HOT_UPDATER_API_KEY",
  value: "the app's key",
};

/** A project with no Hot Updater files, as init's working directory. */
const project = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-sb-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "app" }),
  );
  vi.spyOn(process, "cwd").mockReturnValue(root);
  return root;
};

let root: string | undefined;
/** What init deployed: the Edge Function, and the migrations it pushed. */
let deployed: {
  function?: { index: string; imports: Record<string, string> };
  migrations?: Record<string, string>;
} = {};

beforeEach(() => {
  vi.clearAllMocks();
  deployed = {};
  mocks.execa.mockImplementation(
    async (_command: string, args: readonly string[] = []) => {
      if (args.includes("projects") && args.includes("list")) {
        return {
          stdout: JSON.stringify([
            { id: "project-ref", name: "App", region: "ap-northeast-2" },
          ]),
        };
      }
      if (args.includes("api-keys")) {
        return {
          stdout: JSON.stringify([
            { api_key: "service-role-key", name: "service_role" },
          ]),
        };
      }
      if (args.includes("deploy")) {
        const functionDir = path.join(
          args[args.indexOf("--workdir") + 1]!,
          "supabase",
          "functions",
          args[args.indexOf("deploy") + 1]!,
        );
        deployed.function = {
          index: await fs.readFile(path.join(functionDir, "index.ts"), "utf-8"),
          imports: JSON.parse(
            await fs.readFile(path.join(functionDir, "deno.json"), "utf-8"),
          ).imports,
        };
      }
      return { stdout: "" };
    },
  );
  mocks.api.listBuckets.mockResolvedValue([
    { id: "bundles", isPublic: false, name: "bundles" },
  ]);
  mocks.api.getInfrastructureState.mockResolvedValue("v1");
  mocks.pushDB.mockImplementation(async (workdir: string) => {
    const dir = path.join(workdir, "supabase", "migrations");
    deployed.migrations = Object.fromEntries(
      await Promise.all(
        (await fs.readdir(dir)).map(async (file) => [
          file,
          await fs.readFile(path.join(dir, file), "utf-8"),
        ]),
      ),
    );
  });
  mocks.provisionClientCredential.mockResolvedValue(CREDENTIAL);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (root !== undefined) {
    await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

describe("Supabase init", () => {
  it("deploys the prebuilt Edge Function on the bucket, with the import map of what it vendors", async () => {
    root = await project();

    await runInit({ build: "bare", envFile: ".env.hotupdater" });

    const { index, imports } = deployed.function!;
    expect(index).toContain('"bundles"');
    expect(index).toContain('"hot-updater-v1"');
    expect(index).not.toContain("HotUpdater.");
    expect(imports).toMatchObject({
      "@hot-updater/server": "./_hot-updater/hot-updater-server/dist/index.mjs",
      "@hot-updater/supabase/edge":
        "./_hot-updater/hot-updater-supabase/dist/edge.mjs",
    });
    // The staged function is gone.
    await expect(fs.access(path.join(root, ".hot-updater"))).rejects.toThrow();
  });

  it("pushes the package's migration alone, which holds the managed plugins' tables", async () => {
    root = await project();

    await runInit({ build: "bare", envFile: ".env.hotupdater" });

    expect(deployed.migrations).toEqual({
      [MIGRATION]: await fs.readFile(
        path.resolve(import.meta.dirname, "../supabase/migrations", MIGRATION),
        "utf-8",
      ),
    });
    expect(deployed.migrations![MIGRATION]).toContain("'schema.insights'");
    expect(deployed.migrations![MIGRATION]).toContain("'schema.apiKeys'");
  });

  it("gives the app its credential and client plugins through the managed server's plugins", async () => {
    root = await project();

    await runInit({ build: "bare", envFile: ".env.hotupdater" });

    const [server, input] = mocks.provisionClientCredential.mock.calls[0]!;
    expect(
      (server as { plugins: { id: string }[] }).plugins.map(({ id }) => id),
    ).toEqual(["insights", "apiKeys", "remoteConfig"]);
    expect((server as { api: Record<string, unknown> }).api).toHaveProperty(
      "apiKeys",
    );
    expect(input).toMatchObject({ name: "Supabase init" });
    expect(mocks.makeEnv).toHaveBeenCalledWith({
      [CREDENTIAL.env]: CREDENTIAL.value,
    });
    expect(mocks.printAppSetup).toHaveBeenCalledWith({
      baseURL: "https://project-ref.supabase.co/functions/v1/hot-updater-v1",
      credential: CREDENTIAL,
      clientPlugins: [
        expect.objectContaining({ module: "@hot-updater/react-native" }),
      ],
    });
  });

  it("writes hot-updater.config.ts with the provider's plugins, and no server code", async () => {
    root = await project();

    await runInit({ build: "bare", envFile: ".env.hotupdater" });

    expect((await fs.readdir(root)).sort()).toEqual([
      "hot-updater.config.ts",
      "package.json",
    ]);
    const config = await fs.readFile(
      path.join(root, "hot-updater.config.ts"),
      "utf-8",
    );
    expect(config).toContain(
      'import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";',
    );
    expect(config).toContain(
      'import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";',
    );
    expect(config).toContain(
      "  plugins: [apiKeys(), insights(), remoteConfig()],\n",
    );
    expect(config).not.toContain("createHotUpdater");
  });

  it("stops before it changes the project when the function cannot be staged", async () => {
    root = await project();
    vi.mocked(inputSupabaseDeploymentInputs).mockResolvedValueOnce({
      accessToken: "access-token",
      functionName: "1-invalid",
    });

    await expect(
      runInit({ build: "bare", envFile: ".env.hotupdater" }),
    ).rejects.toThrow("Invalid Supabase Edge Function name.");
    expect(mocks.makeEnv).not.toHaveBeenCalled();
    expect(mocks.api.createBucket).not.toHaveBeenCalled();
    expect(mocks.linkSupabase).not.toHaveBeenCalled();
    expect(mocks.pushDB).not.toHaveBeenCalled();
    await expect(fs.access(path.join(root, ".hot-updater"))).rejects.toThrow();
  });
});
