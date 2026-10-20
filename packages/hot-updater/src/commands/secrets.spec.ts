import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import {
  assembleServer,
  loadConfig,
  maskSecretValues,
} from "@hot-updater/cli-tools";
import {
  type AnyHotUpdaterPlugin,
  createMemoryAdapter,
  type EngineDatabase,
  type RemoteDatabase,
} from "@hot-updater/plugin-core";
import {
  apiKeys,
  authorizeVaultToken,
  type VaultApi,
  vault,
} from "@hot-updater/server/plugins";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleSecretsEnv,
  handleSecretsImport,
  handleSecretsList,
  handleSecretsPut,
  handleSecretsTokenCreate,
  handleSecretsTokenList,
  handleSecretsTokenRevoke,
} from "./secrets";

const { log, printBanner } = vi.hoisted(() => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    warn: vi.fn(),
  },
  printBanner: vi.fn(),
}));

// The server assembles for real: only the config and the prompts are mocked.
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig: vi.fn(),
  p: {
    confirm: vi.fn(),
    isCancel: vi.fn(() => false),
    log,
    password: vi.fn(),
  },
}));

vi.mock("@/utils/printBanner", () => ({ printBanner }));

vi.mock("./utils/load-hot-updater", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/load-hot-updater")>()),
  findDefaultConfigPaths: vi.fn(() => []),
  loadHotUpdater: vi.fn(),
}));

const TOKEN = `hu_vault_${"T".repeat(43)}`;
const CONSOLE_URL = "https://console.example.com";

const messages = () =>
  log.message.mock.calls.map(([text]) =>
    stripVTControlCharacters(String(text)),
  );

let database: EngineDatabase & { dispose: ReturnType<typeof vi.fn> };
let directory: string;

const configure = (config: {
  readonly database?: EngineDatabase | RemoteDatabase;
  readonly plugins?: readonly AnyHotUpdaterPlugin[];
}) => {
  vi.mocked(loadConfig).mockResolvedValue({
    plugins: [],
    storage: createReleaseCatalogTestStorage(),
    ...config,
  } as never);
};

/** vault()'s API over the configured database, without a master key. */
const vaultOf = (): VaultApi =>
  assembleServer({
    database: { name: "memory", adapter: database.adapter },
    plugins: [vault()],
  }).api["vault"] as VaultApi;

/** A Console that answers each request with `respond`, and what it received. */
const mockConsole = (respond: (request: Request) => unknown) => {
  const requests: {
    method: string;
    url: string;
    auth: string | null;
    body: unknown;
  }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      method: request.method,
      url: request.url,
      auth: request.headers.get("authorization"),
      body: request.method === "GET" ? undefined : await request.clone().json(),
    });
    const answer = await respond(request);
    return answer instanceof Response ? answer : Response.json(answer);
  });
  return requests;
};

const SECRET = {
  id: "sec-1",
  name: "asc-api-key",
  kind: "asc-api-key",
  version: 1,
  metadata: { keyId: "KEY1", issuerId: "issuer-1" },
  createdAtMs: 1_790_000_000_000,
  updatedAtMs: 1_790_000_000_000,
};

beforeEach(async () => {
  vi.clearAllMocks();
  database = {
    name: "memory",
    adapter: createMemoryAdapter(),
    dispose: vi.fn(async () => {}),
  };
  configure({ database, plugins: [apiKeys(), vault()] });
  vi.stubEnv("HOT_UPDATER_VAULT_MASTER_KEY", "");
  vi.stubEnv("HOT_UPDATER_CONSOLE_URL", CONSOLE_URL);
  vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", TOKEN);
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-secrets-"));
});

afterEach(async () => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(directory, { force: true, recursive: true });
});

