import fs from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CredentialUnavailableError,
  createCredentialResolver,
} from "./credentialResolver";
import { maskSecretValues } from "./secretMasking";

const P8_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgvaultSourceSpecKey1",
  "-----END PRIVATE KEY-----",
].join("\n");
const KEYSTORE = Buffer.from([0xfe, 0xed, 0xfe, 0xed, 0, 1, 2, 3]);
const TOKEN = `hu_vault_${"A".repeat(43)}`;
const CONNECTION = {
  HOT_UPDATER_CONSOLE_URL: "https://console.example.com/",
  HOT_UPDATER_VAULT_TOKEN: TOKEN,
};

const VALUES = {
  "asc-api-key": {
    kind: "asc-api-key",
    value: {
      p8: Buffer.from(P8_KEY).toString("base64"),
      keyId: "ABC123",
      issuerId: "issuer-1",
    },
  },
  "release-keystore": {
    kind: "android-keystore",
    value: {
      keystore: KEYSTORE.toString("base64"),
      storePassword: "store-password-1",
      keyAlias: "upload",
      keyPassword: "key-password-1",
    },
  },
  "deploy-env": { kind: "deploy-credentials", value: { AWS_KEY: "x" } },
  "broken-asc": { kind: "asc-api-key", value: { keyId: "ABC123" } },
} as const;

