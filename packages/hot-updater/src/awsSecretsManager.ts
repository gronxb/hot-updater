import { randomUUID } from "node:crypto";

import { registerSecretValue } from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";
import { AwsClient } from "aws4fetch";

/** AWS credentials, as the AWS SDK takes them. */
export interface AwsSecretsManagerCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface AwsSecretsManagerOptions {
  /** The AWS region the secrets are in, such as `"us-east-1"`. */
  readonly region: string;
  /**
   * Put before every name to make its secret's name, such as
   * `"hot-updater/"`, so `secret:asc-api-key` reads the secret
   * `hot-updater/asc-api-key` and one IAM resource,
   * `secret:hot-updater/*`, covers them all.
   */
  readonly prefix?: string;
  /**
   * The credentials to sign with. Without them, the adapter signs with
   * `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN`
   * from the environment, as `aws-actions/configure-aws-credentials` sets
   * them, and otherwise with the AWS SDK's default chain (a profile, SSO,
   * or an instance role) from the optional
   * `@aws-sdk/credential-providers` package.
   */
  readonly credentials?:
    | AwsSecretsManagerCredentials
    | (() => Promise<AwsSecretsManagerCredentials>);
  /** An explicit HTTPS endpoint, such as a VPC endpoint, or an HTTP loopback endpoint for tests. */
  readonly endpoint?: string;
}

interface Settings {
  readonly region: string;
  readonly prefix: string;
  readonly endpoint: string;
}

interface CredentialProvidersModule {
  fromNodeProviderChain: () => () => Promise<AwsSecretsManagerCredentials>;
}

const SERVICE = "secretsmanager";
const NAME = "awsSecretsManager";
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d+$/u;
/** The characters AWS takes in a secret's name. */
const SECRET_ID_PATTERN = /^[A-Za-z0-9/_+=.@-]+$/u;
const MAX_SECRET_ID_LENGTH = 512;
/** AWS's limit on a `SecretString`, in bytes. */
const MAX_SECRET_BYTES = 65_536;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;

const AUTH_ERRORS = new Set([
  "AccessDeniedException",
  "ExpiredTokenException",
  "IncompleteSignature",
  "InvalidClientTokenId",
  "InvalidSignatureException",
  "MissingAuthenticationToken",
  "UnrecognizedClientException",
]);

const resolveEndpoint = (endpoint: string | undefined, region: string) => {
  if (endpoint === undefined) {
    const domain = region.startsWith("cn-")
      ? "amazonaws.com.cn"
      : "amazonaws.com";
    return `https://${SERVICE}.${region}.${domain}/`;
  }

  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new Error("AWS Secrets Manager endpoint must be a valid URL.");
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
    throw new Error(
      "AWS Secrets Manager endpoint must use HTTPS or an HTTP loopback URL without credentials, a query, or a fragment.",
    );
  }
  return url.toString();
};

const loadCredentialProviders =
  async (): Promise<CredentialProvidersModule> => {
    try {
      return (await import("@aws-sdk/credential-providers")) as unknown as CredentialProvidersModule;
    } catch {
      throw new Error(
        "awsSecretsManager found no AWS credentials: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set. In CI, set them with aws-actions/configure-aws-credentials. To sign in with a profile or AWS SSO, install the optional @aws-sdk/credential-providers package: npm install @aws-sdk/credential-providers --save-dev",
      );
    }
  };

const checkCredentials = (
  credentials: AwsSecretsManagerCredentials,
): AwsSecretsManagerCredentials => {
  if (!credentials?.accessKeyId || !credentials.secretAccessKey) {
    throw new Error(
      "awsSecretsManager credentials need an accessKeyId and a secretAccessKey.",
    );
  }
  registerSecretValue(credentials.secretAccessKey);
  if (credentials.sessionToken) registerSecretValue(credentials.sessionToken);
  return credentials;
};

/** The error AWS answers with: its type without the namespace, and its message. */
const readError = async (response: Response) => {
  let body: { __type?: unknown; message?: unknown; Message?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Not JSON: the header names the type.
  }
  const rawType =
    typeof body.__type === "string"
      ? body.__type
      : (response.headers.get("x-amzn-errortype") ?? "");
  const type = rawType.split("#").at(-1)?.split(":")[0] || "UnknownError";
  const message =
    typeof body.message === "string"
      ? body.message
      : typeof body.Message === "string"
        ? body.Message
        : "";
  return { type, message };
};

class AwsSecretsManagerError extends Error {
  readonly type: string;
  readonly status: number;

  constructor(type: string, status: number, message: string) {
    super(message);
    this.name = "AwsSecretsManagerError";
    this.type = type;
    this.status = status;
  }
}