describe("hot-updater secrets token, in process without a master key", () => {
  it("issues a scoped token through the config's vault(), printing it once", async () => {
    await handleSecretsTokenCreate({
      name: "ci-ios",
      secrets: ["asc-api-key"],
      kinds: ["deploy-credentials"],
      actions: ["read", "write"],
      expiresInDays: 30,
    });

    expect(process.exitCode).toBeUndefined();
    const printed = messages().join("\n");
    const token = /Token:\s+(hu_vault_\S+)/u.exec(printed)?.[1];
    expect(token).toMatch(/^hu_vault_[A-Za-z0-9_-]{43}$/u);
    expect(printed.split(token!).length - 1).toBe(1);
    const verified = await vaultOf().verifyToken({ token: token! });
    expect(verified).toMatchObject({
      ok: true,
      token: {
        name: "ci-ios",
        scope: {
          secrets: { names: ["asc-api-key"], kinds: ["deploy-credentials"] },
          actions: ["read", "write"],
        },
        expiresAtMs: expect.any(Number),
      },
    });
    expect(
      authorizeVaultToken(
        (verified as Extract<typeof verified, { ok: true }>).token,
        {
          action: "write",
          secret: { name: "asc-api-key", kind: "asc-api-key" },
        },
      ),
    ).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("It will not be shown again."),
    );
    expect(database.dispose).toHaveBeenCalledOnce();
  });

  it("lists tokens as JSON without their plaintext, and revokes one", async () => {
    const { token, metadata } = await vaultOf().issueToken({
      name: "ci",
      scope: { secrets: { kinds: ["generic"] }, actions: ["read"] },
    });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleSecretsTokenList({ json: true });
    const json = String(output.mock.calls[0]?.[0]);
    expect(JSON.parse(json)).toEqual([metadata]);
    expect(json).not.toContain(token);
    expect(json).not.toContain("hash");

    await handleSecretsTokenRevoke(metadata.id, { yes: true });
    expect(process.exitCode).toBeUndefined();
    await expect(vaultOf().verifyToken({ token })).resolves.toEqual({
      ok: false,
      reason: "revoked",
    });
    expect(messages().join("\n")).toContain("Vault token revoked");
  });

  it("refuses a scope the vault does not take, issuing nothing", async () => {
    await handleSecretsTokenCreate({ name: "ci", actions: ["read"] });

    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      "A token's scope names at least one secret or kind.",
    );
    await expect(vaultOf().listTokens()).resolves.toEqual([]);
  });

  it("issues only the actions the Console serves, opening no database otherwise", async () => {
    await handleSecretsTokenCreate({
      name: "ci",
      kinds: ["bundle-signing-key"],
      actions: ["sign"],
    });

    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      "--actions takes read and write, the actions the Console serves a vault token, not sign.",
    );
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("says to add vault() when the config lists none", async () => {
    configure({ database, plugins: [apiKeys()] });

    await handleSecretsTokenList();

    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      'hot-updater.config.ts lists no vault() in plugins. Add vault() to plugins, the same plugin your server runs (import { vault } from "hot-updater/plugins").',
    );
  });
});

