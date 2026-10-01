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

vi.mock("@hot-updater/server/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/server/db")>()),
  provisionClientCredential: mocks.provisionClientCredential,
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    confirmInitInputPersistence: vi.fn(async () => false),
    makeEnv: vi.fn(),
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
    writeHotUpdaterFiles: vi.fn(async () => ({
      config: { status: "created" },
    })),
  };
});

import { InitError } from "@hot-updater/cli-tools";

import { getConfigScaffold } from "./configTemplate";
import { runInit } from "./index";

const packageRoot = path.resolve(import.meta.dirname, "..");

/** The definition init writes, with a plugin of the project's own. */
const withNotes = (text: string) =>
  text
    .replace(
      'import { createHotUpdater } from "@hot-updater/server";',
      `import { createHotUpdater } from "@hot-updater/server";
import { definePlugin, defineTable } from "@hot-updater/plugin-core";

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
        handler: async () => Response.json({ from: "the project's plugin" }),
      },
    ],
  }),
});`,
    )
    .replace("  plugins,\n", "  plugins: [...plugins, notes],\n");

/**
 * A project whose hotUpdater.ts is the one init writes with `edit` applied,
 * where the definition's packages resolve, as init's working directory.
 */
const project = async (edit: (text: string) => string) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-sb-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "app" }),
  );
  await fs.mkdir(path.join(root, "node_modules", "@hot-updater"), {
    recursive: true,
  });
  await fs.symlink(
    packageRoot,
    path.join(root, "node_modules", "@hot-updater", "supabase"),
  );
  await fs.symlink(
    path.join(packageRoot, "node_modules", "@hot-updater", "server"),
    path.join(root, "node_modules", "@hot-updater", "server"),
  );
  await fs.writeFile(
    path.join(root, "hotUpdater.ts"),
    edit(getConfigScaffold("bare").definition.text),
  );
  vi.spyOn(process, "cwd").mockReturnValue(root);
  return root;
};

let root: string | undefined;
let deployed: { bundle?: string; migrations?: string } = {};

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
        const workdir = args[args.indexOf("--workdir") + 1]!;
        deployed.bundle = await fs.readFile(
          path.join(
            workdir,
            "supabase",
            "functions",
            "hot-updater-v1",
            "hotUpdater.mjs",
          ),
          "utf-8",
        );
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
    deployed.migrations = (
      await Promise.all(
        (
          await fs.readdir(dir)
        ).map((file) => fs.readFile(path.join(dir, file), "utf-8")),
      )
    ).join("\n");
  });
  mocks.provisionClientCredential.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (root !== undefined) {
    await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

describe("Supabase init with the project's server definition", () => {
  it("refuses a definition on another bucket before it changes the project", async () => {
    root = await project((text) =>
      withNotes(text).replace(
        "bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!",
        'bucketName: "ota-prod"',
      ),
    );

    const initialization = runInit({
      build: "bare",
      envFile: ".env.hotupdater",
    });

    await expect(initialization).rejects.toBeInstanceOf(InitError);
    await expect(initialization).rejects.toThrow(
      "hotUpdater.ts: The managed Supabase server runs on bucketName bundles, which its setup made, but the server definition's supabaseStorage has bucketName ota-prod",
    );
    expect(mocks.api.createBucket).not.toHaveBeenCalled();
    expect(mocks.linkSupabase).not.toHaveBeenCalled();
    expect(mocks.pushDB).not.toHaveBeenCalled();
  });

  it("deploys the bundled definition and gives its plugins their tables, the credential, and the app setup", async () => {
    root = await project(withNotes);

    await runInit({ build: "bare", envFile: ".env.hotupdater" });

    expect(deployed.bundle).toContain("the project's plugin");
    // The package's migration holds core's tables; the plugins' follow it.
    expect(deployed.migrations).toContain("notes_notes");
    expect(deployed.migrations).toContain("'schema.insights'");
    const [, provisioned] = mocks.provisionClientCredential.mock.calls[0]!;
    expect((provisioned as { id: string }[]).map(({ id }) => id)).toEqual([
      "insights",
      "apiKeys",
      "notes",
    ]);
    expect(mocks.printAppSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        clientPlugins: [
          expect.objectContaining({
            module: "@hot-updater/react-native",
          }),
        ],
      }),
    );
    // The staged function is gone.
    await expect(fs.access(path.join(root, ".hot-updater"))).rejects.toThrow();
  });
});
