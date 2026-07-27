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
  };
  const credentialApi = {
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
    inputSecrets: vi.fn(),
    log: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    makeEnv: vi.fn(),
    readHotUpdaterInitEnv: vi.fn(),
  };
});

vi.mock("cloudflare", () => ({
  Cloudflare: vi.fn(function Cloudflare(options) {
    return options.apiToken === "api-token" ? mocks.credentialApi : mocks.api;
  }),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();

  return {
    ...actual,
    makeEnv: mocks.makeEnv,
    p: {
      ...actual.p,
      confirm: mocks.confirm,
      log: mocks.log,
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

import { CloudflareAuthenticationError } from "./cloudflareInitErrors";
import { runInit } from "./index";

describe("Cloudflare init discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: {},
      managedEnv: {},
    });
    mocks.api.accounts.list.mockResolvedValue({
      result: [{ id: "account-id", name: "Account" }],
    });
    mocks.api.r2.buckets.list.mockResolvedValue({
      buckets: [{ name: "bundles" }],
    });
    mocks.api.r2.buckets.domains.managed.list.mockResolvedValue({
      enabled: false,
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
  });

  it("reuses an existing bucket's privacy after discovering it", async () => {
    // Given
    const stopAfterDiscovery = new Error("stop after discovery");
    mocks.api.d1.database.list.mockRejectedValue(stopAfterDiscovery);

    // When
    const initialization = runInit({ build: "bare" });

    // Then
    await expect(initialization).rejects.toBe(stopAfterDiscovery);
    expect(mocks.api.r2.buckets.domains.managed.list).toHaveBeenCalledWith(
      "bundles",
      { account_id: "account-id" },
    );
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(
      mocks.api.r2.buckets.domains.managed.list.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.api.d1.database.list.mock.invocationCallOrder[0] ?? Infinity,
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

    // When
    const initialization = runInit({ build: "bare" });

    // Then
    await expect(initialization).rejects.toBeInstanceOf(
      CloudflareAuthenticationError,
    );
    expect(mocks.makeEnv).not.toHaveBeenCalled();
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
    expect(mocks.api.r2.buckets.list).not.toHaveBeenCalled();
  });
});
