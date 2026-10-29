import type { TokenCredential } from "@azure/core-auth";
import { maskSecretValues } from "@hot-updater/cli-tools";
import { linesWiderThan } from "@hot-updater/test-utils/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { keyVault } from "./keyVault";

const vaults = vi.hoisted(() => ({
  clients: [] as {
    url: string;
    credential: TokenCredential;
    options: { disableChallengeResourceVerification?: boolean };
  }[],
  getSecret: vi.fn<(name: string) => Promise<{ value?: string }>>(),
  setSecret:
    vi.fn<
      (
        name: string,
        value: string,
        options: { tags?: Record<string, string> },
      ) => Promise<unknown>
    >(),
}));

vi.mock("@azure/keyvault-secrets", () => ({
  SecretClient: class {
    constructor(
      url: string,
      credential: TokenCredential,
      options: { disableChallengeResourceVerification?: boolean },
    ) {
      vaults.clients.push({ url, credential, options });
    }
    getSecret = vaults.getSecret;
    setSecret = vaults.setSecret;
  },
}));

const context = { cwd: process.cwd() };
const VAULT_URL = "https://my-vault.vault.azure.net";

const credential: TokenCredential = {
  getToken: async () => ({
    token: "spec-access-token-0123456789",
    expiresOnTimestamp: Date.now() + 3_600_000,
  }),
};

/** An error as `@azure/keyvault-secrets` throws it for a refused request. */
const restError = (
  statusCode: number,
  code: string,
  message: string,
  inner?: string,
) =>
  Object.assign(new Error(message), {
    name: "RestError",
    statusCode,
    code,
    details: {
      error: {
        code,
        message,
        ...(inner ? { innerError: { code: inner } } : {}),
      },
    },
  });

const notFound = (name: string) =>
  restError(
    404,
    "SecretNotFound",
    `A secret with (name/id) ${name} was not found in this key vault.`,
  );

const rejectionOf = async (promise: Promise<unknown> | undefined) => {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
};

beforeEach(() => {
  vaults.clients.length = 0;
  vaults.getSecret.mockReset();
  vaults.setSecret.mockReset();
});

describe("keyVault names", () => {
  const describeName = (name: string, prefix?: string) =>
    keyVault({ vaultName: "my-vault", credential, prefix }).describe?.(name);

  it("keeps lower-case hyphenated names, and maps the others apart", () => {
    expect(describeName("asc-api-key")).toBe(
      `the secret "hot-updater-asc-api-key" in Azure Key Vault (${VAULT_URL})`,
    );
    expect(describeName("release-keystore", "")).toContain(
      '"release-keystore"',
    );

    const names = [
      "cloudflare-api-token",
      "cloudflare_api_token",
      "CLOUDFLARE_API_TOKEN",
      "Cloudflare.Api.Token",
      "cloudflare-api-token-1",
      "__proto__",
    ];
    const ids = names.map((name) => /"([^"]+)"/u.exec(describeName(name)!)![1]);

    expect(ids[0]).toBe("hot-updater-cloudflare-api-token");
    expect(ids[2]).toMatch(/^hot-updater-cloudflare-api-token--[0-9a-f]{10}$/u);
    expect(ids[5]).toMatch(/^hot-updater-proto--[0-9a-f]{10}$/u);
    // Key Vault matches names without regard to case.
    expect(new Set(ids.map((id) => id.toLowerCase())).size).toBe(names.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-zA-Z-]{1,127}$/u);
    // The same name maps to the same secret every time.
    expect(describeName("CLOUDFLARE_API_TOKEN")).toBe(
      describeName("CLOUDFLARE_API_TOKEN"),
    );
  });

  it("reads and stores a mapped name under its secret, tagged with the name", async () => {
    vaults.getSecret.mockResolvedValue({ value: "spec-token-value" });
    vaults.setSecret.mockResolvedValue({});
    const secrets = keyVault({ vaultName: "my-vault", credential });

    await secrets.set("CLOUDFLARE_API_TOKEN", "spec-token-value", context);
    const values = await secrets.get(["CLOUDFLARE_API_TOKEN"], context);

    const [id, , options] = vaults.setSecret.mock.calls[0]!;
    expect(id).toMatch(/^hot-updater-cloudflare-api-token--[0-9a-f]{10}$/u);
    expect(options).toEqual({
      tags: { "hot-updater-name": "CLOUDFLARE_API_TOKEN" },
    });
    expect(vaults.getSecret).toHaveBeenCalledWith(id);
    expect({ ...values }).toEqual({ CLOUDFLARE_API_TOKEN: "spec-token-value" });
  });
});

