import { randomUUID } from "node:crypto";

import type { GetSecretValueCommandOutput } from "@aws-sdk/client-secrets-manager";
import type { SecretsAdapter } from "@hot-updater/plugin-core";

/** AWS credentials, as the AWS SDK takes them. */
export interface SecretsManagerCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly expiration?: Date;
}

export interface SecretsManagerOptions {
  /** The AWS region the secrets are in, such as `"us-east-1"`. */
  readonly region: string;
  /**
   * Put before every name to make its secret's name, so `secret("asc-api-key")`
   * reads the secret `hot-updater/asc-api-key` and one IAM resource,
   * `secret:hot-updater/*`, covers them all. Letters, digits, and
   * `/_+=.@-`.
   *
   * @default "hot-updater/"
   */
  readonly prefix?: string;
  /**
   * The credentials to sign with, or a function that returns them. Without
   * them, the AWS SDK's default chain: the environment, as
   * `aws-actions/configure-aws-credentials` sets it in CI, then a profile,
   * AWS SSO, or an instance role.
   */
  readonly credentials?:
    | SecretsManagerCredentials
    | (() => Promise<SecretsManagerCredentials>);
  /**
   * An HTTPS endpoint to call instead of the region's, such as a VPC
   * endpoint, or an HTTP loopback one, such as LocalStack's.
   */
  readonly endpoint?: string;
}

type SecretsManagerModule = typeof import("@aws-sdk/client-secrets-manager");
type SecretsManagerClient = InstanceType<
  SecretsManagerModule["SecretsManagerClient"]
>;

interface Client {
  readonly sdk: SecretsManagerModule;
  readonly client: SecretsManagerClient;
}

const NAME = "secretsManager";
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d+$/u;
/** The characters AWS takes in a secret's name. */
const SECRET_ID_PATTERN = /^[A-Za-z0-9/_+=.@-]+$/u;
const MAX_SECRET_ID_LENGTH = 512;
/** AWS's limit on a `SecretString`, in bytes. */
const MAX_SECRET_BYTES = 65_536;
const REQUEST_TIMEOUT_MS = 30_000;

/** Errors of credentials AWS no longer takes: signing in again fixes them. */
const EXPIRED_CREDENTIAL_ERRORS = new Set([
  "ExpiredToken",
  "ExpiredTokenException",
  "IncompleteSignature",
  "InvalidClientTokenId",
  "InvalidSignatureException",
  "MissingAuthenticationToken",
  "UnrecognizedClientException",
]);

/** Errors of the SDK finding no credentials, or an expired SSO session. */
const NO_CREDENTIAL_ERRORS = new Set([
  "CredentialsProviderError",
  "TokenProviderError",
]);

const SIGN_IN_HINT = [
  "In CI, set them with aws-actions/configure-aws-credentials.",
  "On your machine: aws sso login --profile <profile>, then set AWS_PROFILE.",
];

/** The widest line a message has: the CLI prints no wider. */
const LINE_WIDTH = 76;

/** `text`, such as AWS's own message, in lines that fit, broken at spaces. */
const wrap = (text: string): string[] => {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/u).filter(Boolean)) {
    if (line && line.length + 1 + word.length > LINE_WIDTH) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
};

/** An error of one line each, for a terminal. */
const failure = (lines: readonly string[], cause?: unknown) =>
  new Error(lines.join("\n"), cause === undefined ? undefined : { cause });

const errorName = (error: unknown) =>
  error instanceof Error ? error.name : "";

const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\.+$/u, "");

const resolveEndpoint = (endpoint: string) => {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new Error(`${NAME} endpoint must be a valid URL.`);
  }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]).has(
    url.hostname,
  );
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw failure([
      // Not quoted: it may hold credentials.
      `${NAME} can't use its endpoint.`,
      "Use HTTPS, or HTTP on a loopback address.",
      "Leave out credentials, a query, and a fragment.",
    ]);
  }
  return url.toString();
};

/** Masks a value in the CLI's output, which loads `@hot-updater/cli-tools`. */
const mask = async (values: readonly (string | undefined)[]) => {
  const { registerSecretValue } = await import("@hot-updater/cli-tools");
  for (const value of values) if (value) registerSecretValue(value);
};