describe("hot-updater secrets list and put, through the Console", () => {
  it("lists the secrets the token reaches with only the two connection variables", async () => {
    const requests = mockConsole(() => ({ secrets: [SECRET] }));

    await handleSecretsList();

    expect(requests).toEqual([
      {
        method: "GET",
        url: `${CONSOLE_URL}/_hot-updater/vault/v1/secrets`,
        auth: `Bearer ${TOKEN}`,
        body: undefined,
      },
    ]);
    expect(messages().join("\n")).toMatch(/asc-api-key.*asc-api-key.*1/u);
    // Never opened the database: the Console serves the list.
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("sends an App Store Connect key's files in base64 to the write route", async () => {
    const p8 = path.join(directory, "AuthKey_KEY1.p8");
    await fs.writeFile(
      p8,
      "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
    );
    const requests = mockConsole(() => ({ secret: SECRET }));

    await handleSecretsPut("asc-api-key", {
      kind: "asc-api-key",
      p8,
      keyId: "KEY1",
      issuerId: "issuer-1",
    });

    expect(process.exitCode).toBeUndefined();
    expect(requests).toEqual([
      {
        method: "PUT",
        url: `${CONSOLE_URL}/_hot-updater/vault/v1/secrets/asc-api-key`,
        auth: `Bearer ${TOKEN}`,
        body: {
          kind: "asc-api-key",
          value: {
            p8: Buffer.from(await fs.readFile(p8)).toString("base64"),
            keyId: "KEY1",
            issuerId: "issuer-1",
          },
        },
      },
    ]);
    expect(messages().join("\n")).toContain("Secret stored");
  });

  it("reads a keystore's passwords from the environment, never the command line", async () => {
    const keystore = path.join(directory, "release.keystore");
    await fs.writeFile(keystore, Buffer.from([0xfe, 0xed, 1, 2]));
    vi.stubEnv("HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD", " store pass ");
    vi.stubEnv("HOT_UPDATER_ANDROID_KEY_PASSWORD", "key-pass");
    const requests = mockConsole(() => ({ secret: SECRET }));

    await handleSecretsPut("release-keystore", {
      kind: "android-keystore",
      keystore,
      keyAlias: "upload",
    });

    expect(requests[0]?.body).toEqual({
      kind: "android-keystore",
      value: {
        keystore: Buffer.from([0xfe, 0xed, 1, 2]).toString("base64"),
        storePassword: " store pass ",
        keyAlias: "upload",
        keyPassword: "key-pass",
      },
    });
  });

  it("stores variables as NAME=value, or copies NAME from the environment", async () => {
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "from-env");
    const requests = mockConsole(() => ({ secret: SECRET }));

    await handleSecretsPut("deploy", {
      kind: "deploy-credentials",
      variables: ["AWS_ACCESS_KEY_ID=AKIA1", "AWS_SECRET_ACCESS_KEY"],
    });

    expect(requests[0]?.body).toEqual({
      kind: "deploy-credentials",
      value: {
        AWS_ACCESS_KEY_ID: "AKIA1",
        AWS_SECRET_ACCESS_KEY: "from-env",
      },
    });

    // The version stays readable in the masked output, though 1 is a value.
    vi.mocked(log.message).mockClear();
    await handleSecretsPut("deploy", { kind: "generic", variables: ["A=1"] });
    expect(maskSecretValues(messages().join("\n"))).toMatch(/Version:\s+v1/u);
  });

  it("refuses another kind's flags, sending nothing", async () => {
    const requests = mockConsole(() => ({ secret: SECRET }));

    await handleSecretsPut("deploy", {
      kind: "generic",
      variables: ["A=1"],
      keyId: "KEY1",
    });

    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      "A generic takes NAME=value or NAME arguments, not --key-id <id>.",
    );
    expect(requests).toEqual([]);
  });

  it("surfaces the Console's refusal of a token without write", async () => {
    mockConsole(() =>
      Response.json(
        {
          error: {
            code: "forbidden",
            message: "The vault token's scope does not allow write.",
          },
        },
        { status: 403 },
      ),
    );

    await handleSecretsPut("deploy", { kind: "generic", variables: ["A=1"] });

    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      `The Console at ${CONSOLE_URL} refused the request: The vault token's scope does not allow write.`,
    );
  });

  it("names both connection variables when they are unset", async () => {
    vi.stubEnv("HOT_UPDATER_CONSOLE_URL", "");
    vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", "");

    await handleSecretsList();

    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      "hot-updater secrets list reads from the Console's vault, and HOT_UPDATER_CONSOLE_URL and HOT_UPDATER_VAULT_TOKEN are not set. Set HOT_UPDATER_CONSOLE_URL and HOT_UPDATER_VAULT_TOKEN to reach the vault.",
    );
  });
});

