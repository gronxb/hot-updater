import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const api = {
    accounts: {
      list: vi.fn(),
    },
    d1: {
      database: {
        list: vi.fn(),
        query: vi.fn(),
      },
    },
    r2: {
      buckets: {
        domains: {
          managed: {
            list: vi.fn(),
          },
        },
        list: vi.fn(),
      },
    },
    workers: {
      scripts: {
        list: vi.fn(),
      },
      subdomains: {
        get: vi.fn(),
      },
    },
  };
  const credentialApi = {
    accounts: {
      list: vi.fn(),
      tokens: {
        verify: vi.fn(),
      },
    },
    d1: {
      database: {
        list: vi.fn(),
      },
    },
    r2: {
      buckets: {
        list: vi.fn(),
      },
    },
    user: {
      tokens: {
        verify: vi.fn(),
      },
    },
    workers: {
      subdomains: {
        get: vi.fn(),
      },
    },
  };

  return {
    api,
    credentialApi,
    confirm: vi.fn(),
    confirmInitInputPersistence: vi.fn(),
    createWrangler: vi.fn(),
    execa: vi.fn(),
    getWranglerLoginAuthToken: vi.fn(),
    inputSecrets: vi.fn(),
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
    readHotUpdaterInitEnv: vi.fn(),
    select: vi.fn(),
    writeHotUpdaterFiles: vi.fn(),
  };
});

vi.mock("execa", () => ({
  execa: mocks.execa,
}));

vi.mock("cloudflare", () => {
  const Cloudflare = vi.fn(function Cloudflare(options) {
    return options.apiToken === "wrangler-oauth-token"
      ? mocks.api
      : mocks.credentialApi;
  });
  return { Cloudflare, default: Cloudflare };
});

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();

  return {
    ...actual,
    confirmInitInputPersistence: mocks.confirmInitInputPersistence,
    // The managed server's plugins, over the D1 database init set up.
    provisionClientCredential: mocks.provisionClientCredential,
    writeHotUpdaterFiles: mocks.writeHotUpdaterFiles,
    makeEnv: mocks.makeEnv,
    printAppSetup: mocks.printAppSetup,
    p: {
      ...actual.p,
      confirm: mocks.confirm,
      log: mocks.log,
      select: mocks.select,
      tasks: vi.fn(async (tasks) => {
        for (const task of tasks) {
          await task.task();
        }
      }),
    },
    readHotUpdaterInitEnv: mocks.readHotUpdaterInitEnv,
  };
});

vi.mock("./cloudflareInitSecrets", () => ({
  inputCloudflareInitSecrets: mocks.inputSecrets,
}));

vi.mock("./getWranglerLoginAuthToken", () => ({
  getWranglerLoginAuthToken: mocks.getWranglerLoginAuthToken,
}));

vi.mock("../src/utils/createWrangler", () => ({
  createWrangler: mocks.createWrangler,
}));

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CloudflareAuthenticationError,
  CloudflareDeploymentError,
} from "./cloudflareInitErrors";
import { getConfigScaffold } from "./configTemplate";
import { runInit } from "./index";

