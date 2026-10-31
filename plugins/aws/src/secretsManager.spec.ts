import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { maskSecretValues } from "@hot-updater/cli-tools";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { secretsManager } from "./secretsManager";

// What a failure says to do depends on CI: each spec picks one.
beforeEach(() => {
  vi.stubEnv("CI", "");
  vi.stubEnv("AWS_PROFILE", "");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
  vi.stubEnv("AWS_SESSION_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const REGION = "ap-northeast-2";
const context = { cwd: process.cwd() };
const sm = mockClient(SecretsManagerClient);

const notFound = () =>
  new ResourceNotFoundException({
    $metadata: { httpStatusCode: 400 },
    message: "Secrets Manager can't find the specified secret.",
  });

/** An error as the SDK throws it for a type it has no class for. */
const awsError = (name: string, message: string, httpStatusCode = 400) =>
  Object.assign(new Error(message), {
    name,
    $fault: "client",
    $metadata: { httpStatusCode },
  });

const rejectionOf = async (promise: Promise<unknown> | undefined) => {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
};

beforeEach(() => {
  sm.reset();
  vi.stubEnv("AWS_ACCESS_KEY_ID", "");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("secretsManager get", () => {
  it("reads each name as <prefix><name>, and undefined for a missing secret", async () => {
    sm.on(GetSecretValueCommand, { SecretId: "hot-updater/asc-api-key" })
      .resolves({ SecretString: '{"keyId":"K","p8":"spec-p8-value"}' })
      .on(GetSecretValueCommand, { SecretId: "hot-updater/release-keystore" })
      .rejects(notFound());

    const values = await secretsManager({ region: REGION }).get(
      ["asc-api-key", "release-keystore", "asc-api-key"],
      context,
    );

    expect({ ...values }).toEqual({
      "asc-api-key": '{"keyId":"K","p8":"spec-p8-value"}',
      "release-keystore": undefined,
    });
    expect(Object.getPrototypeOf(values)).toBeNull();
    expect(
      sm.commandCalls(GetSecretValueCommand).map(({ args }) => args[0].input),
    ).toEqual([
      { SecretId: "hot-updater/asc-api-key" },
      { SecretId: "hot-updater/release-keystore" },
    ]);
    expect(maskSecretValues('{"keyId":"K","p8":"spec-p8-value"}')).toBe(
      "********",
    );
  });

  it("returns a binary secret as its base64", async () => {
    sm.on(GetSecretValueCommand).resolves({
      SecretBinary: new Uint8Array([0, 1, 2, 250]),
    });

    await expect(
      secretsManager({ region: REGION, prefix: "" }).get(["bin"], context),
    ).resolves.toEqual({ bin: "AAEC+g==" });
  });

  it("names the permission and the KMS key when AWS refuses a read", async () => {
    sm.on(GetSecretValueCommand).rejects(
      awsError(
        "AccessDeniedException",
        "User: arn:aws:sts::1:assumed-role/ci is not authorized to perform: secretsmanager:GetSecretValue",
      ),
    );

    const error = await rejectionOf(
      secretsManager({ region: REGION }).get(["asc-api-key"], context),
    );

    expect(error.message).toBe(
      [
        "AWS Secrets Manager refused to read hot-updater/asc-api-key.",
        "arn:aws:sts::1:assumed-role/ci needs secretsmanager:GetSecretValue on it.",
      ].join("\n"),
    );
  });

  it.each(["ExpiredTokenException", "UnrecognizedClientException"])(
    "says to sign in again on %s",
    async (name) => {
      sm.on(GetSecretValueCommand).rejects(
        awsError(name, "The security token included in the request is expired"),
      );

      const error = await rejectionOf(
        secretsManager({ region: REGION }).get(["asc-api-key"], context),
      );

      expect(error.message).toContain(
        "AWS rejected the credentials: expired or invalid.",
      );
      expect(error.message).toContain("aws sso login --profile <profile>");
    },
  );

  it.each(["CredentialsProviderError", "TokenProviderError"])(
    "says where credentials come from on %s",
    async (name) => {
      sm.on(GetSecretValueCommand).rejects(
        awsError(name, "Could not load credentials from any providers"),
      );

      const error = await rejectionOf(
        secretsManager({ region: REGION }).get(["asc-api-key"], context),
      );

      expect(error.message).toBe(
        [
          "secretsManager found no AWS credentials.",
          "Sign in, then set AWS_PROFILE:",
          "aws sso login --profile <profile>",
        ].join("\n"),
      );
    },
  );

  describe("the next step for the credentials in use", () => {
    const rejected = async (
      options: Partial<Parameters<typeof secretsManager>[0]> = {},
    ) => {
      sm.on(GetSecretValueCommand).rejects(
        awsError("InvalidClientTokenId", "The security token is invalid"),
      );
      return (
        await rejectionOf(
          secretsManager({ region: REGION, ...options }).get(["n"], context),
        )
      ).message;
    };

    it("names the access key variables, which signing in can't replace", async () => {
      vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "garbage");

      const message = await rejected();

      expect(message).toBe(
        [
          "AWS rejected the credentials: expired or invalid.",
          "Fix or unset AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.",
        ].join("\n"),
      );
      expect(message).not.toContain("aws sso login");
    });

    it("names the session token too when one is set", async () => {
      vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "garbage");
      vi.stubEnv("AWS_SESSION_TOKEN", "garbage");

      expect(await rejected()).toContain(
        "Fix or unset AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_SESSION_TOKEN.",
      );
    });

    it("signs in to the profile already set when its SSO session expired", async () => {
      vi.stubEnv("AWS_PROFILE", "release");
      // The SDK's chain uses the profile over the variables.
      vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "garbage");
      sm.on(GetSecretValueCommand).rejects(
        awsError(
          "TokenProviderError",
          "The SSO session associated with this profile has expired",
        ),
      );

      const { message } = await rejectionOf(
        secretsManager({ region: REGION }).get(["n"], context),
      );

      expect(message).toBe(
        [
          "secretsManager found no AWS credentials.",
          "Sign in again:",
          "aws sso login --profile release",
        ].join("\n"),
      );
    });

    it("points at a profile that isn't an SSO one instead of signing in", async () => {
      vi.stubEnv("AWS_PROFILE", "release");

      const message = await rejected();

      expect(message).toContain(
        "Check the AWS profile release, which AWS_PROFILE selects.",
      );
      expect(message).not.toContain("aws sso login");
    });

    it("says to set them in CI, with neither a profile nor variables", async () => {
      vi.stubEnv("CI", "true");

      expect(await rejected()).toContain(
        "Set them with aws-actions/configure-aws-credentials.",
      );
    });

    it("points at the credentials option, which comes before them all", async () => {
      vi.stubEnv("AWS_PROFILE", "release");

      expect(
        await rejected({
          credentials: { accessKeyId: "a", secretAccessKey: "b" },
        }),
      ).toContain("Check the credentials passed to secretsManager().");
    });
  });

  it("says how to restore a secret scheduled for deletion", async () => {
    sm.on(GetSecretValueCommand).rejects(
      awsError(
        "InvalidRequestException",
        "You can't perform this operation on the secret because it was marked for deletion.",
      ),
    );

    const error = await rejectionOf(
      secretsManager({ region: REGION }).get(["asc-api-key"], context),
    );

    expect(error.message).toBe(
      [
        "hot-updater/asc-api-key is scheduled for deletion. Restore it, or wait until it is gone:",
        "aws secretsmanager restore-secret --secret-id hot-updater/asc-api-key",
      ].join("\n"),
    );
  });

  it("checks its settings and names on first use, not when the config loads", async () => {
    const adapter = secretsManager({ region: "Seoul" });
    await expect(adapter.get(["name"], context)).rejects.toThrow(
      'secretsManager can\'t use the region "Seoul".\nSet an AWS region, such as "us-east-1".',
    );
    await expect(
      secretsManager({ region: REGION, prefix: "a b/" }).get(["n"], context),
    ).rejects.toThrow("prefix takes letters");
    await expect(
      secretsManager({ region: REGION }).get(["has space"], context),
    ).rejects.toThrow("AWS takes up to 512 letters");
    await expect(
      secretsManager({ region: REGION, endpoint: "http://example.com" }).get(
        ["name"],
        context,
      ),
    ).rejects.toThrow(
      "secretsManager can't use its endpoint.\nUse HTTPS, or HTTP on a loopback address.",
    );
    expect(sm.calls()).toHaveLength(0);
  });

  it("refuses half an environment key pair instead of trying a profile", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAHOTUPDATERSPEC01");

    await expect(
      secretsManager({ region: REGION }).get(["asc-api-key"], context),
    ).rejects.toThrow(
      "secretsManager found AWS_ACCESS_KEY_ID without AWS_SECRET_ACCESS_KEY.\nSet both, or neither to use a profile.",
    );
    expect(sm.calls()).toHaveLength(0);
  });

  it("signs with the credentials it is given, and masks them", async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: "value" });
    const credentials = vi.fn(async () => ({
      accessKeyId: "AKIAHOTUPDATERSPEC02",
      secretAccessKey: "spec-secret-access-key/0123456789",
      sessionToken: "spec-session-token-0123456789",
    }));

    await secretsManager({ region: REGION, credentials }).get(["n"], context);
    const client = sm.call(0).thisValue as SecretsManagerClient;
    const resolved = await client.config.credentials();

    expect(resolved).toMatchObject({
      accessKeyId: "AKIAHOTUPDATERSPEC02",
      secretAccessKey: "spec-secret-access-key/0123456789",
    });
    expect(
      maskSecretValues(
        "spec-secret-access-key/0123456789 spec-session-token-0123456789",
      ),
    ).toBe("******** ********");
  });

  it("refuses credentials without a key pair when it signs", async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: "value" });

    await secretsManager({
      region: REGION,
      credentials: { accessKeyId: "", secretAccessKey: "" },
    }).get(["n"], context);
    const client = sm.call(0).thisValue as SecretsManagerClient;

    await expect(client.config.credentials()).rejects.toThrow(
      "secretsManager credentials need an accessKeyId and a secretAccessKey.",
    );
  });

  it("describes where a name is kept", () => {
    expect(secretsManager({ region: REGION }).describe?.("asc-api-key")).toBe(
      'the secret "hot-updater/asc-api-key" in AWS Secrets Manager (ap-northeast-2)',
    );
  });
});

