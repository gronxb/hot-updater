import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: {
    connectBlobStore: vi.fn(),
    createBlobStore: vi.fn(),
    createProject: vi.fn(),
    getProject: vi.fn(),
    getProjectEnvValue: vi.fn(),
    getUser: vi.fn(),
    hasProductionDeployment: vi.fn(),
    listBlobStores: vi.fn(),
    listProjectEnv: vi.fn(),
    listTeams: vi.fn(),
    setProductionEnv: vi.fn(),
  },
  assembleServer: vi.fn(),
  confirm: vi.fn(),
  confirmInitInputPersistence: vi.fn(),
  createVercelApi: vi.fn(),
  deployFunction: vi.fn(),
  dispose: vi.fn(),
  execa: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  makeEnv: vi.fn(),
  migratePostgres: vi.fn(),
  password: vi.fn(),
  postgres: vi.fn(),
  printAppSetup: vi.fn(),
  provisionClientCredential: vi.fn(),
  readHotUpdaterInitEnv: vi.fn(),
  readHotUpdaterTables: vi.fn(),
  resolveVercelToken: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  verifyFunction: vi.fn(),
  writeHotUpdaterFiles: vi.fn(),
}));

vi.mock("execa", () => ({ execa: mocks.execa }));
vi.mock("@hot-updater/postgres", () => ({ postgres: mocks.postgres }));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    assembleServer: mocks.assembleServer,
    confirmInitInputPersistence: mocks.confirmInitInputPersistence,
    makeEnv: mocks.makeEnv,
    p: {
      ...actual.p,
      confirm: mocks.confirm,
      isCancel: () => false,
      log: mocks.log,
      password: mocks.password,
      select: mocks.select,
      tasks: vi.fn(async (tasks: { task: () => Promise<unknown> }[]) => {
        for (const task of tasks) await task.task();
      }),
      text: mocks.text,
    },
    printAppSetup: mocks.printAppSetup,
    provisionClientCredential: mocks.provisionClientCredential,
    readHotUpdaterInitEnv: mocks.readHotUpdaterInitEnv,
    writeHotUpdaterFiles: mocks.writeHotUpdaterFiles,
  };
});
vi.mock("./vercelApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vercelApi")>()),
  createVercelApi: mocks.createVercelApi,
}));
vi.mock("./vercelAuth", () => ({
  resolveVercelToken: mocks.resolveVercelToken,
}));
vi.mock("./vercelDatabase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vercelDatabase")>()),
  migratePostgres: mocks.migratePostgres,
  readHotUpdaterTables: mocks.readHotUpdaterTables,
}));
vi.mock("./vercelFunction", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vercelFunction")>()),
  deployFunction: mocks.deployFunction,
  verifyFunction: mocks.verifyFunction,
}));

import { runInit } from "./index";
import { VercelApiError } from "./vercelApi";

const DATABASE_URL = "postgres://user:secret@db.example.com/neondb";
const BLOB_TOKEN = "vercel_blob_rw_Store1_secret";
const project = {
  id: "prj_1",
  name: "hot-updater",
  productionAliases: ["hot-updater.vercel.app"],
};

const replayEnv = {
  HOT_UPDATER_VERCEL_BLOB_ACCESS: "private",
  HOT_UPDATER_VERCEL_BLOB_STORE_NAME: "hot-updater-storage",
  HOT_UPDATER_VERCEL_DATABASE_URL: DATABASE_URL,
  HOT_UPDATER_VERCEL_PROJECT_NAME: "hot-updater",
  HOT_UPDATER_VERCEL_TEAM_ID: "team_1",
};

const givenInitEnv = (env: Record<string, string>) => {
  mocks.readHotUpdaterInitEnv.mockResolvedValue({ env, managedEnv: env });
};