describe("Cloudflare init discovery", () => {
  /** Init's working directory, where it stages the Worker it deploys. */
  let project: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    project = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-cf-"));
    await fs.writeFile(
      path.join(project, "package.json"),
      JSON.stringify({ name: "app" }),
    );
    vi.spyOn(process, "cwd").mockReturnValue(project);
    mocks.getWranglerLoginAuthToken.mockReturnValue({
      expiration_time: "2999-01-01T00:00:00.000Z",
      oauth_token: "wrangler-oauth-token",
    });
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: {},
      managedEnv: {},
    });
    mocks.confirmInitInputPersistence.mockResolvedValue(false);
    mocks.confirm.mockResolvedValue(true);
    mocks.select.mockImplementation(
      async ({ options }: { options: readonly { readonly value: string }[] }) =>
        options[0]?.value,
    );
    mocks.api.accounts.list.mockResolvedValue({
      result: [{ id: "account-id", name: "Account" }],
    });
    mocks.api.r2.buckets.list.mockResolvedValue({
      buckets: [{ name: "bundles" }],
    });
    mocks.api.r2.buckets.domains.managed.list.mockResolvedValue({
      enabled: false,
    });
    mocks.api.workers.subdomains.get.mockResolvedValue({
      subdomain: "example",
    });
    mocks.api.workers.scripts.list.mockResolvedValue({ result: [] });
    mocks.api.d1.database.query.mockResolvedValue({
      async *iterPages() {
        yield { result: [{ results: [] }] };
      },
    });
    mocks.inputSecrets.mockResolvedValue({
      accessKeyId: "access-key-id",
      apiToken: "api-token",
      secretAccessKey: "secret-access-key",
      workerName: "hot-updater",
    });
    mocks.credentialApi.user.tokens.verify.mockResolvedValue({
      status: "active",
    });
    mocks.credentialApi.accounts.tokens.verify.mockResolvedValue({
      status: "active",
    });
    mocks.credentialApi.d1.database.list.mockResolvedValue({ result: [] });
    mocks.credentialApi.r2.buckets.list.mockResolvedValue({ buckets: [] });
    mocks.credentialApi.workers.subdomains.get.mockResolvedValue({
      subdomain: "example",
    });
    mocks.createWrangler.mockResolvedValue(vi.fn());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(project, { recursive: true, force: true });
  });

  it("does not start Wrangler login during env-file replay", async () => {
    // Given
    mocks.getWranglerLoginAuthToken.mockReturnValue(null);
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: {
        HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID: "account-id",
        HOT_UPDATER_CLOUDFLARE_API_TOKEN: "api-token",
        HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID: "database-id",
        HOT_UPDATER_CLOUDFLARE_D1_DATABASE_NAME: "ota",
        HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID: "access-key-id",
        HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME: "bundles",
        HOT_UPDATER_CLOUDFLARE_R2_PRIVATE: "true",
        HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY: "secret-access-key",
        HOT_UPDATER_CLOUDFLARE_WORKER_NAME: "hot-updater",
      },
      managedEnv: {},
    });

    // When
    const initialization = runInit({
      build: "bare",
      envFile: ".env.hotupdater",
    });

    // Then
    await expect(initialization).rejects.toThrow("npx wrangler login");
    expect(mocks.execa).not.toHaveBeenCalled();
  });

  it("starts Wrangler login when interactive init has no saved session", async () => {
    // Given
    mocks.getWranglerLoginAuthToken.mockReturnValueOnce(null).mockReturnValue({
      expiration_time: "2999-01-01T00:00:00.000Z",
      oauth_token: "wrangler-oauth-token",
    });
    mocks.api.d1.database.list.mockResolvedValue({
      result: [{ name: "ota", uuid: "database-id" }],
    });
    mocks.api.d1.database.query.mockResolvedValue({
      async *iterPages() {
        yield { result: [{ results: [] }] };
      },
    });
    mocks.inputSecrets.mockRejectedValue(new Error("stop after login"));

    // When
    const initialization = runInit({ build: "bare" });

    // Then
    await expect(initialization).rejects.toThrow("stop after login");
    expect(mocks.execa).toHaveBeenCalledWith(
      "npx",
      expect.arrayContaining(["wrangler", "login"]),
      expect.objectContaining({
        cwd: process.cwd(),
      }),
    );
  });

  it("rejects conflicting D1 identifiers before collecting secrets", async () => {
    // Given
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: {
        HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID: "account-id",
        HOT_UPDATER_CLOUDFLARE_API_TOKEN: "api-token",
        HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID: "old-database-id",
        HOT_UPDATER_CLOUDFLARE_D1_DATABASE_NAME: "overridden-name",
        HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID: "access-key-id",
        HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME: "bundles",
        HOT_UPDATER_CLOUDFLARE_R2_PRIVATE: "true",
        HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY: "secret-access-key",
        HOT_UPDATER_CLOUDFLARE_WORKER_NAME: "hot-updater",
      },
      managedEnv: {},
    });
    mocks.api.d1.database.list.mockResolvedValue({
      result: [
        { name: "old-name", uuid: "old-database-id" },
        { name: "overridden-name", uuid: "different-database-id" },
      ],
    });
    mocks.inputSecrets.mockRejectedValue(new Error("reached secret input"));

    // When
    const initialization = runInit({
      build: "bare",
      envFile: ".env.hotupdater",
    });

    // Then
    await expect(initialization).rejects.toThrow(
      "Cloudflare D1 identifiers conflict",
    );
    expect(mocks.inputSecrets).not.toHaveBeenCalled();
  });

  it("uses an existing bucket's privacy as the interactive default", async () => {
    // Given
    mocks.api.d1.database.list.mockResolvedValue({
      result: [{ name: "ota", uuid: "database-id" }],
    });
    mocks.createWrangler.mockRejectedValue(
      new Error("stop after privacy selection"),
    );

    // When
    const initialization = runInit({ build: "bare" });

    // Then
    await expect(initialization).rejects.toBeInstanceOf(
      CloudflareDeploymentError,
    );
    expect(mocks.api.r2.buckets.domains.managed.list).toHaveBeenCalledWith(
      "bundles",
      { account_id: "account-id" },
    );
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: true,
      }),
    );
    expect(
      mocks.api.r2.buckets.domains.managed.list.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.api.d1.database.list.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("blocks a selected v0 D1 database before changing infrastructure", async () => {
    mocks.api.d1.database.list.mockResolvedValue({
      result: [{ name: "ota", uuid: "database-id" }],
    });
    mocks.api.d1.database.query.mockResolvedValue({
      async *iterPages() {
        yield { result: [{ results: [{ name: "bundles" }] }] };
      },
    });

    await expect(runInit({ build: "bare" })).rejects.toThrow(
      "Cloudflare v0 infrastructure was detected at D1 database ota",
    );

    expect(mocks.makeEnv).not.toHaveBeenCalled();
    expect(mocks.api.workers.subdomains.get).not.toHaveBeenCalled();
    expect(mocks.createWrangler).not.toHaveBeenCalled();
  });

  it("blocks an existing v0 Worker before changing infrastructure", async () => {
    mocks.api.d1.database.list.mockResolvedValue({
      result: [{ name: "ota", uuid: "database-id" }],
    });
    mocks.api.workers.scripts.list.mockResolvedValue({
      result: [{ id: "hot-updater" }],
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 404 }));

    await expect(runInit({ build: "bare" })).rejects.toThrow(
      "Cloudflare v0 infrastructure was detected at Worker hot-updater",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://hot-updater.example.workers.dev/version",
    );
    expect(mocks.makeEnv).not.toHaveBeenCalled();
    expect(mocks.createWrangler).not.toHaveBeenCalled();
  });

  it("prompts for saved interactive choices with those choices selected by default", async () => {
    // Given
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: {},
      managedEnv: {
        HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID: "account-id",
        HOT_UPDATER_CLOUDFLARE_API_TOKEN: "saved-api-token",
        HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID: "database-id",
        HOT_UPDATER_CLOUDFLARE_D1_DATABASE_NAME: "ota",
        HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID: "saved-access-key",
        HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME: "bundles",
        HOT_UPDATER_CLOUDFLARE_R2_PRIVATE: "true",
        HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY: "saved-secret-key",
        HOT_UPDATER_CLOUDFLARE_WORKER_NAME: "saved-worker",
      },
    });
    mocks.api.d1.database.list.mockResolvedValue({
      result: [{ name: "ota", uuid: "database-id" }],
    });
    mocks.createWrangler.mockRejectedValue(
      new Error("stop after interactive choices"),
    );

    // When
    const initialization = runInit({ build: "bare" });

    // Then
    await expect(initialization).rejects.toBeInstanceOf(
      CloudflareDeploymentError,
    );
    expect(mocks.select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "account-id",
        message: "Account List",
      }),
    );
    expect(mocks.select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "bundles",
        message: "R2 List",
      }),
    );
    expect(mocks.select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "database-id",
        message: "D1 List",
      }),
    );
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: true,
        message: "Make R2 bucket private?",
      }),
    );
  });

  it("validates an entered API token before persisting inputs", async () => {
    // Given
    mocks.api.d1.database.list.mockResolvedValue({
      result: [{ name: "ota", uuid: "database-id" }],
    });
    mocks.credentialApi.user.tokens.verify.mockRejectedValue(
      new Error("Invalid access token [code: 9109]"),
    );
    mocks.credentialApi.accounts.tokens.verify.mockRejectedValue(
      new Error("Authentication error [code: 10000]"),
    );

    // When
    const initialization = runInit({ build: "bare" });

    // Then
    await expect(initialization).rejects.toBeInstanceOf(
      CloudflareAuthenticationError,
    );
    expect(mocks.makeEnv).not.toHaveBeenCalled();
  });

  it("keeps using Wrangler OAuth for infrastructure after validating the database token", async () => {
    // Given
    const stopAtOAuthInfrastructureCall = new Error(
      "stop at OAuth infrastructure call",
    );
    mocks.api.d1.database.list.mockResolvedValue({
      result: [{ name: "ota", uuid: "database-id" }],
    });
    mocks.api.workers.subdomains.get.mockRejectedValue(
      stopAtOAuthInfrastructureCall,
    );
    mocks.credentialApi.workers.subdomains.get.mockRejectedValue(
      new Error("database token used for infrastructure"),
    );

    // When
    const initialization = runInit({ build: "bare" });

    // Then
    await expect(initialization).rejects.toBe(stopAtOAuthInfrastructureCall);
    expect(mocks.api.workers.subdomains.get).toHaveBeenCalledWith({
      account_id: "account-id",
    });
    expect(mocks.credentialApi.d1.database.list).toHaveBeenCalledWith({
      account_id: "account-id",
    });
    expect(mocks.credentialApi.r2.buckets.list).not.toHaveBeenCalled();
    expect(mocks.credentialApi.workers.subdomains.get).not.toHaveBeenCalled();
  });

  it("validates an account-owned token for the selected account without listing accounts", async () => {
    // Given
    const stopAfterTokenValidation = new Error("stop after token validation");
    mocks.api.d1.database.list.mockResolvedValue({
      result: [{ name: "ota", uuid: "database-id" }],
    });
    mocks.inputSecrets.mockResolvedValue({
      accessKeyId: "access-key-id",
      apiToken: "cfat_api-token",
      secretAccessKey: "secret-access-key",
      workerName: "hot-updater",
    });
    mocks.api.workers.subdomains.get.mockRejectedValue(
      stopAfterTokenValidation,
    );

    // When
    const initialization = runInit({ build: "bare" });

    // Then
    await expect(initialization).rejects.toBe(stopAfterTokenValidation);
    expect(mocks.credentialApi.accounts.tokens.verify).toHaveBeenCalledWith({
      account_id: "account-id",
    });
    expect(mocks.credentialApi.user.tokens.verify).not.toHaveBeenCalled();
    expect(mocks.credentialApi.accounts.list).not.toHaveBeenCalled();
  });

  it("passes Wrangler OAuth to Worker deployment", async () => {
    // Given
    mocks.api.d1.database.list.mockResolvedValue({
      result: [{ name: "ota", uuid: "database-id" }],
    });
    mocks.createWrangler.mockRejectedValue(
      new Error("stop before running Wrangler"),
    );

    // When
    const initialization = runInit({ build: "bare" });

    // Then
    await expect(initialization).rejects.toBeInstanceOf(
      CloudflareDeploymentError,
    );
    expect(mocks.createWrangler).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "account-id",
        cloudflareApiToken: "wrangler-oauth-token",
      }),
    );
  });

  it("identifies an invalid token loaded from an explicit env file", async () => {
    // Given
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: {
        HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID: "account-id",
        HOT_UPDATER_CLOUDFLARE_API_TOKEN: "api-token",
        HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID: "database-id",
        HOT_UPDATER_CLOUDFLARE_D1_DATABASE_NAME: "ota",
        HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID: "access-key-id",
        HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME: "bundles",
        HOT_UPDATER_CLOUDFLARE_R2_PRIVATE: "true",
        HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY: "secret-access-key",
        HOT_UPDATER_CLOUDFLARE_WORKER_NAME: "hot-updater",
      },
      managedEnv: {},
    });
    mocks.credentialApi.user.tokens.verify.mockRejectedValue(
      new Error("Authentication error [code: 10000]"),
    );
    mocks.credentialApi.accounts.tokens.verify.mockRejectedValue(
      new Error("Authentication error [code: 10000]"),
    );

    // When
    const initialization = runInit({
      build: "bare",
      envFile: ".env.hotupdater",
    });

    // Then
    await expect(initialization).rejects.toMatchObject({
      source: {
        envFile: ".env.hotupdater",
        kind: "env-file",
      },
    });
    expect(mocks.api.r2.buckets.list).toHaveBeenCalledWith({
      account_id: "account-id",
    });
    expect(mocks.credentialApi.r2.buckets.list).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("deploys the prebuilt Worker, then gives the app its credential through the package's plugins", async () => {
    // Given
    mocks.api.d1.database.list.mockResolvedValue({
      result: [{ name: "ota", uuid: "database-id" }],
    });
    const commands: string[][] = [];
    const deployed: {
      config?: Record<string, unknown>;
      migrations?: Record<string, string>;
    } = {};
    const secret = Object.assign(Promise.resolve({}), {
      stdin: { end: vi.fn() },
    });
    mocks.createWrangler.mockImplementation(({ cwd: workerRoot, stdio }) =>
      stdio === "pipe"
        ? (...args: string[]) => {
            commands.push(args);
            return secret;
          }
        : async (...args: string[]) => {
            commands.push(args);
            if (args[0] === "deploy") {
              const migrations = path.join(workerRoot, "migrations");
              deployed.config = JSON.parse(
                await fs.readFile(
                  path.join(workerRoot, "wrangler.json"),
                  "utf-8",
                ),
              );
              deployed.migrations = Object.fromEntries(
                await Promise.all(
                  (await fs.readdir(migrations)).map(async (file) => [
                    file,
                    await fs.readFile(path.join(migrations, file), "utf-8"),
                  ]),
                ),
              );
            }
            return {};
          },
    );
    const credential = {
      env: "HOT_UPDATER_API_KEY",
      header: "x-api-key",
      label: "API key",
      value: "app-api-key",
    };
    mocks.provisionClientCredential.mockResolvedValue(credential);

    // When
    await runInit({ build: "bare" });

    // Then
    expect(commands).toEqual([
      ["d1", "migrations", "apply", "ota", "--remote"],
      ["deploy", "--name", "hot-updater"],
      [
        "secret",
        "put",
        "STORAGE_DOWNLOAD_URL_SIGNING_KEY",
        "--name",
        "hot-updater",
      ],
    ]);
    // The prebuilt Worker on the resources init chose, and the package's
    // migration, which creates the tables of core and the Worker's plugins.
    expect(deployed.config).toMatchObject({
      main: "./dist/index.js",
      d1_databases: [
        { binding: "DB", database_id: "database-id", database_name: "ota" },
      ],
      r2_buckets: [{ binding: "BUCKET", bucket_name: "bundles" }],
      vars: { BUCKET_NAME: "bundles" },
    });
    expect(Object.keys(deployed.migrations ?? {})).toEqual([
      "0001_hot-updater_1.0.0.sql",
      "0002_hot-updater_1.0.0-rc.30.sql",
    ]);
    expect(deployed.migrations?.["0001_hot-updater_1.0.0.sql"]).toContain(
      "'schema.apiKeys'",
    );
    // The app's credential, through the package's plugins on that database.
    expect(mocks.provisionClientCredential).toHaveBeenCalledOnce();
    const [server, input] = mocks.provisionClientCredential.mock.calls[0] as [
      {
        readonly database: { readonly name: string };
        readonly plugins: readonly { readonly id: string }[];
      },
      unknown,
    ];
    expect(server.database.name).toBe("d1Database");
    expect(server.plugins.map(({ id }) => id)).toEqual(["insights", "apiKeys"]);
    expect(input).toEqual({ env: {}, name: "Cloudflare init" });
    expect(mocks.makeEnv).toHaveBeenLastCalledWith({
      HOT_UPDATER_API_KEY: "app-api-key",
    });
    expect(mocks.writeHotUpdaterFiles).toHaveBeenCalledWith(
      getConfigScaffold("bare"),
      { cwd: project, settings: "Cloudflare" },
    );
    expect(mocks.printAppSetup).toHaveBeenCalledWith({
      baseURL: "https://hot-updater.example.workers.dev",
      credential,
      clientPlugins: [
        { module: "@hot-updater/react-native", name: "insights" },
      ],
    });
    // The staged Worker is gone.
    await expect(
      fs.access(path.join(project, ".hot-updater")),
    ).rejects.toThrow();
  });
});
