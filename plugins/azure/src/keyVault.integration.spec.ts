import type { TokenCredential } from "@azure/core-auth";
import { SecretClient } from "@azure/keyvault-secrets";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startLowkeyVault } from "../test-utils/azureEmulators";
import { keyVault } from "./keyVault";

const context = { cwd: process.cwd() };

/** Lowkey Vault takes any bearer token. */
const credential: TokenCredential = {
  getToken: async () => ({
    token: "lowkey-vault",
    expiresOnTimestamp: Date.now() + 3_600_000,
  }),
};

let vault: Awaited<ReturnType<typeof startLowkeyVault>> | undefined;
let rejectUnauthorized: string | undefined;

/** A client of its own, to check what the adapter stored. */
const createClient = () =>
  new SecretClient(vault!.vaultUrl, credential, {
    disableChallengeResourceVerification: true,
  });

beforeAll(async () => {
  // Lowkey Vault's certificate is self-signed.
  rejectUnauthorized = process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
  process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
  vault = await startLowkeyVault();
}, 180_000);

afterAll(async () => {
  await vault?.stop();
  if (rejectUnauthorized === undefined) {
    delete process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
  } else {
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = rejectUnauthorized;
  }
});

/** An adapter over a prefix of its own, so cases never share a secret. */
const createAdapter = () => {
  const prefix = `hu-${crypto.randomUUID().slice(0, 8)}-`;
  return {
    prefix,
    secrets: keyVault({ vaultUrl: vault!.vaultUrl, credential, prefix }),
  };
};

describe("keyVault (Lowkey Vault)", () => {
  it("reads a missing secret as undefined, creates it, and adds versions", async () => {
    const { prefix, secrets } = createAdapter();
    const first = '{"keyId":"ABC123","issuerId":"i","p8":"-----BEGIN-----"}';
    const second = '{"keyId":"DEF456","issuerId":"i","p8":"-----BEGIN-----"}';

    expect({ ...(await secrets.get(["asc-api-key"], context)) }).toEqual({
      "asc-api-key": undefined,
    });

    await secrets.set("asc-api-key", first, context);
    const stored = await createClient().getSecret(`${prefix}asc-api-key`);
    expect(stored.value).toBe(first);
    expect(stored.properties.tags).toEqual({
      "hot-updater-name": "asc-api-key",
    });
    expect({
      ...(await secrets.get(["asc-api-key", "release-keystore"], context)),
    }).toEqual({ "asc-api-key": first, "release-keystore": undefined });

    await secrets.set("asc-api-key", second, context);
    expect({ ...(await secrets.get(["asc-api-key"], context)) }).toEqual({
      "asc-api-key": second,
    });
    const versions = [];
    for await (const version of createClient().listPropertiesOfSecretVersions(
      `${prefix}asc-api-key`,
    )) {
      versions.push(version.version);
    }
    expect(versions).toHaveLength(2);
    expect(secrets.describe?.("asc-api-key")).toBe(
      `the secret ${JSON.stringify(`${prefix}asc-api-key`)} in Azure Key Vault (${vault!.vaultUrl})`,
    );
  });

  it("keeps env-style names apart from their lower-case spelling", async () => {
    const { secrets } = createAdapter();

    await secrets.set("CLOUDFLARE_API_TOKEN", "upper", context);
    await secrets.set("cloudflare-api-token", "lower", context);

    expect({
      ...(await secrets.get(
        [
          "CLOUDFLARE_API_TOKEN",
          "cloudflare-api-token",
          "cloudflare_api_token",
        ],
        context,
      )),
    }).toEqual({
      CLOUDFLARE_API_TOKEN: "upper",
      "cloudflare-api-token": "lower",
      cloudflare_api_token: undefined,
    });
  });

  it("stores a base64 keystore JSON as it is", async () => {
    const { secrets } = createAdapter();
    const keystore = JSON.stringify({
      keystore: Buffer.alloc(8 * 1024, 7).toString("base64"),
      storePassword: "store",
      keyAlias: "upload",
      keyPassword: "key",
    });

    await secrets.set("release-keystore", keystore, context);

    expect(
      (await secrets.get(["release-keystore"], context))["release-keystore"],
    ).toBe(keystore);
  });

  it("reads a deleted secret as missing, and says how to recover it on set", async () => {
    const { prefix, secrets } = createAdapter();
    await secrets.set("asc-api-key", "value", context);
    const deleting = await createClient().beginDeleteSecret(
      `${prefix}asc-api-key`,
    );
    await deleting.pollUntilDone();

    expect({ ...(await secrets.get(["asc-api-key"], context)) }).toEqual({
      "asc-api-key": undefined,
    });
    await expect(secrets.set("asc-api-key", "again", context)).rejects.toThrow(
      [
        `${prefix}asc-api-key was deleted. Recover it, or purge it:`,
        `az keyvault secret recover --vault-name 127 --name ${prefix}asc-api-key`,
      ].join("\n"),
    );
  });
});
