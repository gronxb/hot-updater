import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fromIni: vi.fn(),
  fromNodeProviderChain: vi.fn(),
  fromSSO: vi.fn(),
  group: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  execa: vi.fn(),
}));

vi.mock("@aws-sdk/credential-providers", () => ({
  fromIni: mocks.fromIni,
  fromNodeProviderChain: mocks.fromNodeProviderChain,
  fromSSO: mocks.fromSSO,
}));

vi.mock("execa", async (importOriginal) => {
  const actual = await importOriginal<typeof import("execa")>();
  return {
    ...actual,
    execa: mocks.execa,
  };
});

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
      password: mocks.password,
      select: mocks.select,
      text: mocks.text,
    },
  };
});

import { resolveAwsAuth } from "./awsAuth";

describe("resolveAwsAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses saved account credentials without prompting in non-interactive mode", async () => {
    // Given
    const existingEnv = {
      HOT_UPDATER_AWS_AUTH_MODE: "account",
      HOT_UPDATER_S3_ACCESS_KEY_ID: "saved-access-key",
      HOT_UPDATER_S3_SECRET_ACCESS_KEY: "saved-secret-key",
    };

    // When
    const auth = await resolveAwsAuth(existingEnv, true);

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

  it("prefills the saved access key without exposing the secret key", async () => {
    const results: Record<string, string | symbol | undefined> = {};
    mocks.text.mockResolvedValue("edited-access-key");
    mocks.group.mockImplementation(
      async (
        prompts: Record<
          string,
          (context: {
            results: Record<string, string | symbol | undefined>;
          }) => Promise<string | symbol | undefined>
        >,
      ) => {
        for (const name of [
          "mode",
          "profile",
          "accessKeyId",
          "secretAccessKey",
        ]) {
          results[name] = await prompts[name]?.({ results });
        }
        return results;
      },
    );

    const auth = await resolveAwsAuth({
      HOT_UPDATER_AWS_AUTH_MODE: "account",
      HOT_UPDATER_S3_ACCESS_KEY_ID: "saved-access-key",
      HOT_UPDATER_S3_SECRET_ACCESS_KEY: "saved-secret-key",
    });

    expect(mocks.text).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "saved-access-key",
        placeholder: "AKIA...",
      }),
    );
    expect(mocks.password).not.toHaveBeenCalled();
    expect(auth.credentials).toEqual({
      accessKeyId: "edited-access-key",
      secretAccessKey: "saved-secret-key",
    });
  });

  it("does not launch SSO login in non-interactive mode", async () => {
    // Given
    mocks.group.mockResolvedValue({
      accessKeyId: undefined,
      mode: "sso",
      profile: "company-sso",
      secretAccessKey: undefined,
    });
    mocks.fromSSO.mockReturnValue(async () => {
      throw new Error("SSO session expired");
    });

    // When
    const auth = resolveAwsAuth(
      {
        HOT_UPDATER_AWS_AUTH_MODE: "sso",
        HOT_UPDATER_AWS_PROFILE: "company-sso",
      },
      true,
    );

    // Then
    await expect(auth).rejects.toMatchObject({
      missingInputs: ["active AWS SSO session (`aws sso login`)"],
    });
    expect(mocks.execa).not.toHaveBeenCalled();
  });
});