describe("keyVault get", () => {
  it("reads each name in parallel, and undefined for a missing secret", async () => {
    vaults.getSecret.mockImplementation(async (name) => {
      if (name === "hot-updater-asc-api-key") {
        return { value: '{"keyId":"K","p8":"spec-p8-value"}' };
      }
      throw notFound(name);
    });

    const values = await keyVault({ vaultName: "My-Vault", credential }).get(
      ["asc-api-key", "release-keystore", "asc-api-key"],
      context,
    );

    expect({ ...values }).toEqual({
      "asc-api-key": '{"keyId":"K","p8":"spec-p8-value"}',
      "release-keystore": undefined,
    });
    expect(Object.getPrototypeOf(values)).toBeNull();
    expect(vaults.getSecret.mock.calls).toEqual([
      ["hot-updater-asc-api-key"],
      ["hot-updater-release-keystore"],
    ]);
    expect(vaults.clients).toHaveLength(1);
    expect(vaults.clients[0]).toMatchObject({
      url: VAULT_URL,
      options: { disableChallengeResourceVerification: false },
    });
    expect(maskSecretValues('{"keyId":"K","p8":"spec-p8-value"}')).toBe(
      "********",
    );
  });

  it("fails on a 404 that is not a missing secret", async () => {
    vaults.getSecret.mockRejectedValue(
      Object.assign(new Error("Unexpected status code: 404"), {
        name: "RestError",
        statusCode: 404,
      }),
    );

    await expect(
      keyVault({ vaultUrl: "https://example.com", credential }).get(
        ["asc-api-key"],
        context,
      ),
    ).rejects.toThrow(
      "Azure Key Vault failed to read a secret.\nSecret: hot-updater-asc-api-key\nRestError (404): Unexpected status code: 404.",
    );
  });

  it("names the role when Azure refuses a read", async () => {
    vaults.getSecret.mockRejectedValue(
      restError(
        403,
        "Forbidden",
        "Caller is not authorized to perform action on resource.\r\nCaller: appid=1;oid=2",
        "ForbiddenByRbac",
      ),
    );

    const error = await rejectionOf(
      keyVault({ vaultName: "my-vault", credential }).get(
        ["asc-api-key"],
        context,
      ),
    );

    expect(error.message).toBe(
      [
        "Azure Key Vault refused to read a secret.",
        "Secret: hot-updater-asc-api-key",
        "ForbiddenByRbac (403): Caller is not authorized to perform action on",
        "resource.",
        "The Azure identity needs the Key Vault Secrets User role on the vault.",
        "With access policies, it needs the secret permissions get.",
        "A firewall may also refuse this network.",
      ].join("\n"),
    );
  });

  it("fails on a disabled secret instead of reading it as missing", async () => {
    vaults.getSecret.mockRejectedValue(
      restError(
        403,
        "Forbidden",
        "Operation get is not allowed on a disabled secret.",
        "SecretDisabled",
      ),
    );

    await expect(
      keyVault({ vaultName: "my-vault", credential }).get(
        ["asc-api-key"],
        context,
      ),
    ).rejects.toThrow(
      "Azure Key Vault can't read a secret.\nSecret: hot-updater-asc-api-key\nIts current version is disabled. Enable it, or store a new value.",
    );
  });

  it("says how to sign in when no identity is found", async () => {
    vaults.getSecret.mockRejectedValue(
      Object.assign(
        new Error("DefaultAzureCredential failed to retrieve a token."),
        { name: "AggregateAuthenticationError" },
      ),
    );

    await expect(
      keyVault({ vaultName: "my-vault", credential }).get(
        ["asc-api-key"],
        context,
      ),
    ).rejects.toThrow(
      [
        "keyVault found no Azure identity to read a secret.",
        "Secret: hot-updater-asc-api-key",
        "DefaultAzureCredential failed to retrieve a token.",
        "In CI, sign in with azure/login.",
        "On your machine, run az login.",
      ].join("\n"),
    );
  });

  it("says to sign in again on a refused token", async () => {
    vaults.getSecret.mockRejectedValue(
      restError(401, "Unauthorized", "AKV10032: Invalid issuer."),
    );

    await expect(
      keyVault({ vaultName: "my-vault", credential }).get(["n"], context),
    ).rejects.toThrow("refused the sign-in to read");
  });

  it("checks its settings on first use, not when the config loads", async () => {
    const check = (options: Parameters<typeof keyVault>[0]) =>
      keyVault({ credential, ...options }).get(["n"], context);

    await expect(check({})).rejects.toThrow(
      "keyVault needs a vaultName or a vaultUrl, and not both.",
    );
    await expect(
      check({ vaultName: "my-vault", vaultUrl: VAULT_URL }),
    ).rejects.toThrow("and not both");
    await expect(check({ vaultName: "my_vault" })).rejects.toThrow(
      'keyVault can\'t use the vault name "my_vault".\nUse 3 to 24 letters, digits, and single hyphens; start with a letter.',
    );
    await expect(check({ vaultName: "my--vault" })).rejects.toThrow(
      "single hyphens",
    );
    await expect(
      check({ vaultUrl: "http://my-vault.vault.azure.net" }),
    ).rejects.toThrow("Use an HTTPS origin");
    await expect(
      check({ vaultUrl: `${VAULT_URL}/secrets?x=1` }),
    ).rejects.toThrow("Use an HTTPS origin");
    await expect(
      check({ vaultName: "my-vault", prefix: "hot_updater_" }),
    ).rejects.toThrow("prefix takes letters, digits, and - only.");
    await expect(
      check({
        vaultName: "my-vault",
        credential: {} as TokenCredential,
      }),
    ).rejects.toThrow("credential must be a TokenCredential");
    expect(vaults.clients).toHaveLength(0);
  });

  it("refuses a name longer than Key Vault takes", async () => {
    await expect(
      keyVault({
        vaultName: "my-vault",
        credential,
        prefix: "p".repeat(100),
      }).get(["release-keystore-for-the-production-flavor"], context),
    ).rejects.toThrow("Key Vault takes up to 127 characters.");
    expect(vaults.getSecret).not.toHaveBeenCalled();
  });

  it("skips the challenge check only on a loopback vault URL", async () => {
    vaults.getSecret.mockResolvedValue({ value: "v" });

    await keyVault({ vaultUrl: "https://127.0.0.1:8443", credential }).get(
      ["n"],
      context,
    );
    await keyVault({
      vaultUrl: "https://my-vault.vault.azure.cn/",
      credential,
    }).get(["n"], context);

    expect(vaults.clients.map(({ url, options }) => [url, options])).toEqual([
      [
        "https://127.0.0.1:8443",
        { disableChallengeResourceVerification: true },
      ],
      [
        "https://my-vault.vault.azure.cn",
        { disableChallengeResourceVerification: false },
      ],
    ]);
  });

  it("signs with the credential it is given, and masks its tokens", async () => {
    vaults.getSecret.mockResolvedValue({ value: "v" });

    await keyVault({ vaultName: "my-vault", credential }).get(["n"], context);
    const token = await vaults.clients[0]!.credential.getToken(
      "https://vault.azure.net/.default",
    );

    expect(token?.token).toBe("spec-access-token-0123456789");
    expect(maskSecretValues("spec-access-token-0123456789")).toBe("********");
  });
});