describe("secretsManager set", () => {
  it("puts a new version of an existing secret", async () => {
    sm.on(PutSecretValueCommand).resolves({ VersionId: "v2" });

    await secretsManager({ region: REGION }).set?.(
      "asc-api-key",
      '{"p8":"spec-new-p8-value"}',
      context,
    );

    const [put] = sm.commandCalls(PutSecretValueCommand);
    expect(put?.args[0].input).toEqual({
      ClientRequestToken: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      SecretId: "hot-updater/asc-api-key",
      SecretString: '{"p8":"spec-new-p8-value"}',
    });
    expect(sm.commandCalls(CreateSecretCommand)).toHaveLength(0);
    expect(maskSecretValues('{"p8":"spec-new-p8-value"}')).toBe("********");
  });

  it("creates a missing secret with the same request token, and no tags", async () => {
    sm.on(PutSecretValueCommand)
      .rejects(notFound())
      .on(CreateSecretCommand)
      .resolves({});

    await secretsManager({ region: REGION }).set?.("asc-api-key", "v", context);

    const token = sm.commandCalls(PutSecretValueCommand)[0]?.args[0].input
      .ClientRequestToken;
    expect(sm.commandCalls(CreateSecretCommand)[0]?.args[0].input).toEqual({
      ClientRequestToken: token,
      Description: "Stored by Hot Updater.",
      Name: "hot-updater/asc-api-key",
      SecretString: "v",
    });
  });

  it("puts the value when another run creates the secret first", async () => {
    sm.on(PutSecretValueCommand)
      .rejectsOnce(notFound())
      .resolves({})
      .on(CreateSecretCommand)
      .rejects(
        new ResourceExistsException({
          $metadata: { httpStatusCode: 400 },
          message: "The operation failed because the secret already exists.",
        }),
      );

    await secretsManager({ region: REGION }).set?.("asc-api-key", "v", context);

    const puts = sm.commandCalls(PutSecretValueCommand);
    expect(puts).toHaveLength(2);
    expect(puts[1]?.args[0].input.ClientRequestToken).toBe(
      puts[0]?.args[0].input.ClientRequestToken,
    );
  });

  it("names the permission a refused write or create needs", async () => {
    sm.on(PutSecretValueCommand).rejects(
      awsError("AccessDeniedException", "not authorized"),
    );
    await expect(
      secretsManager({ region: REGION }).set?.("asc-api-key", "v", context),
    ).rejects.toThrow(
      [
        "AWS Secrets Manager refused to write hot-updater/asc-api-key.",
        "The identity needs secretsmanager:PutSecretValue on it.",
      ].join("\n"),
    );

    sm.reset();
    sm.on(PutSecretValueCommand)
      .rejects(notFound())
      .on(CreateSecretCommand)
      .rejects(awsError("AccessDeniedException", "not authorized"));
    await expect(
      secretsManager({ region: REGION }).set?.("asc-api-key", "v", context),
    ).rejects.toThrow(
      "AWS Secrets Manager refused to create hot-updater/asc-api-key.\nThe identity needs secretsmanager:CreateSecret on it.",
    );
  });

  it("says how to restore a secret scheduled for deletion before it writes", async () => {
    sm.on(PutSecretValueCommand).rejects(
      awsError(
        "InvalidRequestException",
        "You can't perform this operation on the secret because it was marked for deletion.",
      ),
    );

    await expect(
      secretsManager({ region: REGION }).set?.("asc-api-key", "v", context),
    ).rejects.toThrow(
      "hot-updater/asc-api-key is scheduled for deletion. Restore it, or wait until it is gone:\naws secretsmanager restore-secret --secret-id hot-updater/asc-api-key",
    );
    expect(sm.commandCalls(CreateSecretCommand)).toHaveLength(0);
  });

  it("refuses an empty or oversized value before any request", async () => {
    const adapter = secretsManager({ region: REGION });

    await expect(adapter.set?.("name", "", context)).rejects.toThrow(
      "secretsManager can't store an empty hot-updater/name.",
    );
    await expect(
      adapter.set?.("name", "x".repeat(65_537), context),
    ).rejects.toThrow("AWS takes up to 65536 bytes per secret.");
    expect(sm.calls()).toHaveLength(0);
  });
});