describe("hot-updater secrets import", () => {
  const DEPLOY = {
    id: "sec-2",
    name: "deploy-credentials",
    kind: "deploy-credentials",
    version: 1,
    metadata: { variables: ["HOT_UPDATER_OLD_ONLY", "HOT_UPDATER_S3_REGION"] },
    createdAtMs: 1_790_000_000_000,
    updatedAtMs: 1_790_000_000_000,
  };
  const S3_SECRET = "s3-import-secret/with+chars";

  const writeEnvFile = async (lines: readonly string[]) => {
    const file = path.join(directory, ".env.hotupdater");
    await fs.writeFile(file, lines.join("\n"));
    return file;
  };

  /** A Console listing `listed` and storing what it is sent as the next version. */
  const importConsole = (listed: readonly unknown[] = []) =>
    mockConsole((request) =>
      request.method === "GET"
        ? { secrets: listed }
        : request
            .clone()
            .json()
            .then((body: { kind: string; value: Record<string, string> }) => ({
              secret: {
                ...DEPLOY,
                kind: body.kind,
                version: 2,
                metadata: { variables: Object.keys(body.value).sort() },
              },
            })),
    );

  it("stores the file's variables as one deploy-credentials secret and keeps only the connection, init's choices, the client API key, and the master key", async () => {
    const requests = importConsole();
    // Only the file connects: nothing else will be left to.
    vi.stubEnv("HOT_UPDATER_CONSOLE_URL", undefined);
    vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", undefined);
    const file = await writeEnvFile([
      "HOT_UPDATER_INIT_BUILD=bare",
      "HOT_UPDATER_INIT_PROVIDER=aws",
      "HOT_UPDATER_API_KEY=client-key-ships-in-the-app",
      "# The bucket",
      "HOT_UPDATER_S3_BUCKET_NAME=bundles",
      "HOT_UPDATER_S3_REGION=us-east-1",
      `HOT_UPDATER_S3_SECRET_ACCESS_KEY=${JSON.stringify(S3_SECRET)}`,
      "HOT_UPDATER_AWS_PROFILE=",
      "",
      "# The vault",
      `HOT_UPDATER_CONSOLE_URL=${CONSOLE_URL}`,
      `HOT_UPDATER_VAULT_TOKEN=${TOKEN}`,
      "HOT_UPDATER_VAULT_MASTER_KEY=master-key-stays",
    ]);

    await handleSecretsImport(file, { yes: true });

    expect(process.exitCode).toBeUndefined();
    expect(requests).toEqual([
      {
        method: "GET",
        url: `${CONSOLE_URL}/_hot-updater/vault/v1/secrets`,
        auth: `Bearer ${TOKEN}`,
        body: undefined,
      },
      {
        method: "PUT",
        url: `${CONSOLE_URL}/_hot-updater/vault/v1/secrets/deploy-credentials`,
        auth: `Bearer ${TOKEN}`,
        body: {
          kind: "deploy-credentials",
          expectedVersion: 0,
          value: {
            HOT_UPDATER_S3_BUCKET_NAME: "bundles",
            HOT_UPDATER_S3_REGION: "us-east-1",
            HOT_UPDATER_S3_SECRET_ACCESS_KEY: S3_SECRET,
          },
        },
      },
    ]);
    // An empty variable holds nothing to move, and stays.
    await expect(fs.readFile(file, "utf-8")).resolves.toBe(
      [
        "HOT_UPDATER_INIT_BUILD=bare",
        "HOT_UPDATER_INIT_PROVIDER=aws",
        "HOT_UPDATER_API_KEY=client-key-ships-in-the-app",
        "HOT_UPDATER_AWS_PROFILE=",
        "",
        "# The vault",
        `HOT_UPDATER_CONSOLE_URL=${CONSOLE_URL}`,
        `HOT_UPDATER_VAULT_TOKEN=${TOKEN}`,
        "HOT_UPDATER_VAULT_MASTER_KEY=master-key-stays",
      ].join("\n"),
    );
    const printed = messages().join("\n");
    expect(printed).toContain(
      "HOT_UPDATER_S3_BUCKET_NAME, HOT_UPDATER_S3_REGION, HOT_UPDATER_S3_SECRET_ACCESS_KEY",
    );
    expect(printed).not.toContain(S3_SECRET);
    expect(maskSecretValues(`key ${S3_SECRET}`)).not.toContain(S3_SECRET);
  });

  it("reads values as process.loadEnvFile does, inline comments and quotes included", async () => {
    const requests = importConsole();
    const file = await writeEnvFile([
      "HOT_UPDATER_S3_REGION=us-east-1 # the bucket's region",
      "HOT_UPDATER_S3_SECRET_ACCESS_KEY='quoted # kept'",
    ]);

    await handleSecretsImport(file, { yes: true });

    expect(requests.at(-1)?.body).toEqual({
      kind: "deploy-credentials",
      expectedVersion: 0,
      value: {
        HOT_UPDATER_S3_REGION: "us-east-1",
        HOT_UPDATER_S3_SECRET_ACCESS_KEY: "quoted # kept",
      },
    });
    await expect(fs.readFile(file, "utf-8")).resolves.toBe("");
  });

  it("sends nothing when a line it moves could not be removed", async () => {
    const requests = importConsole();
    const multiline = [
      "HOT_UPDATER_S3_REGION=us-east-1",
      'SERVICE_ACCOUNT="first',
      'second"',
    ];
    const file = await writeEnvFile(multiline);

    await handleSecretsImport(file, { yes: true });

    expect(log.error).toHaveBeenCalledWith(
      `SERVICE_ACCOUNT in ${file} spans several lines, which the file keeps in one: store it with hot-updater secrets put, then remove it from ${file}.`,
    );
    await expect(fs.readFile(file, "utf-8")).resolves.toBe(
      multiline.join("\n"),
    );

    await writeEnvFile(["export HOT_UPDATER_S3_REGION=us-east-1"]);
    await handleSecretsImport(file, { yes: true });

    expect(log.error).toHaveBeenCalledWith(
      `${file} sets HOT_UPDATER_S3_REGION in a form the import cannot remove, such as export NAME=value: write it as NAME=value.`,
    );
    expect(requests).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it("says what a new version drops from the secret it replaces", async () => {
    importConsole([DEPLOY]);
    const file = await writeEnvFile(["HOT_UPDATER_S3_REGION=eu-west-1"]);

    await handleSecretsImport(file, { yes: true });

    expect(log.warn).toHaveBeenCalledWith(
      `deploy-credentials v1 also sets HOT_UPDATER_OLD_ONLY, which ${file} does not: the new version replaces it whole, without it.`,
    );
    await expect(fs.readFile(file, "utf-8")).resolves.toBe("");
  });

  it("stores in the secret --name names", async () => {
    const requests = importConsole();
    const file = await writeEnvFile(["WIDGET_TOKEN=abc"]);

    await handleSecretsImport(file, { name: "widget-deploy", yes: true });

    expect(requests.at(-1)?.url).toBe(
      `${CONSOLE_URL}/_hot-updater/vault/v1/secrets/widget-deploy`,
    );
  });

  it("refuses a variable another secret sets, leaving the file as it was", async () => {
    const requests = importConsole([
      { ...DEPLOY, id: "sec-3", name: "shared", kind: "generic" },
    ]);
    const lines = ["HOT_UPDATER_S3_REGION=us-east-1", "OTHER=1"];
    const file = await writeEnvFile(lines);

    await handleSecretsImport(file, { yes: true });

    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      `The vault's other secrets already set HOT_UPDATER_S3_REGION (shared): a variable is kept in one secret. Remove it there, or from ${file}, first.`,
    );
    expect(requests.map(({ method }) => method)).toEqual(["GET"]);
    await expect(fs.readFile(file, "utf-8")).resolves.toBe(lines.join("\n"));
  });

  it("asks before it moves anything, and needs -y without a terminal", async () => {
    const requests = importConsole();
    const file = await writeEnvFile(["HOT_UPDATER_S3_REGION=us-east-1"]);

    await handleSecretsImport(file);

    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      `Store 1 variable from ${file} as the vault's deploy-credentials, and remove it from ${file}? Re-run with -y in a non-interactive shell.`,
    );
    expect(requests.map(({ method }) => method)).toEqual(["GET"]);
    await expect(fs.readFile(file, "utf-8")).resolves.toBe(
      "HOT_UPDATER_S3_REGION=us-east-1",
    );
  });

  it("stores nothing when the file changes while it asks", async () => {
    const requests = importConsole();
    const file = await writeEnvFile(["HOT_UPDATER_S3_REGION=us-east-1"]);
    const { p } = await import("@hot-updater/cli-tools");
    const tty = process.stdin.isTTY;
    process.stdin.isTTY = true;
    vi.mocked(p.confirm).mockImplementationOnce(async () => {
      await fs.writeFile(file, "HOT_UPDATER_S3_REGION=eu-west-1");
      return true;
    });
    try {
      await handleSecretsImport(file);
    } finally {
      process.stdin.isTTY = tty;
    }

    expect(log.error).toHaveBeenCalledWith(
      `${file} changed since it was read: run hot-updater secrets import again.`,
    );
    expect(requests.map(({ method }) => method)).toEqual(["GET"]);
    await expect(fs.readFile(file, "utf-8")).resolves.toBe(
      "HOT_UPDATER_S3_REGION=eu-west-1",
    );
  });

  it("removes nothing when the file changes while the vault stores it", async () => {
    let file = "";
    const requests = mockConsole(async (request) => {
      if (request.method === "GET") return { secrets: [] };
      await fs.writeFile(file, "HOT_UPDATER_S3_REGION=eu-west-1");
      return { secret: { ...DEPLOY, version: 3 } };
    });
    file = await writeEnvFile(["HOT_UPDATER_S3_REGION=us-east-1"]);

    await handleSecretsImport(file, { yes: true });

    expect(log.error).toHaveBeenCalledWith(
      `${file} changed while deploy-credentials v3 was stored from what it held before, so nothing was removed from it: run hot-updater secrets import again.`,
    );
    expect(requests.map(({ method }) => method)).toEqual(["GET", "PUT"]);
    await expect(fs.readFile(file, "utf-8")).resolves.toBe(
      "HOT_UPDATER_S3_REGION=eu-west-1",
    );
  });

  it("warns when config loads cannot find the connection the imported file holds", async () => {
    importConsole();
    vi.stubEnv("HOT_UPDATER_CONSOLE_URL", undefined);
    vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", undefined);
    const file = path.join(directory, ".env.ci");
    await fs.writeFile(
      file,
      [
        `HOT_UPDATER_CONSOLE_URL=${CONSOLE_URL}`,
        `HOT_UPDATER_VAULT_TOKEN=${TOKEN}`,
        "HOT_UPDATER_S3_REGION=us-east-1",
      ].join("\n"),
    );

    await handleSecretsImport(file, { yes: true });

    expect(log.warn).toHaveBeenCalledWith(
      "Commands that use the config's database, storage, or signing read HOT_UPDATER_CONSOLE_URL and HOT_UPDATER_VAULT_TOKEN from the environment or .env.hotupdater, where they are not set: set them there to deploy with the imported variables.",
    );
  });

  it("writes over the version it listed, keeping the file when another write moved the secret on", async () => {
    const requests = mockConsole((request) =>
      request.method === "GET"
        ? { secrets: [DEPLOY] }
        : Response.json(
            {
              error: {
                code: "conflict",
                message:
                  'The secret "deploy-credentials" is at version 2 now, not 1. Read it again before you store the next version.',
              },
            },
            { status: 409 },
          ),
    );
    const file = await writeEnvFile(["HOT_UPDATER_S3_REGION=us-east-1"]);

    await handleSecretsImport(file, { yes: true });

    expect(requests.at(-1)?.body).toMatchObject({ expectedVersion: 1 });
    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("is at version 2 now, not 1"),
    );
    await expect(fs.readFile(file, "utf-8")).resolves.toBe(
      "HOT_UPDATER_S3_REGION=us-east-1",
    );
  });

  it("keeps the file when the Console refuses the write", async () => {
    mockConsole((request) =>
      request.method === "GET"
        ? { secrets: [] }
        : Response.json(
            { error: { code: "forbidden", message: "no write" } },
            { status: 403 },
          ),
    );
    const file = await writeEnvFile(["HOT_UPDATER_S3_REGION=us-east-1"]);

    await handleSecretsImport(file, { yes: true });

    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      `The Console at ${CONSOLE_URL} refused the request: no write`,
    );
    await expect(fs.readFile(file, "utf-8")).resolves.toBe(
      "HOT_UPDATER_S3_REGION=us-east-1",
    );
  });

  it("reaches nothing when the file holds only what stays, or does not exist", async () => {
    const requests = importConsole();
    const file = await writeEnvFile([`HOT_UPDATER_CONSOLE_URL=${CONSOLE_URL}`]);

    await handleSecretsImport(file, { yes: true });
    expect(process.exitCode).toBeUndefined();
    expect(messages().join("\n")).toContain(
      `${file} holds no variables to move`,
    );

    await handleSecretsImport(path.join(directory, "missing.env"), {
      yes: true,
    });
    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      `${path.join(directory, "missing.env")} does not exist.`,
    );
    expect(requests).toEqual([]);
  });
});

