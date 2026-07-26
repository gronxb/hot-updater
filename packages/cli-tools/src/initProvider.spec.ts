import { afterEach, describe, expect, it, vi } from "vitest";

import { MissingInitInputsError } from "./initOptions";
import {
  assertInitProviderInputs,
  confirmInitInputPersistence,
  defineInitProvider,
  getMissingInitProviderInputs,
  getInitProviderEnvVars,
  INIT_PROVIDER_DEFINITIONS,
  INIT_PROVIDER_NAMES,
  isInitProvider,
  resolveInitProviderInputs,
} from "./initProvider";
import { p } from "./prompts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("init provider registry", () => {
  it("derives provider guards from the declared registry", () => {
    // Given
    const declaredProviders = ["cloudflare", "aws", "supabase", "firebase"];

    // When
    const results = declaredProviders.map(isInitProvider);

    // Then
    expect(INIT_PROVIDER_NAMES).toEqual(declaredProviders);
    expect(results).toEqual([true, true, true, true]);
    expect(isInitProvider("unknown")).toBe(false);
    expect(isInitProvider(undefined)).toBe(false);
  });

  it("validates AWS auth mode and region through its declaration", () => {
    const provider = INIT_PROVIDER_DEFINITIONS.aws;
    const inputs = resolveInitProviderInputs(
      {
        HOT_UPDATER_AWS_AUTH_MODE: "invalid",
        HOT_UPDATER_AWS_LAMBDA_NAME: "hot-updater-edge",
        HOT_UPDATER_AWS_MIGRATION_APPROVED: "true",
        HOT_UPDATER_S3_BUCKET_NAME: "updates",
        HOT_UPDATER_S3_REGION: "not-a-region",
      },
      provider,
    );

    expect(getMissingInitProviderInputs({ inputs, provider })).toEqual([
      "HOT_UPDATER_AWS_AUTH_MODE",
      "HOT_UPDATER_S3_REGION",
    ]);
  });
});

describe("confirmInitInputPersistence", () => {
  const provider = defineInitProvider({
    label: "Test",
    inputs: {
      credential: {
        envKey: "TEST_CREDENTIAL",
        help: "Credential",
        persistence: "with-consent",
      },
    },
  });

  it("asks once before persisting a newly entered credential", async () => {
    const confirm = vi.spyOn(p, "confirm").mockResolvedValue(true);

    await expect(
      confirmInitInputPersistence({
        existingEnv: {},
        inputs: { credential: "secret" },
        nonInteractive: false,
        provider,
      }),
    ).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("does not ask again for a credential already in the managed env", async () => {
    const confirm = vi.spyOn(p, "confirm");

    await expect(
      confirmInitInputPersistence({
        existingEnv: { TEST_CREDENTIAL: "secret" },
        inputs: { credential: "secret" },
        nonInteractive: false,
        provider,
      }),
    ).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not persist a new credential during prompt-free replay", async () => {
    const confirm = vi.spyOn(p, "confirm");

    await expect(
      confirmInitInputPersistence({
        existingEnv: {},
        inputs: { credential: "secret" },
        nonInteractive: true,
        provider,
      }),
    ).resolves.toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("keeps a credential already stored in the managed env during replay", async () => {
    const confirm = vi.spyOn(p, "confirm");

    await expect(
      confirmInitInputPersistence({
        existingEnv: { TEST_CREDENTIAL: "secret" },
        inputs: { credential: "secret" },
        nonInteractive: true,
        provider,
      }),
    ).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("assertInitProviderInputs", () => {
  const provider = defineInitProvider({
    label: "Test",
    inputs: {
      authMode: {
        envKey: "TEST_AUTH_MODE",
        help: "Authentication mode",
      },
      accessKey: {
        envKey: "TEST_ACCESS_KEY",
        help: "Access key",
        requiredWhen: (inputs) => inputs.authMode === "account",
        requirementHint: "required for account auth",
      },
      token: {
        envKey: "TEST_TOKEN",
        help: "Optional token",
        optional: true,
      },
    },
  });

  it("reports required and active conditional inputs in declaration order", () => {
    // Given
    const inputs = {
      authMode: "account",
      accessKey: undefined,
      token: undefined,
    };

    // When
    const assertInputs = () =>
      assertInitProviderInputs({
        provider,
        inputs,
        strict: true,
      });

    // Then
    expect(assertInputs).toThrow(MissingInitInputsError);
    expect(assertInputs).toThrow(
      expect.objectContaining({
        missingInputs: ["TEST_ACCESS_KEY"],
      }),
    );
  });

  it("ignores optional and inactive conditional inputs", () => {
    expect(() =>
      assertInitProviderInputs({
        provider,
        inputs: {
          authMode: "local-session",
          accessKey: undefined,
          token: undefined,
        },
        strict: true,
      }),
    ).not.toThrow();
  });

  it("resolves and reports missing inputs through the declaration", () => {
    const env = {
      TEST_AUTH_MODE: "account",
      TEST_TOKEN: "optional",
    };
    const inputs = resolveInitProviderInputs(env, provider);

    expect(inputs).toEqual({
      accessKey: undefined,
      authMode: "account",
      token: "optional",
    });
    expect(getMissingInitProviderInputs({ inputs, provider })).toEqual([
      "TEST_ACCESS_KEY",
    ]);
  });

  it("only includes consent-protected inputs after approval", () => {
    const providerWithCredential = defineInitProvider({
      label: "Test",
      inputs: {
        resourceName: {
          envKey: "TEST_RESOURCE_NAME",
          help: "Resource name",
        },
        credential: {
          envKey: "TEST_CREDENTIAL",
          help: "Credential",
          persistence: "with-consent",
        },
      },
    });
    const inputs = {
      credential: "secret",
      resourceName: "resource",
    };

    expect(
      getInitProviderEnvVars({
        includeConsentInputs: false,
        inputs,
        provider: providerWithCredential,
      }),
    ).toEqual({
      TEST_RESOURCE_NAME: "resource",
    });
    expect(
      getInitProviderEnvVars({
        includeConsentInputs: true,
        inputs,
        provider: providerWithCredential,
      }),
    ).toEqual({
      TEST_RESOURCE_NAME: "resource",
      TEST_CREDENTIAL: "secret",
    });
  });
});