const checkCredentials = async (
  credentials: SecretsManagerCredentials,
): Promise<SecretsManagerCredentials> => {
  if (!credentials?.accessKeyId || !credentials.secretAccessKey) {
    throw new Error(
      `${NAME} credentials need an accessKeyId and a secretAccessKey.`,
    );
  }
  await mask([credentials.secretAccessKey, credentials.sessionToken]);
  return credentials;
};

/**
 * Secrets from AWS Secrets Manager: each name is the secret
 * `<prefix><name>`, its `SecretString`, or its `SecretBinary` as base64.
 * `set` puts a new version of the secret, and creates the secret when it
 * does not exist; AWS keeps the versions labeled `AWSCURRENT` and
 * `AWSPREVIOUS`, and removes the older ones itself. The AWS SDK loads on
 * the first read or write, so a config that only uses `s3Storage` never
 * loads it.
 *
 * @example
 * secrets: secretsManager({ region: "us-east-1" })
 */
export const secretsManager = ({
  credentials,
  endpoint,
  prefix = "hot-updater/",
  region,
}: SecretsManagerOptions): SecretsAdapter => {
  // Checked on first use, so a config loads without its settings.
  const checkSettings = () => {
    if (typeof region !== "string" || !REGION_PATTERN.test(region)) {
      throw failure([
        `${NAME} can't use the region ${JSON.stringify(region)}.`,
        'Set an AWS region, such as "us-east-1".',
      ]);
    }
    if (prefix !== "" && !SECRET_ID_PATTERN.test(prefix)) {
      throw new Error(
        `${NAME}'s prefix takes letters, digits, and /_+=.@- only.`,
      );
    }
  };

  const secretId = (name: string) => {
    checkSettings();
    const id = `${prefix}${name}`;
    if (!SECRET_ID_PATTERN.test(name) || id.length > MAX_SECRET_ID_LENGTH) {
      throw failure([
        `${NAME} can't name a secret ${JSON.stringify(id)}.`,
        `AWS takes up to ${MAX_SECRET_ID_LENGTH} letters, digits, and /_+=.@- characters.`,
      ]);
    }
    return id;
  };

  const resolveCredentials = ():
    | (() => Promise<SecretsManagerCredentials>)
    | undefined => {
    if (credentials !== undefined) {
      return async () =>
        checkCredentials(
          typeof credentials === "function" ? await credentials() : credentials,
        );
    }
    const accessKeyId = process.env["AWS_ACCESS_KEY_ID"];
    const secretAccessKey = process.env["AWS_SECRET_ACCESS_KEY"];
    // Half a pair is a CI variable gone missing, not a reason to try a profile.
    if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
      throw failure([
        `${NAME} found ${accessKeyId ? "AWS_ACCESS_KEY_ID" : "AWS_SECRET_ACCESS_KEY"} without ${accessKeyId ? "AWS_SECRET_ACCESS_KEY" : "AWS_ACCESS_KEY_ID"}.`,
        "Set both, or neither to use a profile.",
      ]);
    }
    // The SDK's default chain.
    return undefined;
  };

  let opened: Promise<Client> | undefined;
  const open = () => {
    checkSettings();
    const signWith = resolveCredentials();
    opened ??= import("@aws-sdk/client-secrets-manager")
      .then(
        (sdk): Client => ({
          sdk,
          client: new sdk.SecretsManagerClient({
            region,
            ...(signWith ? { credentials: signWith } : {}),
            ...(endpoint === undefined
              ? {}
              : { endpoint: resolveEndpoint(endpoint) }),
            requestHandler: { requestTimeout: REQUEST_TIMEOUT_MS },
          }),
        }),
      )
      .catch((error: unknown) => {
        opened = undefined;
        throw error;
      });
    return opened;
  };

  const describeFailure = (
    verb: string,
    id: string,
    error: unknown,
    permissions: string,
  ) => {
    const name = errorName(error);
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;
    const detail = wrap(
      `${name || "Error"}${status ? ` (${status})` : ""}: ${errorMessage(error)}.`,
    );
    // On a line of its own: a name and its prefix are a line's worth.
    const secret = `Secret: ${id}`;
    if (NO_CREDENTIAL_ERRORS.has(name)) {
      return failure(
        [
          `${NAME} found no AWS credentials to ${verb} a secret.`,
          secret,
          ...wrap(`${errorMessage(error)}.`),
          ...SIGN_IN_HINT,
        ],
        error,
      );
    }
    if (EXPIRED_CREDENTIAL_ERRORS.has(name)) {
      return failure(
        [
          `AWS Secrets Manager refused the sign-in to ${verb} a secret.`,
          secret,
          ...detail,
          "They are expired or invalid: sign in again.",
          ...SIGN_IN_HINT,
        ],
        error,
      );
    }
    if (name === "AccessDeniedException") {
      return failure(
        [
          `AWS Secrets Manager refused to ${verb} a secret.`,
          secret,
          ...detail,
          `The AWS identity needs ${permissions} on it.`,
          `With a customer managed KMS key, it needs ${verb === "read" ? "kms:Decrypt" : "kms:GenerateDataKey"} too.`,
        ],
        error,
      );
    }
    if (
      /marked for deletion|scheduled for deletion/iu.test(errorMessage(error))
    ) {
      return failure(
        [
          `AWS Secrets Manager can't ${verb} a secret.`,
          secret,
          "It is scheduled for deletion. Restore it, or wait until it is gone:",
          // Broken with \ so it never passes 76 columns.
          "aws secretsmanager restore-secret \\",
          `  --secret-id ${id}`,
        ],
        error,
      );
    }
    return failure(
      [`AWS Secrets Manager failed to ${verb} a secret.`, secret, ...detail],
      error,
    );
  };

  const read = async (
    { sdk, client }: Client,
    id: string,
  ): Promise<string | undefined> => {
    let output: GetSecretValueCommandOutput;
    try {
      output = await client.send(
        new sdk.GetSecretValueCommand({ SecretId: id }),
      );
    } catch (error) {
      // Also a secret with no AWSCURRENT version.
      if (error instanceof sdk.ResourceNotFoundException) return undefined;
      throw describeFailure("read", id, error, "secretsmanager:GetSecretValue");
    }
    const value =
      output.SecretString ??
      (output.SecretBinary === undefined
        ? undefined
        : Buffer.from(output.SecretBinary).toString("base64"));
    await mask([value]);
    return value;
  };

  return {
    name: NAME,
    // One request per name, in parallel: BatchGetSecretValue would need
    // its own permission on every resource ("*") besides GetSecretValue.
    get: async (names) => {
      const unique = [...new Set(names)];
      const ids = unique.map(secretId);
      // No prototype: a secret may be named __proto__.
      const result: Record<string, string | undefined> = Object.create(null);
      if (unique.length === 0) return result;
      const client = await open();
      const values = await Promise.all(ids.map((id) => read(client, id)));
      unique.forEach((name, index) => {
        result[name] = values[index];
      });
      return result;
    },
    set: async (name, value) => {
      const id = secretId(name);
      if (typeof value !== "string" || value === "") {
        throw new Error(`${NAME} can't store an empty ${id}.`);
      }
      if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
        throw failure([
          `${NAME} can't store ${id}.`,
          `AWS takes up to ${MAX_SECRET_BYTES} bytes per secret.`,
        ]);
      }
      await mask([value]);
      const { sdk, client } = await open();
      // The same token on a retry makes the write idempotent.
      const token = randomUUID();
      const put = () =>
        client.send(
          new sdk.PutSecretValueCommand({
            ClientRequestToken: token,
            SecretId: id,
            SecretString: value,
          }),
        );
      try {
        await put();
        return;
      } catch (error) {
        if (!(error instanceof sdk.ResourceNotFoundException)) {
          throw describeFailure(
            "write",
            id,
            error,
            "secretsmanager:PutSecretValue",
          );
        }
      }
      try {
        await client.send(
          new sdk.CreateSecretCommand({
            ClientRequestToken: token,
            Description: "Stored by Hot Updater.",
            Name: id,
            SecretString: value,
          }),
        );
      } catch (error) {
        if (!(error instanceof sdk.ResourceExistsException)) {
          throw describeFailure(
            "create",
            id,
            error,
            "secretsmanager:CreateSecret",
          );
        }
        // Another run created it first: put the value on it.
        try {
          await put();
        } catch (retryError) {
          throw describeFailure(
            "write",
            id,
            retryError,
            "secretsmanager:PutSecretValue",
          );
        }
      }
    },
    describe: (name) =>
      `the secret ${JSON.stringify(`${prefix}${name}`)} in AWS Secrets Manager (${region})`,
  };
};
