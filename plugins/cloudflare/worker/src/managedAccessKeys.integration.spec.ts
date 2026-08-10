import {
  managedAccessKeyStoreCapability,
  registerManagedAccessKey,
} from "@hot-updater/better-auth/managed";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, inject, it } from "vitest";

import { d1WorkerDatabase } from "../../src/cloudflareWorkerDatabase";

const firstKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const secondKey = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";

describe("Cloudflare managed access-key store", () => {
  beforeAll(async () => {
    await env.DB.prepare(inject("prepareSql")).run();
    const migration = inject("d1Migrations").find(
      ({ name }) => name === "0007_hot-updater_managed_access_keys.sql",
    );
    if (migration === undefined)
      throw new Error("Missing access-key migration.");
    await env.DB.prepare(migration.sql).run();
  });

  it("persists multiple keys, exact hash lookups, ordering, and revocation", async () => {
    const database = d1WorkerDatabase(env.DB);
    const contribution = getCapabilityContributions(database).find(
      ({ token }) => token.id === managedAccessKeyStoreCapability.id,
    );
    if (contribution === undefined)
      throw new Error("Missing access-key store.");
    const store = managedAccessKeyStoreCapability.parse(
      Reflect.apply(contribution.create, undefined, []),
    );

    const first = await registerManagedAccessKey({
      apiKey: firstKey,
      createdAt: 100,
      name: "First",
      store,
    });
    const second = await registerManagedAccessKey({
      apiKey: secondKey,
      createdAt: 200,
      name: "Second",
      store,
    });

    await expect(store.findByHash(first.hash)).resolves.toEqual(first);
    await expect(store.list()).resolves.toEqual([second, first]);

    const revoked = await store.revoke({ id: first.id, revokedAt: 300 });
    expect(revoked).toMatchObject({ enabled: false, revokedAt: 300 });
    await expect(store.findByHash(first.hash)).resolves.toMatchObject({
      enabled: false,
      revokedAt: 300,
    });
  });
});