/** The project env after connecting the store with init's prefix. */
const connectedEnv = [
  {
    id: "env_blob",
    key: "HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN",
    target: ["production"],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createVercelApi.mockReturnValue(mocks.api);
  mocks.api.getUser.mockResolvedValue({
    id: "user_1",
    teamsOnly: true,
    username: "octo",
  });
  mocks.resolveVercelToken.mockResolvedValue("vercel-token");
  mocks.confirmInitInputPersistence.mockResolvedValue(true);
  mocks.readHotUpdaterTables.mockResolvedValue([]);
  mocks.migratePostgres.mockResolvedValue("1.0.0");
  mocks.postgres.mockReturnValue({ dispose: mocks.dispose });
  mocks.assembleServer.mockReturnValue({ clientPlugins: [] });
  mocks.provisionClientCredential.mockResolvedValue({
    env: "HOT_UPDATER_API_KEY",
    header: "x-api-key",
    label: "API key",
    value: "hu_key",
  });
  mocks.api.getProject.mockImplementation(async (idOrName: string) =>
    idOrName === project.id ? project : undefined,
  );
  mocks.api.createProject.mockResolvedValue(project);
  mocks.api.listBlobStores.mockResolvedValue([]);
  mocks.api.createBlobStore.mockResolvedValue({ id: "store_Store1" });
  mocks.api.listProjectEnv.mockResolvedValue(connectedEnv);
  mocks.api.getProjectEnvValue.mockImplementation(
    async (_project: string, envId: string) =>
      envId === "env_blob" ? BLOB_TOKEN : DATABASE_URL,
  );
});

