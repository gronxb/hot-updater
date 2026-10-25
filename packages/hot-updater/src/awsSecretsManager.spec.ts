import { createHash, createHmac } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { maskSecretValues } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ chain: vi.fn() }));

vi.mock("@aws-sdk/credential-providers", () => ({
  fromNodeProviderChain: () => mocks.chain,
}));

import { awsSecretsManager } from "./awsSecretsManager";

const ACCESS_KEY_ID = "AKIAHOTUPDATERSPEC01";
const SECRET_ACCESS_KEY = "spec-secret-access-key/0123456789abcdefghij";
const SESSION_TOKEN = "spec-session-token-0123456789";
const REGION = "ap-northeast-2";
const context = { cwd: process.cwd() };

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

type Reply = (response: ServerResponse, request: RecordedRequest) => void;

const json =
  (status: number, body: unknown): Reply =>
  (response) => {
    response.writeHead(status, {
      "content-type": "application/x-amz-json-1.1",
    });
    response.end(JSON.stringify(body));
  };

const awsError = (status: number, type: string, message = "") =>
  json(status, {
    __type: `com.amazonaws.secretsmanager#${type}`,
    message,
  });

let server: Server;
let requests: RecordedRequest[];
let replies: Reply[];
let endpoint: string;

beforeEach(async () => {
  requests = [];
  replies = [];
  server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const recorded = {
        body,
        headers: request.headers,
        method: request.method ?? "",
        url: request.url ?? "",
      };
      requests.push(recorded);
      const reply = replies.shift() ?? awsError(500, "UnexpectedRequest");
      reply(response, recorded);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  vi.stubEnv("AWS_ACCESS_KEY_ID", ACCESS_KEY_ID);
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", SECRET_ACCESS_KEY);
  vi.stubEnv("AWS_SESSION_TOKEN", SESSION_TOKEN);
  mocks.chain.mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise((resolve) => server.close(resolve));
});

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const hmac = (key: string | Buffer, value: string) =>
  createHmac("sha256", key).update(value, "utf8").digest();

/**
 * Checks a request's SigV4 signature from its raw bytes, as AWS does,
 * without the signing library the adapter uses.
 */
const verifySigV4 = (request: RecordedRequest, secretAccessKey: string) => {
  const authorization = String(request.headers["authorization"]);
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/u.exec(
      authorization,
    );
  if (!match) throw new Error(`Not a SigV4 Authorization: ${authorization}`);
  const [, accessKeyId, date, region, service, signedHeaders, signature] =
    match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
  const amzDate = String(request.headers["x-amz-date"]);
  const headers = signedHeaders.split(";");
  const canonicalRequest = [
    request.method,
    request.url,
    "",
    ...headers.map(
      (name) =>
        `${name}:${String(request.headers[name]).trim().replace(/\s+/gu, " ")}`,
    ),
    "",
    signedHeaders,
    sha256(request.body),
  ].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service),
    "aws4_request",
  );
  return {
    accessKeyId,
    headers,
    region,
    service,
    valid:
      createHmac("sha256", signingKey).update(stringToSign).digest("hex") ===
      signature,
  };
};

const target = (request: RecordedRequest) => request.headers["x-amz-target"];
const body = (request: RecordedRequest) =>
  JSON.parse(request.body) as Record<string, unknown>;