describe("secretsManager's next step", () => {
  beforeEach(() => {
    sm.reset();
    vi.stubEnv("CI", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("names the action in CI, where nobody signs in", async () => {
    vi.stubEnv("CI", "true");
    sm.on(GetSecretValueCommand).rejects(
      awsError("CredentialsProviderError", "Could not load credentials"),
    );

    const error = await rejectionOf(
      secretsManager({ region: REGION }).get(["asc-api-key"], context),
    );

    expect(error.message).toBe(
      "secretsManager found no AWS credentials.\nSet them with aws-actions/configure-aws-credentials.",
    );
  });

  it("names the caller and the KMS permission, not the key AWS refused", async () => {
    sm.on(GetSecretValueCommand).rejects(
      awsError(
        "AccessDeniedException",
        "User: arn:aws-us-gov:iam::123456789012:user/deploy.bot@example.com is not authorized to perform: kms:Decrypt on resource: arn:aws:kms:us-east-1:123456789012:key/abc",
      ),
    );

    const error = await rejectionOf(
      secretsManager({ region: REGION }).get(["asc-api-key"], context),
    );

    expect(error.message.split("\n").at(-1)).toBe(
      "arn:aws-us-gov:iam::123456789012:user/deploy.bot@example.com needs kms:Decrypt on it.",
    );
  });

  it.each([
    ["no caller", "not authorized"],
    [
      "a resource's ARN where the caller's would be",
      "User: arn:aws:secretsmanager:us-east-1:1:secret:hot-updater/x is not authorized",
    ],
    ["no ARN after User:", "User: someone is not authorized"],
  ])("says the identity when AWS's message has %s", async (_case, message) => {
    sm.on(GetSecretValueCommand).rejects(
      awsError("AccessDeniedException", message),
    );

    const error = await rejectionOf(
      secretsManager({ region: REGION }).get(["asc-api-key"], context),
    );

    expect(error.message.split("\n").at(-1)).toBe(
      "The identity needs secretsmanager:GetSecretValue on it.",
    );
  });

  it("takes only the ARN from AWS's message, so nothing else in it can print", async () => {
    const value = "super-secret-value";
    sm.on(GetSecretValueCommand).rejects(
      awsError(
        "AccessDeniedException",
        `User: arn:aws:sts::1:assumed-role/ci"${value}" is not authorized: ${value}`,
      ),
    );

    const error = await rejectionOf(
      secretsManager({ region: REGION }).get(["asc-api-key"], context),
    );

    expect(error.message).not.toContain(value);
    expect(error.message.split("\n").at(-1)).toBe(
      "arn:aws:sts::1:assumed-role/ci needs secretsmanager:GetSecretValue on it.",
    );
  });

  it("leaves the caller's ARN unmasked after the adapter read values", async () => {
    sm.on(GetSecretValueCommand)
      .resolvesOnce({ SecretString: "ci" })
      .resolvesOnce({ SecretString: "a-longer-secret-value" });
    await secretsManager({ region: REGION }).get(["short", "long"], context);
    sm.reset();
    sm.on(GetSecretValueCommand).rejects(
      awsError(
        "AccessDeniedException",
        "User: arn:aws:sts::1:assumed-role/ci is not authorized",
      ),
    );

    const error = await rejectionOf(
      secretsManager({ region: REGION }).get(["asc-api-key"], context),
    );

    expect(maskSecretValues(error.message)).toContain(
      "arn:aws:sts::1:assumed-role/ci needs",
    );
  });

  it("names the KMS permission when that is what AWS refused", async () => {
    sm.on(GetSecretValueCommand).rejects(
      awsError("AccessDeniedException", "Access to KMS is not allowed"),
    );

    const error = await rejectionOf(
      secretsManager({ region: REGION }).get(["asc-api-key"], context),
    );

    expect(error.message).toContain("The identity needs kms:Decrypt on it.");
  });
});