describe("Vercel init", () => {
  it("replays saved inputs: creates the project and Blob store, migrates, deploys, and writes the config", async () => {
    givenInitEnv(replayEnv);

    await runInit({ build: "bare", envFile: ".env.hotupdater" });

    expect(mocks.createVercelApi).toHaveBeenCalledWith({
      teamId: "team_1",
      token: "vercel-token",
    });
    expect(mocks.api.listTeams).not.toHaveBeenCalled();
    expect(mocks.api.createProject).toHaveBeenCalledWith("hot-updater");
    expect(mocks.api.createBlobStore).toHaveBeenCalledWith({
      access: "private",
      name: "hot-updater-storage",
    });
    expect(mocks.api.connectBlobStore).toHaveBeenCalledWith({
      envVarPrefix: "HOT_UPDATER_VERCEL_BLOB",
      projectId: "prj_1",
      storeId: "store_Store1",
    });
    expect(mocks.migratePostgres).toHaveBeenCalledWith(
      DATABASE_URL,
      expect.arrayContaining([
        expect.objectContaining({ id: "insights" }),
        expect.objectContaining({ id: "apiKeys" }),
        expect.objectContaining({ id: "remoteConfig" }),
      ]),
    );
    // The connection already added the token for production.
    expect(mocks.api.setProductionEnv.mock.calls).toEqual([
      ["prj_1", "HOT_UPDATER_VERCEL_DATABASE_URL", DATABASE_URL],
      ["prj_1", "HOT_UPDATER_VERCEL_BLOB_ACCESS", "private"],
    ]);
    expect(mocks.deployFunction).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "team_1",
        projectId: "prj_1",
        scope: "team_1",
        token: "vercel-token",
      }),
    );
    expect(mocks.verifyFunction).toHaveBeenCalledWith(
      "https://hot-updater.vercel.app",
    );
    expect(mocks.makeEnv).toHaveBeenCalledWith(
      expect.objectContaining({
        HOT_UPDATER_VERCEL_BLOB_ACCESS: "private",
        HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN: BLOB_TOKEN,
        HOT_UPDATER_VERCEL_BLOB_STORE_ID: "store_Store1",
        HOT_UPDATER_VERCEL_DATABASE_URL: DATABASE_URL,
        HOT_UPDATER_VERCEL_PROJECT_ID: "prj_1",
        HOT_UPDATER_VERCEL_TEAM_ID: "team_1",
      }),
    );
    expect(mocks.makeEnv).toHaveBeenCalledWith({
      HOT_UPDATER_API_KEY: "hu_key",
    });
    expect(mocks.dispose).toHaveBeenCalled();
    expect(mocks.writeHotUpdaterFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("vercelBlobStorage({"),
      }),
      expect.objectContaining({ settings: "Vercel" }),
    );
    expect(mocks.printAppSetup).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://hot-updater.vercel.app" }),
    );
    // Deploys after migrating: the Function answers 503 until the settings exist.
    expect(mocks.migratePostgres.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deployFunction.mock.invocationCallOrder[0]!,
    );
  });

  it("reuses an existing store's connection and copies its token for the Function", async () => {
    givenInitEnv(replayEnv);
    mocks.api.listBlobStores.mockResolvedValue([
      {
        access: "public",
        connections: [
          {
            environmentVariables: ["BLOB_READ_WRITE_TOKEN"],
            environments: ["production"],
            id: "spc_1",
            projectId: "prj_1",
          },
        ],
        id: "store_Store1",
        name: "hot-updater-storage",
        region: "iad1",
      },
    ]);
    mocks.api.getProject.mockResolvedValue(project);
    mocks.api.hasProductionDeployment.mockResolvedValue(false);
    mocks.api.listProjectEnv.mockResolvedValue([
      { id: "env_blob", key: "BLOB_READ_WRITE_TOKEN", target: ["production"] },
    ]);

    await runInit({ build: "bare", envFile: ".env.hotupdater" });

    expect(mocks.api.createProject).not.toHaveBeenCalled();
    expect(mocks.api.createBlobStore).not.toHaveBeenCalled();
    expect(mocks.api.connectBlobStore).not.toHaveBeenCalled();
    expect(mocks.api.setProductionEnv.mock.calls).toEqual([
      ["prj_1", "HOT_UPDATER_VERCEL_DATABASE_URL", DATABASE_URL],
      ["prj_1", "HOT_UPDATER_VERCEL_BLOB_ACCESS", "public"],
      ["prj_1", "HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN", BLOB_TOKEN],
    ]);
  });

  it("replaces a token the Function keeps for another store", async () => {
    givenInitEnv(replayEnv);
    mocks.api.listBlobStores.mockResolvedValue([
      {
        access: "private",
        connections: [
          {
            environmentVariables: ["BLOB_READ_WRITE_TOKEN"],
            environments: ["production"],
            id: "spc_1",
            projectId: "prj_1",
          },
        ],
        id: "store_Store1",
        name: "hot-updater-storage",
        region: "iad1",
      },
    ]);
    mocks.api.getProject.mockResolvedValue(project);
    mocks.api.hasProductionDeployment.mockResolvedValue(false);
    mocks.api.listProjectEnv.mockResolvedValue([
      { id: "env_blob", key: "BLOB_READ_WRITE_TOKEN", target: ["production"] },
      {
        id: "env_old",
        key: "HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN",
        target: ["production"],
      },
    ]);
    mocks.api.getProjectEnvValue.mockImplementation(
      async (_project: string, envId: string) =>
        envId === "env_old" ? "vercel_blob_rw_Old_secret" : BLOB_TOKEN,
    );

    await runInit({ build: "bare", envFile: ".env.hotupdater" });

    expect(mocks.api.setProductionEnv).toHaveBeenCalledWith(
      "prj_1",
      "HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN",
      BLOB_TOKEN,
    );
  });

  it("explains a token Vercel refuses to replace", async () => {
    givenInitEnv(replayEnv);
    mocks.api.listBlobStores.mockResolvedValue([
      {
        access: "private",
        connections: [
          {
            environmentVariables: ["BLOB_READ_WRITE_TOKEN"],
            environments: ["production"],
            id: "spc_1",
            projectId: "prj_1",
          },
        ],
        id: "store_Store1",
        name: "hot-updater-storage",
        region: "iad1",
      },
    ]);
    mocks.api.getProject.mockResolvedValue(project);
    mocks.api.hasProductionDeployment.mockResolvedValue(false);
    mocks.api.listProjectEnv.mockResolvedValue([
      { id: "env_blob", key: "BLOB_READ_WRITE_TOKEN", target: ["production"] },
      {
        id: "env_old",
        key: "HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN",
        target: ["production"],
      },
    ]);
    mocks.api.getProjectEnvValue.mockImplementation(
      async (_project: string, envId: string) =>
        envId === "env_old" ? "vercel_blob_rw_Old_secret" : BLOB_TOKEN,
    );
    mocks.api.setProductionEnv.mockImplementation(
      async (_project: string, key: string) => {
        if (key === "HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN") {
          throw new VercelApiError(400, "env_owned", "owned by a connection");
        }
      },
    );

    await expect(
      runInit({ build: "bare", envFile: ".env.hotupdater" }),
    ).rejects.toThrow("Disconnect the other store");
    expect(mocks.deployFunction).not.toHaveBeenCalled();
  });

  it("finds the saved project by its ID after a rename", async () => {
    givenInitEnv({ ...replayEnv, HOT_UPDATER_VERCEL_PROJECT_ID: "prj_1" });
    const renamed = { ...project, name: "ota-server" };
    mocks.api.getProject.mockImplementation(async (idOrName: string) =>
      idOrName === "prj_1" ? renamed : undefined,
    );

    await runInit({ build: "bare", envFile: ".env.hotupdater" });

    expect(mocks.api.getProject).toHaveBeenCalledWith("prj_1");
    expect(mocks.api.createProject).not.toHaveBeenCalled();
    expect(mocks.makeEnv).toHaveBeenCalledWith(
      expect.objectContaining({
        HOT_UPDATER_VERCEL_PROJECT_NAME: "ota-server",
      }),
    );
  });

  it("offers the database URL an earlier init set on the project", async () => {
    givenInitEnv({});
    mocks.api.listTeams.mockResolvedValue([
      { id: "team_1", name: "Team", slug: "team" },
    ]);
    mocks.api.listProjectEnv.mockResolvedValue([
      {
        id: "env_canonical",
        key: "HOT_UPDATER_VERCEL_DATABASE_URL",
        target: ["production"],
      },
      ...connectedEnv,
    ]);
    mocks.select
      .mockResolvedValueOnce("\0create")
      .mockImplementationOnce(
        async ({
          options,
        }: {
          options: { value: string; label: string }[];
        }) => {
          expect(options[0]?.label).toContain("by an earlier init");
          return "env_canonical";
        },
      );
    mocks.text
      .mockResolvedValueOnce("hot-updater")
      .mockResolvedValueOnce("hot-updater-storage");
    mocks.confirm.mockResolvedValueOnce(true);

    await runInit({ build: "bare" });

    expect(mocks.api.getProjectEnvValue).toHaveBeenCalledWith(
      "prj_1",
      "env_canonical",
    );
    expect(mocks.password).not.toHaveBeenCalled();
  });

  it("deploys to the personal account of a user Vercel has not moved to teams", async () => {
    givenInitEnv({});
    mocks.api.getUser.mockResolvedValue({
      id: "user_1",
      teamsOnly: false,
      username: "octo",
    });
    mocks.api.listTeams.mockResolvedValue([]);
    mocks.api.listProjectEnv.mockImplementation(async () => [
      { id: "env_db", key: "DATABASE_URL", target: ["production"] },
      ...connectedEnv,
    ]);
    mocks.select
      .mockResolvedValueOnce("\0create")
      .mockResolvedValueOnce("env_db");
    mocks.text
      .mockResolvedValueOnce("hot-updater")
      .mockResolvedValueOnce("hot-updater-storage");
    mocks.confirm.mockResolvedValueOnce(true);

    await runInit({ build: "bare" });

    // A personal account's API calls take no teamId.
    expect(mocks.createVercelApi).toHaveBeenLastCalledWith({
      token: "vercel-token",
    });
    expect(mocks.deployFunction).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "user_1", scope: "octo" }),
    );
    expect(mocks.makeEnv).toHaveBeenCalledWith(
      expect.objectContaining({ HOT_UPDATER_VERCEL_TEAM_ID: "user_1" }),
    );
  });

  it("replays a saved personal account", async () => {
    givenInitEnv({ ...replayEnv, HOT_UPDATER_VERCEL_TEAM_ID: "user_1" });

    await runInit({ build: "bare", envFile: ".env.hotupdater" });

    expect(mocks.api.listTeams).not.toHaveBeenCalled();
    expect(mocks.createVercelApi).toHaveBeenLastCalledWith({
      token: "vercel-token",
    });
    expect(mocks.deployFunction).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "user_1", scope: "octo" }),
    );
  });

  it("refuses a project that serves another app before changing anything", async () => {
    givenInitEnv(replayEnv);
    mocks.api.getProject.mockResolvedValue(project);
    mocks.api.hasProductionDeployment.mockResolvedValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>", { status: 200 })),
    );

    try {
      await expect(
        runInit({ build: "bare", envFile: ".env.hotupdater" }),
      ).rejects.toThrow("already serves another app");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(mocks.api.createBlobStore).not.toHaveBeenCalled();
    expect(mocks.makeEnv).not.toHaveBeenCalled();
    expect(mocks.deployFunction).not.toHaveBeenCalled();
  });

  it("stops on a Hot Updater v0 database before it creates the store", async () => {
    givenInitEnv(replayEnv);
    mocks.readHotUpdaterTables.mockResolvedValue(["bundles"]);

    await expect(
      runInit({ build: "bare", envFile: ".env.hotupdater" }),
    ).rejects.toThrow();
    expect(mocks.api.createBlobStore).not.toHaveBeenCalled();
    expect(mocks.migratePostgres).not.toHaveBeenCalled();
  });

  it("asks for each choice interactively and reads a connected database's URL", async () => {
    givenInitEnv({});
    mocks.api.listTeams.mockResolvedValue([
      { id: "team_1", name: "Team", slug: "team" },
      { id: "team_2", name: "Other", slug: "other" },
    ]);
    mocks.api.listProjectEnv.mockImplementation(async () => [
      { id: "env_db", key: "DATABASE_URL", target: ["production"] },
      ...(mocks.api.connectBlobStore.mock.calls.length > 0 ? connectedEnv : []),
    ]);
    mocks.select
      // Team
      .mockResolvedValueOnce("team_1")
      // Blob store: create a new one
      .mockResolvedValueOnce("\0create")
      // Database: the one connected to the project
      .mockResolvedValueOnce("env_db");
    mocks.text
      .mockResolvedValueOnce("hot-updater")
      .mockResolvedValueOnce("ota-bundles");
    mocks.confirm.mockResolvedValueOnce(false);

    await runInit({ build: "bare" });

    expect(mocks.api.createBlobStore).toHaveBeenCalledWith({
      access: "public",
      name: "ota-bundles",
    });
    expect(mocks.api.getProjectEnvValue).toHaveBeenCalledWith(
      "prj_1",
      "env_db",
    );
    expect(mocks.readHotUpdaterTables).toHaveBeenCalledWith(DATABASE_URL);
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.execa).not.toHaveBeenCalled();
  });

  it("creates a Neon database through the Vercel CLI and reads the URL it adds", async () => {
    givenInitEnv({});
    mocks.api.listTeams.mockResolvedValue([
      { id: "team_1", name: "Team", slug: "team" },
    ]);
    let neonCreated = false;
    mocks.execa.mockImplementation(async () => {
      neonCreated = true;
      return { exitCode: 0 };
    });
    mocks.api.listProjectEnv.mockImplementation(async () => [
      ...(neonCreated
        ? [{ id: "env_neon", key: "DATABASE_URL", target: ["production"] }]
        : []),
      ...connectedEnv,
    ]);
    mocks.select
      .mockResolvedValueOnce("\0create")
      .mockResolvedValueOnce("\0neon");
    mocks.text
      .mockResolvedValueOnce("hot-updater")
      .mockResolvedValueOnce("hot-updater-storage");
    mocks.confirm.mockResolvedValueOnce(true);

    await runInit({ build: "bare" });

    expect(mocks.execa).toHaveBeenCalledWith(
      "vercel",
      expect.arrayContaining([
        "integration",
        "add",
        "neon",
        "--scope",
        "team_1",
      ]),
      expect.objectContaining({
        env: {
          VERCEL_ORG_ID: "team_1",
          VERCEL_PROJECT_ID: "prj_1",
          VERCEL_TOKEN: "vercel-token",
        },
        // The CLI's skill files stay out of the app.
        cwd: expect.not.stringContaining(process.cwd()),
        localDir: process.cwd(),
        preferLocal: true,
      }),
    );
    expect(mocks.api.getProjectEnvValue).toHaveBeenCalledWith(
      "prj_1",
      "env_neon",
    );
  });

  it("explains a Neon database the Vercel CLI did not create", async () => {
    givenInitEnv({});
    mocks.api.listTeams.mockResolvedValue([
      { id: "team_1", name: "Team", slug: "team" },
    ]);
    mocks.execa.mockResolvedValue({ exitCode: 1 });
    mocks.select
      .mockResolvedValueOnce("\0create")
      .mockResolvedValueOnce("\0neon");
    mocks.text
      .mockResolvedValueOnce("hot-updater")
      .mockResolvedValueOnce("hot-updater-storage");
    mocks.confirm.mockResolvedValueOnce(true);

    await expect(runInit({ build: "bare" })).rejects.toThrow(
      "did not create the Neon database",
    );
    expect(mocks.api.createBlobStore).not.toHaveBeenCalled();
  });

  it("rejects a saved database URL that is not PostgreSQL before any change", async () => {
    givenInitEnv({
      ...replayEnv,
      HOT_UPDATER_VERCEL_DATABASE_URL: "mysql://db.example.com/app",
    });

    await expect(
      runInit({ build: "bare", envFile: ".env.hotupdater" }),
    ).rejects.toThrow("postgres:// or postgresql://");
    expect(mocks.api.createProject).not.toHaveBeenCalled();
  });
});