/** A Console that resolves `VALUES`, and the requests it received. */
const mockConsole = (
  respond?: (request: Request) => Response | Promise<Response>,
) => {
  const requests: { url: string; headers: Headers; body: unknown }[] = [];
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const body: unknown =
        request.method === "GET" ? undefined : await request.clone().json();
      requests.push({ url: request.url, headers: request.headers, body });
      if (respond) return respond(request);
      const { names } = body as { names: (keyof typeof VALUES)[] };
      return Response.json({
        secrets: names.flatMap((name) =>
          name in VALUES ? [{ name, version: 1, ...VALUES[name] }] : [],
        ),
        errors: names
          .filter((name) => !(name in VALUES))
          .map((name) => ({ name, code: "not_found" })),
      });
    });
  return { fetch, requests };
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the vault as the credential resolver's default source", () => {
  it("resolves a build's credentials in one request, as 0600 files, masked", async () => {
    const { requests } = mockConsole();
    const resolver = createCredentialResolver({ env: CONNECTION });

    const [asc, keystore] = await Promise.all([
      resolver.resolve({ kind: "asc-api-key" }),
      resolver.resolve({ kind: "android-keystore", name: "release-keystore" }),
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      "https://console.example.com/_hot-updater/vault/v1/resolve",
    );
    expect(requests[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(requests[0]!.body).toEqual({
      names: ["asc-api-key", "release-keystore"],
    });

    expect(asc).toMatchObject({ keyId: "ABC123", issuerId: "issuer-1" });
    expect(asc.keyPath).toMatch(/AuthKey_ABC123\.p8$/u);
    await expect(fs.readFile(asc.keyPath, "utf-8")).resolves.toBe(P8_KEY);
    expect((await fs.stat(asc.keyPath)).mode & 0o777).toBe(0o600);
    expect(keystore).toMatchObject({
      storePassword: "store-password-1",
      keyAlias: "upload",
      keyPassword: "key-password-1",
    });
    await expect(fs.readFile(keystore.storeFile)).resolves.toEqual(KEYSTORE);
    expect((await fs.stat(keystore.storeFile)).mode & 0o777).toBe(0o600);

    expect(
      maskSecretValues(
        `${TOKEN} -Pstore=store-password-1 -Pkey=key-password-1 ${P8_KEY}`,
      ),
    ).not.toMatch(/hu_vault_|password-1|vaultSourceSpecKey/u);

    await resolver.dispose();
    await expect(fs.access(asc.keyPath)).rejects.toThrow();
  });

  it("uses an environment override and never calls the Console", async () => {
    const { fetch } = mockConsole();
    vi.stubEnv("HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON", '{"type":"x"}');
    const resolver = createCredentialResolver({ env: CONNECTION });

    await expect(
      resolver.resolve({ kind: "play-service-account" }),
    ).resolves.toEqual({ json: '{"type":"x"}' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("names the Console and the override env vars when the Console is unreachable", async () => {
    mockConsole(() => {
      throw new TypeError("fetch failed");
    });
    const resolver = createCredentialResolver({ env: CONNECTION });

    const error = await resolver
      .resolve({ kind: "asc-api-key" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CredentialUnavailableError);
    expect((error as Error).message).toBe(
      "Could not reach the Console at https://console.example.com (fetch failed). Set HOT_UPDATER_ASC_KEY_PATH (or HOT_UPDATER_ASC_KEY), HOT_UPDATER_ASC_KEY_ID, and HOT_UPDATER_ASC_ISSUER_ID to provide asc-api-key without the vault.",
    );
  });

  it("names the connection and override env vars without a token, sending nothing", async () => {
    const { fetch } = mockConsole();
    vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", "");
    const resolver = createCredentialResolver({
      env: { HOT_UPDATER_CONSOLE_URL: "https://console.example.com" },
    });

    await expect(
      resolver.resolve({ kind: "android-keystore", name: "release-keystore" }),
    ).rejects.toThrow(
      "android-keystore release-keystore resolves from the Console's vault, and HOT_UPDATER_VAULT_TOKEN is not set. Set HOT_UPDATER_CONSOLE_URL and HOT_UPDATER_VAULT_TOKEN to reach the vault. Set HOT_UPDATER_ANDROID_KEYSTORE_PATH (or HOT_UPDATER_ANDROID_KEYSTORE_BASE64), HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD, HOT_UPDATER_ANDROID_KEY_ALIAS, and HOT_UPDATER_ANDROID_KEY_PASSWORD to provide android-keystore without the vault.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      401,
      "unauthorized",
      "The vault token was revoked.",
      "The Console at https://console.example.com refused HOT_UPDATER_VAULT_TOKEN: The vault token was revoked.",
    ],
    [
      403,
      "forbidden",
      "The vault token's scope does not allow reading asc-api-key.",
      "The Console at https://console.example.com refused the request: The vault token's scope does not allow reading asc-api-key.",
    ],
    [
      503,
      "vault_locked",
      "The vault is locked.",
      "The Console at https://console.example.com answered 503 vault_locked: The vault is locked.",
    ],
  ])("surfaces a %i from the Console", async (status, code, message, shown) => {
    mockConsole(() => Response.json({ error: { code, message } }, { status }));
    const resolver = createCredentialResolver({ env: CONNECTION });

    const error = await resolver
      .resolve({ kind: "asc-api-key" })
      .catch((e: Error) => e);
    expect((error as Error).message).toContain(shown);
    expect((error as Error).message).toContain(
      "Set HOT_UPDATER_ASC_KEY_PATH (or HOT_UPDATER_ASC_KEY)",
    );
  });

  it("names the command that stores each missing build credential once", async () => {
    mockConsole();
    const resolver = createCredentialResolver({ env: CONNECTION });

    await expect(
      resolver.resolve({ kind: "play-service-account" }),
    ).rejects.toThrow(
      "play-service-account is not in the vault at https://console.example.com. Store it once from a machine that reaches the Console, with `npx hot-updater secrets put play-service-account --kind play-service-account --service-account <key.json>`, and builds, CI's included, read it with their vault token. Set HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH (or HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON) to provide play-service-account without the vault.",
    );
    await expect(
      resolver.resolve({ kind: "android-keystore", name: "widget-keystore" }),
    ).rejects.toThrow(
      "widget-keystore (android-keystore) is not in the vault at https://console.example.com. Store it once from a machine that reaches the Console, with `npx hot-updater secrets put widget-keystore --kind android-keystore --keystore <release.jks> --key-alias <alias>`, and builds, CI's included, read it with their vault token. Set HOT_UPDATER_ANDROID_KEYSTORE_PATH",
    );
  });

  it("names the token to issue when the scope does not reach a credential", async () => {
    mockConsole(() =>
      Response.json(
        {
          error: {
            code: "forbidden",
            message:
              "The vault token's scope does not allow reading play-service-account.",
          },
        },
        { status: 403 },
      ),
    );
    const resolver = createCredentialResolver({ env: CONNECTION });

    await expect(
      resolver.resolve({ kind: "play-service-account" }),
    ).rejects.toThrow(
      "The Console at https://console.example.com refused the request: The vault token's scope does not allow reading play-service-account. When play-service-account is stored, give the build a vault token whose scope allows read on it, such as one from `npx hot-updater secrets token create --name ci-native --secrets play-service-account,<the build's other secrets> --actions read`; when it is not, store it once with `npx hot-updater secrets put play-service-account --kind play-service-account --service-account <key.json>`. Set HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH",
    );
  });

  it("refuses a secret of another kind or shape, and a name the vault does not have", async () => {
    mockConsole();
    const resolver = createCredentialResolver({ env: CONNECTION });

    await expect(
      resolver.resolve({ kind: "android-keystore", name: "deploy-env" }),
    ).rejects.toThrow(
      "The vault's deploy-env is a deploy-credentials, not an android-keystore.",
    );
    await expect(
      resolver.resolve({ kind: "asc-api-key", name: "broken-asc" }),
    ).rejects.toThrow(
      "The vault's broken-asc is not a valid asc-api-key: A secret of kind asc-api-key needs p8.",
    );
    await expect(
      resolver.resolve({ kind: "asc-api-key", name: "widget-asc" }),
    ).rejects.toThrow(
      "widget-asc (asc-api-key) is not in the vault at https://console.example.com. Store it once from a machine that reaches the Console, with `npx hot-updater secrets put widget-asc --kind asc-api-key --p8 <AuthKey.p8> --key-id <key-id> --issuer-id <issuer-id>`, and builds, CI's included, read it with their vault token. Set HOT_UPDATER_ASC_KEY_PATH (or HOT_UPDATER_ASC_KEY), HOT_UPDATER_ASC_KEY_ID, and HOT_UPDATER_ASC_ISSUER_ID to provide asc-api-key without the vault.",
    );
  });
});