describe("hot-updater secrets env", () => {
  const variablesConsole = () =>
    mockConsole((request) =>
      request.method === "GET"
        ? {
            secrets: [
              {
                ...SECRET,
                name: "deploy",
                kind: "deploy-credentials",
                metadata: { variables: ["FROM_VAULT", "KEPT"] },
              },
            ],
          }
        : {
            secrets: [
              {
                name: "deploy",
                kind: "deploy-credentials",
                version: 1,
                value: { FROM_VAULT: "vault-value", KEPT: "vault-kept" },
              },
            ],
            errors: [],
          },
    );

  it("runs the command with the vault's variables, the environment's own non-empty ones winning", async () => {
    const requests = variablesConsole();
    vi.stubEnv("KEPT", "env-kept");
    // Empty counts as unset, as vaultEnv reads it.
    vi.stubEnv("FROM_VAULT", "");

    await handleSecretsEnv([
      process.execPath,
      "-e",
      'process.exit(process.env.FROM_VAULT === "vault-value" && process.env.KEPT === "env-kept" ? 0 : 3)',
    ]);

    expect(log.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(
      requests.map(({ method, url, body }) => [method, url, body]),
    ).toEqual([
      ["GET", `${CONSOLE_URL}/_hot-updater/vault/v1/secrets`, undefined],
      [
        "POST",
        `${CONSOLE_URL}/_hot-updater/vault/v1/resolve`,
        { names: ["deploy"] },
      ],
    ]);
  });

  it("exits with the command's code", async () => {
    variablesConsole();

    await handleSecretsEnv([process.execPath, "-e", "process.exit(7)"]);

    expect(process.exitCode).toBe(7);
  });
});