describe("awsSecretsManager", () => {
  it("reads each name as <prefix><name> with SigV4-signed GetSecretValue calls", async () => {
    const value = JSON.stringify({
      issuerId: "00000000-0000-0000-0000-000000000000",
      keyId: "ABC123",
      p8: "-----BEGIN PRIVATE KEY-----\nspec\n-----END PRIVATE KEY-----",
    });
    // Requests run in parallel: each answers by the secret it asks for.
    const reply: Reply = (response, request) =>
      (body(request)["SecretId"] === "hot-updater/asc-api-key"
        ? json(200, { Name: "hot-updater/asc-api-key", SecretString: value })
        : awsError(
            400,
            "ResourceNotFoundException",
            "Secrets Manager can't find the specified secret.",
          ))(response, request);
    replies.push(reply, reply);

    const secrets = awsSecretsManager({
      endpoint,
      prefix: "hot-updater/",
      region: REGION,
    });

    await expect(
      secrets.get(["asc-api-key", "release-keystore", "asc-api-key"], context),
    ).resolves.toEqual({
      "asc-api-key": value,
      "release-keystore": undefined,
    });

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => body(request)["SecretId"]).sort()).toEqual(
      ["hot-updater/asc-api-key", "hot-updater/release-keystore"],
    );
    for (const request of requests) {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/");
      expect(target(request)).toBe("secretsmanager.GetSecretValue");
      expect(request.headers["content-type"]).toBe(
        "application/x-amz-json-1.1",
      );
      expect(request.headers["x-amz-security-token"]).toBe(SESSION_TOKEN);
      expect(Object.keys(body(request))).toEqual(["SecretId"]);
      const signature = verifySigV4(request, SECRET_ACCESS_KEY);
      expect(signature).toMatchObject({
        accessKeyId: ACCESS_KEY_ID,
        region: REGION,
        service: "secretsmanager",
        valid: true,
      });
      expect(signature.headers).toEqual(
        expect.arrayContaining([
          "host",
          "x-amz-date",
          "x-amz-security-token",
          "x-amz-target",
        ]),
      );
      // The oracle rejects a request signed with another key.
      expect(verifySigV4(request, `${SECRET_ACCESS_KEY}x`).valid).toBe(false);
    }
  });

  it("returns a binary secret as its base64", async () => {
    replies.push(json(200, { SecretBinary: "AAEC/w==" }));

    await expect(
      awsSecretsManager({ endpoint, region: REGION }).get(
        ["release-keystore"],
        context,
      ),
    ).resolves.toEqual({ "release-keystore": "AAEC/w==" });
  });

  it("throws on a permission error instead of reporting the secret missing", async () => {
    replies.push(
      awsError(
        400,
        "AccessDeniedException",
        "User: arn:aws:sts::123456789012:assumed-role/ci is not authorized to perform: secretsmanager:GetSecretValue",
      ),
    );

    const error = await awsSecretsManager({ endpoint, region: REGION })
      .get(["asc-api-key"], context)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'AWS Secrets Manager refused to read "asc-api-key", AccessDeniedException (400)',
    );
    expect((error as Error).message).toContain("secretsmanager:GetSecretValue");
    expect((error as Error).message).not.toContain(SECRET_ACCESS_KEY);
    // Not retried: only throttling and server errors are.
    expect(requests).toHaveLength(1);
  });

  it("throws on expired credentials, named by the error header", async () => {
    replies.push((response) => {
      response.writeHead(403, {
        "x-amzn-errortype": "ExpiredTokenException:http://internal.amazon.com/",
      });
      response.end();
    });

    await expect(
      awsSecretsManager({ endpoint, region: REGION }).get(["a"], context),
    ).rejects.toThrow(/ExpiredTokenException \(403\)/u);
  });

  it("says how to restore a secret scheduled for deletion", async () => {
    replies.push(
      awsError(
        400,
        "InvalidRequestException",
        "You can't perform this operation on the secret because it was marked for deletion.",
      ),
    );

    await expect(
      awsSecretsManager({ endpoint, region: REGION }).get(
        ["asc-api-key"],
        context,
      ),
    ).rejects.toThrow(
      "aws secretsmanager restore-secret --secret-id asc-api-key",
    );
  });

  it("retries throttling and server errors", async () => {
    replies.push(
      awsError(500, "InternalServiceError"),
      awsError(400, "ThrottlingException"),
      json(200, { SecretString: "value-after-retries" }),
    );

    await expect(
      awsSecretsManager({ endpoint, region: REGION }).get(["a"], context),
    ).resolves.toEqual({ a: "value-after-retries" });
    expect(requests).toHaveLength(3);
  });

  it("refuses to follow a redirect", async () => {
    replies.push((response) => {
      response.writeHead(307, { location: `${endpoint}elsewhere` });
      response.end();
    });

    await expect(
      awsSecretsManager({ endpoint, region: REGION }).get(["a"], context),
    ).rejects.toThrow(/could not reach/u);
    expect(requests.map((request) => request.url)).toEqual(["/"]);
  });

  it("puts a new version of an existing secret", async () => {
    replies.push(json(200, { Name: "hot-updater/a", VersionId: "v2" }));

    await awsSecretsManager({
      endpoint,
      prefix: "hot-updater/",
      region: REGION,
    }).set?.("a", '{"keyId":"1"}', context);

    expect(requests).toHaveLength(1);
    expect(target(requests[0]!)).toBe("secretsmanager.PutSecretValue");
    expect(body(requests[0]!)).toEqual({
      ClientRequestToken: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      SecretId: "hot-updater/a",
      SecretString: '{"keyId":"1"}',
    });
    expect(verifySigV4(requests[0]!, SECRET_ACCESS_KEY).valid).toBe(true);
  });

  it("creates a missing secret, with the same request token", async () => {
    replies.push(
      awsError(400, "ResourceNotFoundException"),
      json(200, { Name: "hot-updater/a", VersionId: "v1" }),
    );

    await awsSecretsManager({
      endpoint,
      prefix: "hot-updater/",
      region: REGION,
    }).set?.("a", "value", context);

    expect(requests.map(target)).toEqual([
      "secretsmanager.PutSecretValue",
      "secretsmanager.CreateSecret",
    ]);
    const put = body(requests[0]!);
    // No tags: tagging would need secretsmanager:TagResource too.
    expect(body(requests[1]!)).toEqual({
      ClientRequestToken: put["ClientRequestToken"],
      Description: "Stored by Hot Updater.",
      Name: "hot-updater/a",
      SecretString: "value",
    });
  });

  it("puts the value when another run creates the secret first", async () => {
    replies.push(
      awsError(400, "ResourceNotFoundException"),
      awsError(400, "ResourceExistsException"),
      json(200, { VersionId: "v1" }),
    );

    await awsSecretsManager({ endpoint, region: REGION }).set?.(
      "a",
      "value",
      context,
    );

    expect(requests.map(target)).toEqual([
      "secretsmanager.PutSecretValue",
      "secretsmanager.CreateSecret",
      "secretsmanager.PutSecretValue",
    ]);
  });

  it("names the permission a refused create needs", async () => {
    replies.push(
      awsError(400, "ResourceNotFoundException"),
      awsError(400, "AccessDeniedException"),
    );

    await expect(
      awsSecretsManager({ endpoint, region: REGION }).set?.(
        "a",
        "value",
        context,
      ),
    ).rejects.toThrow("secretsmanager:CreateSecret");
  });

  it("refuses an empty or oversized value before any request", async () => {
    const secrets = awsSecretsManager({ endpoint, region: REGION });

    await expect(secrets.set?.("a", "", context)).rejects.toThrow(/empty/u);
    await expect(
      secrets.set?.("a", "x".repeat(65_537), context),
    ).rejects.toThrow(/65536 bytes/u);
    expect(requests).toHaveLength(0);
  });

  it("signs with explicit credentials over the environment, and masks them", async () => {
    replies.push(json(200, { SecretString: "v" }));
    const explicitSecret = "explicit-secret-access-key-0123456789";

    await awsSecretsManager({
      credentials: async () => ({
        accessKeyId: "AKIAEXPLICIT00000001",
        secretAccessKey: explicitSecret,
      }),
      endpoint,
      region: REGION,
    }).get(["a"], context);

    expect(verifySigV4(requests[0]!, explicitSecret)).toMatchObject({
      accessKeyId: "AKIAEXPLICIT00000001",
      valid: true,
    });
    expect(requests[0]!.headers["x-amz-security-token"]).toBeUndefined();
    expect(maskSecretValues(`key ${explicitSecret}`)).toBe("key ********");
  });

  it("falls back to the AWS SDK's default chain without environment credentials", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
    const chainSecret = "chain-secret-access-key-0123456789";
    mocks.chain.mockResolvedValue({
      accessKeyId: "ASIACHAIN00000000001",
      secretAccessKey: chainSecret,
      sessionToken: "chain-session-token",
    });
    replies.push(json(200, { SecretString: "v" }));

    await awsSecretsManager({ endpoint, region: REGION }).get(["a"], context);

    expect(mocks.chain).toHaveBeenCalledTimes(1);
    expect(verifySigV4(requests[0]!, chainSecret)).toMatchObject({
      accessKeyId: "ASIACHAIN00000000001",
      valid: true,
    });
    expect(requests[0]!.headers["x-amz-security-token"]).toBe(
      "chain-session-token",
    );
  });

  it("refuses half an environment key pair instead of trying a profile", async () => {
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");

    await expect(
      awsSecretsManager({ endpoint, region: REGION }).get(["a"], context),
    ).rejects.toThrow(
      "awsSecretsManager found AWS_ACCESS_KEY_ID without AWS_SECRET_ACCESS_KEY",
    );
    expect(mocks.chain).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("says to sign in again when the default chain fails", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
    mocks.chain.mockRejectedValue(
      new Error("The SSO session has expired. Run aws sso login."),
    );

    await expect(
      awsSecretsManager({ endpoint, region: REGION }).get(["a"], context),
    ).rejects.toThrow(
      "The SSO session has expired. Run aws sso login. Sign in again, such as with aws sso login.",
    );
    expect(requests).toHaveLength(0);
  });

  it("names the optional package when neither the environment nor it provides credentials", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
    vi.resetModules();
    vi.doMock("@aws-sdk/credential-providers", () => {
      throw new Error("Cannot find package '@aws-sdk/credential-providers'");
    });
    try {
      const { awsSecretsManager: fresh } = await import("./awsSecretsManager");

      await expect(
        fresh({ endpoint, region: REGION }).get(["a"], context),
      ).rejects.toThrow(
        /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set.*npm install @aws-sdk\/credential-providers/u,
      );
    } finally {
      vi.doUnmock("@aws-sdk/credential-providers");
    }
    expect(requests).toHaveLength(0);
  });

  it("checks its settings on first use, not when the config loads", async () => {
    const secrets = awsSecretsManager({ region: "nowhere" });

    expect(secrets.name).toBe("awsSecretsManager");
    expect(secrets.describe?.("a")).toBe(
      'the secret "a" in AWS Secrets Manager (nowhere)',
    );
    await expect(secrets.get(["a"], context)).rejects.toThrow(
      /needs an AWS region/u,
    );
    await expect(
      awsSecretsManager({
        endpoint: "http://secrets.example.com/",
        region: REGION,
      }).get(["a"], context),
    ).rejects.toThrow(/HTTPS or an HTTP loopback URL/u);
    await expect(
      awsSecretsManager({
        endpoint,
        prefix: "bad prefix/",
        region: REGION,
      }).get(["a"], context),
    ).rejects.toThrow(/prefix takes letters/u);
    await expect(
      awsSecretsManager({ endpoint, region: REGION }).get(["a b"], context),
    ).rejects.toThrow(/cannot name a secret "a b"/u);
    expect(requests).toHaveLength(0);
  });
});
