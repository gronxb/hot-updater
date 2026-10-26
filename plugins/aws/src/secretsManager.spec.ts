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
      'AWS Secrets Manager refused to read "hot-updater/asc-api-key", AccessDeniedException (400): User: arn:aws:sts::1:assumed-role/ci is not authorized to perform: secretsmanager:GetSecretValue. The AWS identity needs secretsmanager:GetSecretValue on it, and on a secret encrypted with a customer managed KMS key, kms:Decrypt to read and kms:GenerateDataKey to store.',
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
        "They are expired or invalid: sign in again.",
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
        'secretsManager found no usable AWS credentials to read "hot-updater/asc-api-key" (Could not load credentials from any providers). In CI, set them with aws-actions/configure-aws-credentials; on your machine, run aws sso login --profile <profile> and set AWS_PROFILE=<profile>.',
      );
    },
  );

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
      'AWS Secrets Manager cannot read "hot-updater/asc-api-key": it is scheduled for deletion. Restore it with aws secretsmanager restore-secret --secret-id hot-updater/asc-api-key, or wait until it is deleted.',
    );
  });

  it("checks its settings and names on first use, not when the config loads", async () => {
    const adapter = secretsManager({ region: "Seoul" });
    await expect(adapter.get(["name"], context)).rejects.toThrow(
      'secretsManager needs an AWS region, such as "us-east-1", and "Seoul" is not one.',
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
    ).rejects.toThrow("endpoint must use HTTPS, or HTTP on a loopback address");
    expect(sm.calls()).toHaveLength(0);
  });

  it("refuses half an environment key pair instead of trying a profile", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAHOTUPDATERSPEC01");

    await expect(
      secretsManager({ region: REGION }).get(["asc-api-key"], context),
    ).rejects.toThrow(
      "secretsManager found AWS_ACCESS_KEY_ID without AWS_SECRET_ACCESS_KEY in the environment: set both, or neither to use a profile.",
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
      'AWS Secrets Manager refused to write "hot-updater/asc-api-key", AccessDeniedException (400): not authorized. The AWS identity needs secretsmanager:PutSecretValue on it',
    );

    sm.reset();
    sm.on(PutSecretValueCommand)
      .rejects(notFound())
      .on(CreateSecretCommand)
      .rejects(awsError("AccessDeniedException", "not authorized"));
    await expect(
      secretsManager({ region: REGION }).set?.("asc-api-key", "v", context),
    ).rejects.toThrow(
      'AWS Secrets Manager refused to create "hot-updater/asc-api-key", AccessDeniedException (400): not authorized. The AWS identity needs secretsmanager:CreateSecret on it',
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
      'AWS Secrets Manager cannot write "hot-updater/asc-api-key": it is scheduled for deletion. Restore it with aws secretsmanager restore-secret --secret-id hot-updater/asc-api-key',
    );
    expect(sm.commandCalls(CreateSecretCommand)).toHaveLength(0);
  });

  it("refuses an empty or oversized value before any request", async () => {
    const adapter = secretsManager({ region: REGION });

    await expect(adapter.set?.("name", "", context)).rejects.toThrow(
      "secretsManager cannot store an empty hot-updater/name.",
    );
    await expect(
      adapter.set?.("name", "x".repeat(65_537), context),
    ).rejects.toThrow("AWS takes up to 65536 bytes per secret.");
    expect(sm.calls()).toHaveLength(0);
  });
});
