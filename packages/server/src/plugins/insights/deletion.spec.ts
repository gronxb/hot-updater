import { DatabaseSync } from "node:sqlite";

import type { BundleEventRow } from "@hot-updater/plugin-core";
import {
  createMemoryAdapter,
  type DatabaseAdapter,
} from "@hot-updater/plugin-core/internal";
import { createPluginTestHarness } from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import * as engine from "../../database";
import type { HotUpdaterDatabase } from "../../database/database";
import { createKvAdapter } from "../../database/kv/kvAdapter";
import { createMemoryKeyValueStore } from "../../database/kv/kvTestStore";
import { createSqlAdapter } from "../../database/sql/sqlAdapter";
import { sqliteExecutor } from "../../database/sql/sqlTestExecutors";
import { createHotUpdater } from "../../index";
import { insights, insightsIdentity, type InsightsSchema } from "./index";

const DAY = 86_400_000;
const T = Date.UTC(2026, 8, 23, 10, 15);

const uuid = (n: number) =>
  `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** A movement of `install` at T plus `n` minutes. */
const applied = (
  n: number,
  install: string,
  overrides: Partial<BundleEventRow> = {},
): BundleEventRow =>
  ({
    id: uuid(n),
    type: "UPDATE_APPLIED",
    install_id: install,
    user_id: "user-1",
    from_release_id: "release-1",
    from_bundle_id: "bundle-1",
    to_release_id: "release-2",
    to_bundle_id: "bundle-2",
    platform: "ios",
    app_version: "1.0.0",
    channel: "production",
    metadata: {
      username: null,
      cohort: "1",
      update_strategy: "appVersion",
      fingerprint_hash: null,
      sdk_version: null,
    },
    received_at_ms: T + n * 60_000,
    ...overrides,
  }) as BundleEventRow;

const backends: [string, () => DatabaseAdapter][] = [
  ["memory", () => createMemoryAdapter()],
  [
    "SQLite",
    () =>
      createSqlAdapter({
        executor: sqliteExecutor(new DatabaseSync(":memory:")),
      }),
  ],
  [
    "the key-value helper",
    () => createKvAdapter({ store: createMemoryKeyValueStore() }),
  ],
];

describe.each(backends)("insights deletion on %s", (_name, adapter) => {
  const setup = async () => {
    const harness = await createPluginTestHarness(insights(), {
      engine,
      adapter: adapter(),
    });
    harness.setNow(() => T + DAY);
    const db = harness.db as HotUpdaterDatabase<InsightsSchema>;
    const latest = async () =>
      (
        await db.findAggregates("insights_distribution", {
          index: "byScope",
          where: { channel: "production", platform: "ios" },
          limit: 100,
        })
      ).rows.reduce((sum, row) => sum + row.latest_installations, 0);
    const history = async (install: string) =>
      (
        await db.findMany("bundle_events", {
          index: "movementsByInstall",
          where: { movement_install_id: install },
          limit: 100,
        })
      ).rows.length;
    return { api: harness.api, db, latest, history };
  };

  it("deletes an installation's events, then its latest event and the gauges that count it", async () => {
    const { api, db, latest, history } = await setup();
    for (let n = 1; n <= 40; n += 1) await api.recordEvent(applied(n, "a"));
    await api.recordEvent(applied(41, "b"));
    expect(await latest()).toBe(2);

    // A bounded call deletes events first and completes only when none remain.
    const first = await api.deleteInstallation("a", { limit: 30 });
    expect(first).toEqual({
      deleted: { installations: 0, events: 30 },
      complete: false,
    });
    expect(await history("a")).toBe(10);
    const second = await api.deleteInstallation("a", { limit: 30 });
    expect(second).toEqual({
      deleted: { installations: 1, events: 10 },
      complete: true,
    });

    expect(await history("a")).toBe(0);
    await expect(
      db.findOne("bundle_event_heads", { install_id: "a" }),
    ).resolves.toBeNull();
    expect(await latest()).toBe(1);
    expect(await history("b")).toBe(1);
    // Counters hold no identifier and stay.
    const [lifetime] = (
      await db.findAggregates("insights_overview_lifetime", {
        index: "window",
        where: {
          identity: insightsIdentity({
            scopeKind: "release",
            releaseKind: "specific",
            releaseId: "release-2",
            channel: "production",
            platform: "ios",
            appVersionKind: "all",
            appVersion: "",
            periodKind: "lifetime",
          }),
        },
        limit: 10,
      })
    ).rows;
    expect(lifetime?.launches).toBe(41);

    // Deleting what is gone deletes nothing.
    await expect(api.deleteInstallation("a")).resolves.toEqual({
      deleted: { installations: 0, events: 0 },
      complete: true,
    });
  });

  it("deletes every installation whose latest event names the user", async () => {
    const { api, db, latest } = await setup();
    await api.recordEvent(applied(1, "a"));
    await api.recordEvent(applied(2, "b"));
    await api.recordEvent(applied(3, "c", { user_id: "user-2" }));

    const deletion = await api.deleteUser("user-1", { limit: 3 });
    expect(deletion).toEqual({
      deleted: { installations: 1, events: 2 },
      complete: false,
    });
    await expect(api.deleteUser("user-1")).resolves.toEqual({
      deleted: { installations: 1, events: 0 },
      complete: true,
    });

    for (const install of ["a", "b"]) {
      await expect(
        db.findOne("bundle_event_heads", { install_id: install }),
      ).resolves.toBeNull();
    }
    await expect(
      db.findOne("bundle_event_heads", { install_id: "c" }),
    ).resolves.not.toBeNull();
    expect(await latest()).toBe(1);
  });
});

describe("insights deletion routes", () => {
  const server = () => {
    const hotUpdater = createHotUpdater({
      clientAccess: "public",
      database: { name: "memory", adapter: createMemoryAdapter() },
      plugins: [insights()],
    });
    const admin = (path: string, method = "DELETE") =>
      hotUpdater.handlers.admin(
        new Request(`https://admin.example.com${path}`, { method }),
      );
    return { hotUpdater, admin };
  };

  it("deletes an installation or a user's installations and says what remains", async () => {
    const { hotUpdater, admin } = server();
    await hotUpdater.api.insights.recordEvent(applied(1, "install/1"));
    await hotUpdater.api.insights.recordEvent(applied(2, "b"));

    const one = await admin("/installations/install%2F1");
    expect(one.status).toBe(200);
    await expect(one.json()).resolves.toEqual({
      deleted: { installations: 1, events: 1 },
      complete: true,
    });
    const user = await admin("/installations?userId=user-1");
    await expect(user.json()).resolves.toEqual({
      deleted: { installations: 1, events: 1 },
      complete: true,
    });
    await expect(
      hotUpdater.api.insights.findLatestEvents({ installId: "b" }),
    ).resolves.toEqual([]);
  });

  it("refuses to delete installations without a user", async () => {
    const { admin } = server();

    const response = await admin("/installations");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "userId is required to delete installations.",
    });
  });
});
