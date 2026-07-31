import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const api = {
    accounts: {
      list: vi.fn(),
    },
    d1: {
      database: {
        list: vi.fn(),
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
    inputSecrets: vi.fn(),
    log: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    makeEnv: vi.fn(),
    readHotUpdaterInitEnv: vi.fn(),
    select: vi.fn(),
  };
});

vi.mock("cloudflare", () => ({
  Cloudflare: vi.fn(function Cloudflare(options) {
    return options.apiToken === "wrangler-oauth-token"
      ? mocks.api
      : mocks.credentialApi;
  }),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();

  return {
    ...actual,
    confirmInitInputPersistence: mocks.confirmInitInputPersistence,
    makeEnv: mocks.makeEnv,
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
  getWranglerLoginAuthToken: vi.fn(() => ({
    expiration_time: "2999-01-01T00:00:00.000Z",
    oauth_token: "wrangler-oauth-token",
  })),
}));

vi.mock("../src/utils/createWrangler", () => ({
  createWrangler: mocks.createWrangler,
}));

import {
  CloudflareAuthenticationError,
  CloudflareDeploymentError,
} from "./cloudflareInitErrors";
import { runInit } from "./index";

describe("Cloudflare init discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mocks.api.workers.subdomains.get.mockResolvedValue({});
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
    mocks.credentialApi.workers.subdomains.get.mockResolvedValue({});
    mocks.createWrangler.mockResolvedValue(vi.fn());
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
});
