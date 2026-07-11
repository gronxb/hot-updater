import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, describe, expect, it } from "vitest";

import { kyselyAdapter, type HotUpdaterKyselyDatabase } from "./kysely";

describe("kyselyAdapter query pushdown", () => {
  const databases: PGlite[] = [];
  const kyselyInstances: Kysely<HotUpdaterKyselyDatabase>[] = [];

  afterEach(async () => {
    for (const kysely of kyselyInstances.splice(0)) {
      await kysely.destroy();
    }
    for (const db of databases.splice(0)) {
      await db.close();
    }
  });

  it("pushes bundle, patch, and event list queries into Kysely", async () => {
    // Given
    const queries: string[] = [];
    const db = new PGlite();
    databases.push(db);
    const kysely = new Kysely<HotUpdaterKyselyDatabase>({
      dialect: new PGliteDialect(db),
      log(event) {
        if (event.level === "query") queries.push(event.query.sql);
      },
    });
    kyselyInstances.push(kysely);
    await db.exec(`
      create table bundles (
        id text primary key,
        channel text not null,
        platform text not null,
        enabled integer not null,
        target_app_version text,
        fingerprint_hash text
      );
      create table bundle_patches (
        id text primary key,
        bundle_id text not null,
        base_bundle_id text not null,
        order_index integer not null
      );
      create table bundle_events (
        id text primary key,
        kind text not null,
        install_id text not null
      );
    `);
    const adapter = kyselyAdapter({
      db: kysely,
      provider: "postgresql",
    });
    if (!adapter.bundleEvents) {
      throw new Error("Kysely adapter must expose bundle events.");
    }

    // When
    await adapter.bundles.list({
      limit: 2,
      cursor: { after: "offset:0" },
      orderBy: { field: "id", direction: "asc" },
      where: { channel: "production" },
    });
    await adapter.bundlePatches.list({
      limit: 2,
      cursor: { after: "offset:0" },
      orderBy: { field: "orderIndex", direction: "desc" },
      where: { bundleId: "" },
    });
    await adapter.bundleEvents.list({
      limit: 2,
      cursor: { after: "offset:0" },
      orderBy: { field: "id", direction: "asc" },
      where: { installId: "" },
    });

    // Then
    const listQueries = queries.filter(
      (query) =>
        query.includes('from "bundles"') ||
        query.includes('from "bundle_patches"') ||
        query.includes('from "bundle_events"'),
    );
    expect(listQueries).toHaveLength(6);
    expect(listQueries.filter((query) => query.includes("count"))).toHaveLength(
      3,
    );
    expect(listQueries.filter((query) => !query.includes("count"))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /from "bundles" where "channel" = .* order by "id" asc limit .* offset/,
        ),
        expect.stringMatching(
          /from "bundle_patches" where "bundle_id" = .* order by "order_index" desc, "id" desc limit .* offset/,
        ),
        expect.stringMatching(
          /from "bundle_events" where "install_id" = .* order by "id" asc limit .* offset/,
        ),
      ]),
    );
  });

  it("ignores a duplicate bundle event primary id", async () => {
    // Given
    const db = new PGlite();
    databases.push(db);
    const kysely = new Kysely<HotUpdaterKyselyDatabase>({
      dialect: new PGliteDialect(db),
    });
    kyselyInstances.push(kysely);
    await db.exec(`
      create table bundle_events (
        id text primary key,
        kind text not null,
        install_id text not null,
        active_bundle_id text not null,
        previous_active_bundle_id text,
        crashed_bundle_id text,
        platform text not null,
        channel text not null,
        app_version text,
        fingerprint_hash text,
        cohort text,
        user_id text,
        payload text not null
      );
    `);
    const adapter = kyselyAdapter({ db: kysely, provider: "sqlite" });
    const event = {
      id: "0195a408-8f13-7d9b-8df4-123456789abc",
      kind: "APP_READY",
      installId: "install-1",
      activeBundleId: "bundle-1",
      platform: "ios",
      channel: "production",
      payload: {
        status: "STABLE",
        sdkVersion: "1.0.0",
        defaultChannel: "production",
        isChannelSwitched: false,
      },
    } as const;
    if (!adapter.bundleEvents) {
      throw new Error("Kysely adapter must expose bundle events.");
    }

    // When
    await adapter.bundleEvents.append({ event });
    await adapter.bundleEvents.append({ event });
    await adapter.commit();

    // Then
    const result = await db.query<{ count: number }>(
      "select count(*)::integer as count from bundle_events",
    );
    expect(result.rows).toEqual([{ count: 1 }]);
  });

  it("deletes bundle events before the retention id", async () => {
    // Given
    const db = new PGlite();
    databases.push(db);
    const kysely = new Kysely<HotUpdaterKyselyDatabase>({
      dialect: new PGliteDialect(db),
    });
    kyselyInstances.push(kysely);
    await db.exec(`
      create table bundle_events (
        id text primary key,
        kind text not null,
        install_id text not null,
        active_bundle_id text not null,
        previous_active_bundle_id text,
        crashed_bundle_id text,
        platform text not null,
        channel text not null,
        app_version text,
        fingerprint_hash text,
        cohort text,
        user_id text,
        payload text not null
      );
    `);
    const adapter = kyselyAdapter({ db: kysely, provider: "sqlite" });
    const retainedId = "0195a408-8f13-7d9b-8df4-123456789abc";
    const event = {
      kind: "APP_READY",
      installId: "install-1",
      activeBundleId: "bundle-1",
      platform: "ios",
      channel: "production",
      payload: {
        status: "STABLE",
        sdkVersion: "1.0.0",
        defaultChannel: "production",
        isChannelSwitched: false,
      },
    } as const;
    if (!adapter.bundleEvents?.deleteBeforeId) {
      throw new Error("Kysely adapter must expose event retention.");
    }
    await adapter.bundleEvents.append({
      event: { ...event, id: "0195a408-8f12-7000-8000-000000000000" },
    });
    await adapter.bundleEvents.append({
      event: { ...event, id: retainedId },
    });
    await adapter.commit();

    // When
    await adapter.bundleEvents.deleteBeforeId({ beforeId: retainedId });

    // Then
    const result = await db.query<{ id: string }>(
      "select id from bundle_events order by id",
    );
    expect(result.rows).toEqual([{ id: retainedId }]);
  });
});
