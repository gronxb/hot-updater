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
    writeHotUpdaterFiles: vi.fn(),
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

vi.mock("@hot-updater/server/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/server/db")>()),
  provisionClientCredential: mocks.provisionClientCredential,
}));

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { InitError } from "@hot-updater/cli-tools";

import {
  CloudflareAuthenticationError,
  CloudflareDeploymentError,
} from "./cloudflareInitErrors";
import { getConfigScaffold } from "./configTemplate";
import { runInit } from "./index";

const packageRoot = path.resolve(import.meta.dirname, "..");

/** A plugin a project adds to the definition init wrote. */
const NOTES_PLUGIN = `
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
});
`;

/**
 * A project whose hotUpdater.ts is the one init writes with `edit` applied,
 * where the definition's packages resolve, as init's working directory.
 */
const editedProject = async (edit: (text: string) => string) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-cf-"));
  await fs.writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ name: "app" }),
  );
  await fs.mkdir(path.join(project, "node_modules", "@hot-updater"), {
    recursive: true,
  });
  await fs.symlink(
    packageRoot,
    path.join(project, "node_modules", "@hot-updater", "cloudflare"),
  );
  await fs.symlink(
    path.join(packageRoot, "node_modules", "@hot-updater", "server"),
    path.join(project, "node_modules", "@hot-updater", "server"),
  );
  await fs.writeFile(
    path.join(project, "hotUpdater.ts"),
    edit(getConfigScaffold("bare").definition.text),
  );
  vi.spyOn(process, "cwd").mockReturnValue(project);
  return project;
};

const withNotes = (text: string) =>
  text
    .replace(
      'import { createHotUpdater } from "@hot-updater/server";',
      'import { createHotUpdater } from "@hot-updater/server";\nimport { definePlugin, defineTable } from "@hot-updater/server/plugins";\n' +
        NOTES_PLUGIN,
    )
    .replace("  plugins,\n", "  plugins: [...plugins, notes],\n");

describe("Cloudflare init discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  describe("with the project's edited server definition", () => {
    let project: string | undefined;

    beforeEach(() => {
      mocks.api.d1.database.list.mockResolvedValue({
        result: [{ name: "ota", uuid: "database-id" }],
      });
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      if (project !== undefined) {
        await fs.rm(project, { recursive: true, force: true });
        project = undefined;
      }
    });

    it("refuses a definition on another bucket before it deploys anything", async () => {
      project = await editedProject((text) =>
        withNotes(text).replace(
          "bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!",
          'bucketName: "ota-prod"',
        ),
      );

      const initialization = runInit({ build: "bare" });

      await expect(initialization).rejects.toBeInstanceOf(InitError);
      await expect(initialization).rejects.toThrow(
        "hotUpdater.ts: The managed Cloudflare server runs on bucketName bundles, which its setup made, but the server definition's r2Storage has bucketName ota-prod",
      );
      expect(mocks.createWrangler).not.toHaveBeenCalled();
      expect(mocks.provisionClientCredential).not.toHaveBeenCalled();
    });

    it("refuses a definition on another database before it deploys anything", async () => {
      project = await editedProject((text) =>
        text
          .replace(
            'import { createHotUpdater } from "@hot-updater/server";',
            'import { createHotUpdater } from "@hot-updater/server";\nimport { createMemoryAdapter } from "@hot-updater/plugin-core/internal";',
          )
          .replace(
            /database: d1Database\(\{[^}]*\}\),/su,
            'database: { name: "memory", adapter: createMemoryAdapter() },',
          ),
      );
      await fs.symlink(
        path.join(packageRoot, "node_modules", "@hot-updater", "plugin-core"),
        path.join(project, "node_modules", "@hot-updater", "plugin-core"),
      );

      const initialization = runInit({ build: "bare" });

      await expect(initialization).rejects.toThrow(
        "hotUpdater.ts: The managed Cloudflare server runs on d1Database, but the server definition's database is memory.",
      );
      expect(mocks.createWrangler).not.toHaveBeenCalled();
    });

    it("deploys the bundled definition and gives its plugins their tables, the credential, and the app setup", async () => {
      project = await editedProject(withNotes);
      const deployed: { main?: string; bundle?: string; migrations?: string } =
        {};
      const wrangler = vi.fn(async (...args: string[]) => {
        const workerRoot = path.join(project!, ".hot-updater", "worker");
        if (args.join(" ").startsWith("d1 migrations apply")) {
          const files = await fs.readdir(path.join(workerRoot, "migrations"));
          deployed.migrations = (
            await Promise.all(
              files.map((file) =>
                fs.readFile(path.join(workerRoot, "migrations", file), "utf-8"),
              ),
            )
          ).join("\n");
        }
        if (args[0] === "deploy") {
          deployed.main = JSON.parse(
            await fs.readFile(path.join(workerRoot, "wrangler.json"), "utf-8"),
          ).main;
          deployed.bundle = await fs.readFile(
            path.join(workerRoot, "dist", "managed.js"),
            "utf-8",
          );
        }
        return {};
      });
      const secret = Object.assign(Promise.resolve({}), {
        stdin: { end: vi.fn() },
      });
      mocks.createWrangler.mockImplementation(({ stdio }) =>
        stdio === "pipe" ? () => secret : wrangler,
      );
      mocks.provisionClientCredential.mockResolvedValue(undefined);

      await runInit({ build: "bare" });

      expect(deployed.main).toBe("./dist/managed.js");
      expect(deployed.bundle).toContain("the project's plugin");
      // The package's plugins and the project's get their tables.
      expect(deployed.migrations).toContain('"notes_notes"');
      expect(deployed.migrations).toContain("'schema.insights'");
      const [, serverPlugins] =
        mocks.provisionClientCredential.mock.calls[0] ?? [];
      expect(
        (serverPlugins as readonly { id: string }[]).map(({ id }) => id),
      ).toEqual(["insights", "apiKeys", "notes"]);
      expect(mocks.printAppSetup).toHaveBeenCalledWith(
        expect.objectContaining({
          clientPlugins: [
            expect.objectContaining({
              module: "@hot-updater/react-native/plugins/insights",
            }),
          ],
        }),
      );
      // The staged Worker is gone.
      await expect(
        fs.access(path.join(project, ".hot-updater")),
      ).rejects.toThrow();
    });
  });
});