describe("keyVault set", () => {
  it("adds a new version of the secret, tagged with its name", async () => {
    vaults.setSecret.mockResolvedValue({});

    await keyVault({ vaultName: "my-vault", credential }).set(
      "asc-api-key",
      '{"p8":"spec-new-p8-value"}',
      context,
    );

    expect(vaults.setSecret.mock.calls).toEqual([
      [
        "hot-updater-asc-api-key",
        '{"p8":"spec-new-p8-value"}',
        { tags: { "hot-updater-name": "asc-api-key" } },
      ],
    ]);
    expect(maskSecretValues('{"p8":"spec-new-p8-value"}')).toBe("********");
  });

  it("says how to recover or purge a deleted secret", async () => {
    vaults.setSecret.mockRejectedValue(
      restError(
        409,
        "Conflict",
        "Secret hot-updater-asc-api-key is currently in a deleted but recoverable state, and its name cannot be reused; in this state, the secret can only be recovered or purged.",
        "ObjectIsDeletedButRecoverable",
      ),
    );

    await expect(
      keyVault({ vaultName: "my-vault", credential }).set(
        "asc-api-key",
        "v",
        context,
      ),
    ).rejects.toThrow(
      [
        "Azure Key Vault can't write a secret: it was deleted.",
        "Secret: hot-updater-asc-api-key",
        "Recover it, or purge it:",
        "az keyvault secret recover --vault-name my-vault \\",
        "  --name hot-updater-asc-api-key",
        "az keyvault secret purge --vault-name my-vault \\",
        "  --name hot-updater-asc-api-key",
      ].join("\n"),
    );
  });

  it("says to wait for a secret that is still being deleted", async () => {
    vaults.setSecret.mockRejectedValue(
      restError(
        409,
        "Conflict",
        "Secret hot-updater-n is currently being deleted.",
        "ObjectIsBeingDeleted",
      ),
    );

    await expect(
      keyVault({ vaultName: "my-vault", credential }).set("n", "v", context),
    ).rejects.toThrow(
      "Azure Key Vault can't write a secret: it is being deleted.\nSecret: hot-updater-n\nTry again in a minute.",
    );
  });

  it("names the role a refused write needs", async () => {
    vaults.setSecret.mockRejectedValue(
      restError(
        403,
        "Forbidden",
        "Caller is not authorized.",
        "ForbiddenByRbac",
      ),
    );

    await expect(
      keyVault({ vaultName: "my-vault", credential }).set("n", "v", context),
    ).rejects.toThrow(
      "The Azure identity needs the Key Vault Secrets Officer role on the vault.\nWith access policies, it needs the secret permissions get and set.",
    );
  });

  it("stores a keystore JSON, and refuses an empty or oversized value before any request", async () => {
    vaults.setSecret.mockResolvedValue({});
    const adapter = keyVault({ vaultName: "my-vault", credential });
    // A 2048-bit RSA upload keystore is about 2.7 KB; base64 adds a third.
    const keystore = JSON.stringify({
      keystore: Buffer.alloc(8 * 1024, 7).toString("base64"),
      storePassword: "spec-store-password",
      keyAlias: "upload",
      keyPassword: "spec-key-password",
    });

    await adapter.set("release-keystore", keystore, context);
    await adapter.set("big", "x".repeat(25_600), context);
    expect(vaults.setSecret).toHaveBeenCalledTimes(2);

    vaults.setSecret.mockClear();
    await expect(adapter.set("name", "", context)).rejects.toThrow(
      "keyVault can't store an empty hot-updater-name.",
    );
    await expect(
      adapter.set("name", "x".repeat(25_601), context),
    ).rejects.toThrow(
      "keyVault can't store hot-updater-name: it has 25601 characters.\nKey Vault takes up to 25600 characters per secret.",
    );
    expect(vaults.setSecret).not.toHaveBeenCalled();
  });
});

