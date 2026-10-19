import { PGlite } from "@electric-sql/pglite";
import { createMemoryAdapter, toolingTargetOf } from "@hot-updater/plugin-core";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { describe, expect, it } from "vitest";

import { kyselyAdapter } from "../../adapters/kysely";
import { createHotUpdater } from "../../index";
import { VAULT_KEPT_VERSIONS, vault, VaultLockedError } from "./index";

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

const start = (masterKey?: string) =>
  createHotUpdater({
    clientAccess: "public",
    database: { name: "memory", adapter: createMemoryAdapter() },
    storage: createReleaseCatalogTestStorage(),
    plugins: [vault(masterKey === undefined ? {} : { masterKey })],
  });

describe("createHotUpdater with the vault() plugin", () => {
  it("serves secrets through hotUpdater.api.vault", async () => {
    const hotUpdater = start(MASTER_KEY);
    const secret = await hotUpdater.api.vault.put({
      name: "play",
      kind: "play-service-account",
      value: { client_email: "ci@example.iam.gserviceaccount.com" },
    });

    await expect(hotUpdater.api.vault.list()).resolves.toEqual([secret]);
    await expect(
      hotUpdater.api.vault.reveal({ id: secret.id, actor: "test" }),
    ).resolves.toEqual({ client_email: "ci@example.iam.gserviceaccount.com" });
  });

  it("adds no routes, and is locked without a master key", async () => {
    const hotUpdater = start();

    for (const path of ["/vault/v1/secrets", "/vault/secrets", "/secrets"]) {
      for (const handler of [
        hotUpdater.handlers.client,
        hotUpdater.handlers.admin,
      ]) {
        expect(
          (await handler(new Request(`https://example.com${path}`))).status,
        ).toBe(404);
      }
    }
    await expect(
      hotUpdater.api.vault.put({ name: "n", kind: "generic", value: 1 }),
    ).rejects.toThrow(VaultLockedError);
  });

  it("migrates its tables on PostgreSQL and keeps a value's last versions there", async () => {
    const client = new PGlite();
    const db = new Kysely<object>({ dialect: new PGliteDialect(client) });
    try {
      const database = kyselyAdapter({ db, provider: "postgresql" });
      await (
        await database.createMigrator!(
          toolingTargetOf([vault()]),
        ).migrateToLatest()
      ).execute();
      const hotUpdater = createHotUpdater({
        clientAccess: "public",
        database,
        storage: createReleaseCatalogTestStorage(),
        plugins: [vault({ masterKey: MASTER_KEY })],
      });
      // A keystore near the value limit, in base64.
      const keystore = "A".repeat(60 * 1024);
      let secret = await hotUpdater.api.vault.put({
        name: "release-keystore",
        kind: "android-keystore",
        value: { keystore, storePassword: "1" },
      });
      for (let version = 2; version <= VAULT_KEPT_VERSIONS + 1; version++) {
        secret = await hotUpdater.api.vault.put({
          name: "release-keystore",
          kind: "android-keystore",
          value: { keystore, storePassword: String(version) },
        });
      }

      await expect(
        hotUpdater.api.vault.reveal({ id: secret.id, actor: "test" }),
      ).resolves.toEqual({
        keystore,
        storePassword: String(VAULT_KEPT_VERSIONS + 1),
      });
      const { rows } = await client.query<{ version: number }>(
        "SELECT version FROM vault_secret_versions ORDER BY version",
      );
      expect(rows.map(({ version }) => version)).toEqual(
        Array.from({ length: VAULT_KEPT_VERSIONS }, (_, index) => index + 2),
      );
      await hotUpdater.api.vault.remove({ id: secret.id });
      await expect(
        client.query("SELECT 1 FROM vault_secret_versions"),
      ).resolves.toMatchObject({ rows: [] });
    } finally {
      await db.destroy();
      await client.close().catch(() => undefined);
    }
  });
});
