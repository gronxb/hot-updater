import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  ListSecretVersionIdsCommand,
  ListSecretsCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  assertDockerDaemonAvailable,
  findOpenPort,
  formatRuntimeLogs,
  spawnRuntime,
  stopRuntime,
} from "@hot-updater/test-utils/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { secretsManager } from "./secretsManager";

const LOCALSTACK_IMAGE = "localstack/localstack:3";
const REGION = "us-east-1";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const context = { cwd: process.cwd() };

assertDockerDaemonAvailable(
  "secretsManager on LocalStack requires a running Docker daemon.",
);

let endpoint = "";
let localstack: ReturnType<typeof spawnRuntime> | undefined;

/** A client of its own, to check what the adapter stored. */
const createClient = () =>
  new SecretsManagerClient({ credentials, endpoint, region: REGION });

const waitForLocalstack = async (runtime: ReturnType<typeof spawnRuntime>) => {
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (runtime.child.exitCode !== null) {
      throw new Error(
        `LocalStack exited early: ${formatRuntimeLogs(runtime.logs)}`,
      );
    }
    try {
      await createClient().send(new ListSecretsCommand({}));
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
};

beforeAll(async () => {
  const port = await findOpenPort();
  endpoint = `http://127.0.0.1:${port}`;
  localstack = spawnRuntime({
    command: "docker",
    args: [
      "run",
      "--rm",
      "--name",
      `hot-updater-secrets-manager-${process.pid}`,
      "-p",
      `127.0.0.1:${port}:4566`,
      "-e",
      "SERVICES=secretsmanager",
      "-e",
      `DEFAULT_REGION=${REGION}`,
      LOCALSTACK_IMAGE,
    ],
    cwd: process.cwd(),
  });
  await waitForLocalstack(localstack);
}, 120_000);

afterAll(async () => {
  if (localstack) await stopRuntime(localstack.child);
});

/** An adapter over a prefix of its own, so cases never share a secret. */
const createAdapter = () => {
  const prefix = `hot-updater/${crypto.randomUUID()}/`;
  return {
    prefix,
    secrets: secretsManager({ credentials, endpoint, prefix, region: REGION }),
  };
};

describe("secretsManager (LocalStack)", () => {
  it("reads a missing secret as undefined, creates it, and updates it", async () => {
    const { prefix, secrets } = createAdapter();
    const first = '{"keyId":"ABC123","issuerId":"i","p8":"-----BEGIN-----"}';
    const second = '{"keyId":"DEF456","issuerId":"i","p8":"-----BEGIN-----"}';

    expect({ ...(await secrets.get(["asc-api-key"], context)) }).toEqual({
      "asc-api-key": undefined,
    });

    await secrets.set?.("asc-api-key", first, context);
    expect(
      (
        await createClient().send(
          new GetSecretValueCommand({ SecretId: `${prefix}asc-api-key` }),
        )
      ).SecretString,
    ).toBe(first);
    expect({
      ...(await secrets.get(["asc-api-key", "release-keystore"], context)),
    }).toEqual({ "asc-api-key": first, "release-keystore": undefined });

    await secrets.set?.("asc-api-key", second, context);
    expect({ ...(await secrets.get(["asc-api-key"], context)) }).toEqual({
      "asc-api-key": second,
    });
    const { Versions } = await createClient().send(
      new ListSecretVersionIdsCommand({ SecretId: `${prefix}asc-api-key` }),
    );
    expect(
      Versions?.flatMap(({ VersionStages }) => VersionStages ?? []).sort(),
    ).toEqual(["AWSCURRENT", "AWSPREVIOUS"]);
    expect(secrets.describe?.("asc-api-key")).toBe(
      `the secret ${JSON.stringify(`${prefix}asc-api-key`)} in AWS Secrets Manager (${REGION})`,
    );
  });

  it("reads a binary secret as its base64", async () => {
    const { prefix, secrets } = createAdapter();
    await createClient().send(
      new CreateSecretCommand({
        Name: `${prefix}keystore`,
        SecretBinary: new Uint8Array([0, 1, 2, 250]),
      }),
    );

    expect({ ...(await secrets.get(["keystore"], context)) }).toEqual({
      keystore: "AAEC+g==",
    });
  });

  it("says how to restore a secret scheduled for deletion", async () => {
    const { prefix, secrets } = createAdapter();
    await secrets.set?.("asc-api-key", "value", context);
    await createClient().send(
      new DeleteSecretCommand({
        RecoveryWindowInDays: 7,
        SecretId: `${prefix}asc-api-key`,
      }),
    );

    await expect(secrets.get(["asc-api-key"], context)).rejects.toThrow(
      [
        "AWS Secrets Manager can't read a secret.",
        `Secret: ${prefix}asc-api-key`,
        "It is scheduled for deletion. Restore it, or wait until it is gone:",
        "aws secretsmanager restore-secret \\",
        `  --secret-id ${prefix}asc-api-key`,
      ].join("\n"),
    );
  });
});