const isRetryable = (status: number, type: string) =>
  status >= 500 ||
  status === 429 ||
  type === "ThrottlingException" ||
  type === "RequestLimitExceeded";

/**
 * Secrets from AWS Secrets Manager: each name is the secret
 * `<prefix><name>`, its `SecretString` (or its `SecretBinary` as base64).
 * Requests are signed with SigV4 over `fetch`, so CI needs no AWS SDK:
 * GitHub Actions' OIDC role, through `aws-actions/configure-aws-credentials`,
 * puts the credentials in the environment. `set` puts a new version of the
 * secret, and creates the secret when it does not exist; AWS keeps the
 * versions labeled `AWSCURRENT` and `AWSPREVIOUS`, and removes the older
 * ones itself.
 *
 * @example
 * secrets: awsSecretsManager({ region: "us-east-1", prefix: "hot-updater/" })
 */
export const awsSecretsManager = ({
  credentials,
  endpoint,
  prefix = "",
  region,
}: AwsSecretsManagerOptions): SecretsAdapter => {
  // Checked on first use, so a config loads without its settings.
  let settings: Settings | undefined;
  const resolveSettings = (): Settings => {
    if (settings) return settings;
    const resolvedRegion = region?.trim() ?? "";
    if (!REGION_PATTERN.test(resolvedRegion)) {
      throw new Error(
        `awsSecretsManager needs an AWS region, such as "us-east-1", and ${JSON.stringify(region)} is not one.`,
      );
    }
    if (prefix !== "" && !SECRET_ID_PATTERN.test(prefix)) {
      throw new Error(
        "awsSecretsManager prefix takes letters, digits, and /_+=.@- only.",
      );
    }
    settings = {
      region: resolvedRegion,
      prefix,
      endpoint: resolveEndpoint(endpoint, resolvedRegion),
    };
    return settings;
  };

  const secretId = (name: string) => {
    const id = `${resolveSettings().prefix}${name}`;
    if (!SECRET_ID_PATTERN.test(name) || id.length > MAX_SECRET_ID_LENGTH) {
      throw new Error(
        `awsSecretsManager cannot name a secret ${JSON.stringify(id)}: AWS takes up to ${MAX_SECRET_ID_LENGTH} letters, digits, and /_+=.@- characters.`,
      );
    }
    return id;
  };

  let chain: Promise<() => Promise<AwsSecretsManagerCredentials>> | undefined;
  const resolveCredentials = async () => {
    if (typeof credentials === "function") {
      return checkCredentials(await credentials());
    }
    if (credentials) return checkCredentials(credentials);
    const accessKeyId = process.env["AWS_ACCESS_KEY_ID"];
    const secretAccessKey = process.env["AWS_SECRET_ACCESS_KEY"];
    if (accessKeyId && secretAccessKey) {
      return checkCredentials({
        accessKeyId,
        secretAccessKey,
        sessionToken: process.env["AWS_SESSION_TOKEN"] || undefined,
      });
    }
    // Half a pair is a CI variable gone missing, not a reason to try a profile.
    if (accessKeyId || secretAccessKey) {
      throw new Error(
        `awsSecretsManager found ${accessKeyId ? "AWS_ACCESS_KEY_ID" : "AWS_SECRET_ACCESS_KEY"} without ${accessKeyId ? "AWS_SECRET_ACCESS_KEY" : "AWS_ACCESS_KEY_ID"} in the environment: set both, or neither to use a profile.`,
      );
    }
    chain ??= loadCredentialProviders()
      .then((providers) => providers.fromNodeProviderChain())
      .catch((error) => {
        chain = undefined;
        throw error;
      });
    const provider = await chain;
    let resolved: AwsSecretsManagerCredentials;
    try {
      resolved = await provider();
    } catch (error) {
      throw new Error(
        `awsSecretsManager could not load AWS credentials from the environment, a profile, or AWS SSO: ${(error instanceof Error ? error.message : String(error)).replace(/\.+$/u, "")}. Sign in again, such as with aws sso login.`,
      );
    }
    return checkCredentials(resolved);
  };

  /** Calls `action` with `input`, retrying throttling and server errors. */
  const call = async (
    action: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const { endpoint: url, region: signingRegion } = resolveSettings();
    const signer = new AwsClient({
      ...(await resolveCredentials()),
      region: signingRegion,
      retries: 0,
      service: SERVICE,
    });
    const body = JSON.stringify(input);
    for (let attempt = 1; ; attempt++) {
      const signed = await signer.sign(url, {
        body,
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": `secretsmanager.${action}`,
        },
        method: "POST",
      });
      let response: Response;
      try {
        response = await fetch(signed.url, {
          body,
          headers: signed.headers,
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new Error(
          `awsSecretsManager could not reach ${url}: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
      if (response.ok) {
        return (await response.json()) as Record<string, unknown>;
      }
      const { type, message } = await readError(response);
      if (attempt < MAX_ATTEMPTS && isRetryable(response.status, type)) {
        await new Promise((resolve) =>
          setTimeout(resolve, 200 * 2 ** (attempt - 1)),
        );
        continue;
      }
      throw new AwsSecretsManagerError(type, response.status, message);
    }
  };

  const describeFailure = (
    verb: string,
    id: string,
    error: unknown,
    permissions: string,
  ) => {
    if (!(error instanceof AwsSecretsManagerError)) return error;
    const detail = `${error.type} (${error.status})${error.message ? `: ${error.message}` : ""}`;
    if (AUTH_ERRORS.has(error.type)) {
      return new Error(
        `AWS Secrets Manager refused to ${verb} ${JSON.stringify(id)}, ${detail}. The AWS identity needs ${permissions} on it, and current credentials.`,
      );
    }
    if (/marked for deletion|scheduled for deletion/iu.test(error.message)) {
      return new Error(
        `AWS Secrets Manager cannot ${verb} ${JSON.stringify(id)}: it is scheduled for deletion. Restore it with aws secretsmanager restore-secret --secret-id ${id}, or wait until it is deleted.`,
      );
    }
    return new Error(
      `AWS Secrets Manager failed to ${verb} ${JSON.stringify(id)}, ${detail}.`,
    );
  };

  const read = async (name: string): Promise<string | undefined> => {
    const id = secretId(name);
    let output: Record<string, unknown>;
    try {
      output = await call("GetSecretValue", { SecretId: id });
    } catch (error) {
      // Also a secret with no AWSCURRENT version.
      if (
        error instanceof AwsSecretsManagerError &&
        error.type === "ResourceNotFoundException"
      ) {
        return undefined;
      }
      throw describeFailure("read", id, error, "secretsmanager:GetSecretValue");
    }
    if (typeof output["SecretString"] === "string") {
      return output["SecretString"];
    }
    // The API sends a binary secret as base64 already.
    if (typeof output["SecretBinary"] === "string") {
      return output["SecretBinary"];
    }
    return undefined;
  };

  return {
    name: NAME,
    // One request per name, in parallel: BatchGetSecretValue would need
    // its own permission on every resource ("*") besides GetSecretValue.
    get: async (names) => {
      const unique = [...new Set(names)];
      const values = await Promise.all(unique.map((name) => read(name)));
      // No prototype: a secret may be named __proto__.
      const result: Record<string, string | undefined> = Object.create(null);
      unique.forEach((name, index) => {
        result[name] = values[index];
      });
      return result;
    },
    set: async (name, value) => {
      const id = secretId(name);
      if (typeof value !== "string" || value === "") {
        throw new Error(`awsSecretsManager cannot store an empty ${id}.`);
      }
      if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
        throw new Error(
          `awsSecretsManager cannot store ${id}: AWS takes up to ${MAX_SECRET_BYTES} bytes per secret.`,
        );
      }
      // The same token on a retry makes the write idempotent.
      const token = randomUUID();
      const put = () =>
        call("PutSecretValue", {
          ClientRequestToken: token,
          SecretId: id,
          SecretString: value,
        });
      try {
        await put();
        return;
      } catch (error) {
        if (
          !(error instanceof AwsSecretsManagerError) ||
          error.type !== "ResourceNotFoundException"
        ) {
          throw describeFailure(
            "write",
            id,
            error,
            "secretsmanager:PutSecretValue",
          );
        }
      }
      try {
        await call("CreateSecret", {
          ClientRequestToken: token,
          Description: "Stored by Hot Updater.",
          Name: id,
          SecretString: value,
        });
      } catch (error) {
        // Another run created it first: put the value on it.
        if (
          error instanceof AwsSecretsManagerError &&
          error.type === "ResourceExistsException"
        ) {
          try {
            await put();
            return;
          } catch (retryError) {
            throw describeFailure(
              "write",
              id,
              retryError,
              "secretsmanager:PutSecretValue",
            );
          }
        }
        throw describeFailure(
          "create",
          id,
          error,
          "secretsmanager:CreateSecret",
        );
      }
    },
    describe: (name) =>
      `the secret ${JSON.stringify(`${prefix}${name}`)} in AWS Secrets Manager (${region})`,
  };
};