describe("keyVault messages", () => {
  it("prints every failure in lines of at most 76 columns", async () => {
    const long =
      "Caller is not authorized to perform action on resource. If role assignments, deny assignments or role definitions were changed recently, please observe propagation time. Caller: appid=00000000-0000-0000-0000-000000000000;oid=11111111-1111-1111-1111-111111111111";
    const messages: string[] = [];
    const record = async (promise: Promise<unknown> | undefined) => {
      messages.push((await rejectionOf(promise)).message);
    };
    for (const error of [
      restError(403, "Forbidden", long, "ForbiddenByRbac"),
      restError(401, "Unauthorized", long),
      restError(403, "Forbidden", long, "SecretDisabled"),
      restError(409, "Conflict", long, "ObjectIsBeingDeleted"),
      restError(409, "Conflict", long, "ObjectIsDeletedButRecoverable"),
      restError(500, "InternalServerError", long),
      Object.assign(new Error(long), { name: "CredentialUnavailableError" }),
    ]) {
      vaults.getSecret.mockReset();
      vaults.getSecret.mockRejectedValue(error);
      vaults.setSecret.mockReset();
      vaults.setSecret.mockRejectedValue(error);
      const adapter = keyVault({ vaultName: "my-vault", credential });
      await record(adapter.get(["play-service-account"], context));
      await record(adapter.set("play-service-account", "v", context));
    }
    await record(
      keyVault({ vaultName: "my_vault", credential }).get(["n"], context),
    );
    await record(
      keyVault({ vaultUrl: `${VAULT_URL}/x`, credential }).get(["n"], context),
    );
    await record(
      keyVault({ vaultName: "my-vault", credential }).set(
        "n",
        "x".repeat(25_601),
        context,
      ),
    );

    expect(messages).toHaveLength(17);
    for (const message of messages) {
      expect(linesWiderThan(message.split("\n"), 76)).toEqual([]);
    }
  });
});
