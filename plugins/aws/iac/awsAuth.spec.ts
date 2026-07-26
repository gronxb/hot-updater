import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fromIni: vi.fn(),
  fromNodeProviderChain: vi.fn(),
  fromSSO: vi.fn(),
  group: vi.fn(),
  select: vi.fn(),
}));

vi.mock("@aws-sdk/credential-providers", () => ({
  fromIni: mocks.fromIni,
  fromNodeProviderChain: mocks.fromNodeProviderChain,
  fromSSO: mocks.fromSSO,
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    getHotUpdaterEnvValue: (
      env: Readonly<Record<string, string>>,
      key: string,
    ) => env[key],
    p: {
      ...actual.p,
      group: mocks.group,
      select: mocks.select,
    },
  };
});

import { resolveAwsAuth } from "./awsAuth";

describe("resolveAwsAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses saved account credentials without prompting", async () => {
    // Given
    const existingEnv = {
      HOT_UPDATER_AWS_AUTH_MODE: "account",
      HOT_UPDATER_S3_ACCESS_KEY_ID: "saved-access-key",
      HOT_UPDATER_S3_SECRET_ACCESS_KEY: "saved-secret-key",
    };

    // When
    const auth = await resolveAwsAuth(existingEnv);

    // Then
    expect(auth).toEqual({
      awsProfile: null,
      configAuthMode: { mode: "account" },
      credentials: {
        accessKeyId: "saved-access-key",
        secretAccessKey: "saved-secret-key",
      },
      mode: "account",
    });
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.group).not.toHaveBeenCalled();
  });
});
