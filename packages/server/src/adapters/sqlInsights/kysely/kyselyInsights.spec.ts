import { createHash } from "node:crypto";
import { DatabaseSync, type SqliteValue } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import type {
  BundleEventRow,
  InsightsReportResult,
} from "@hot-updater/plugin-core";
import {
  getCanonicalInsightsJsonByteLength,
  INSIGHTS_PAGE_MAX_BYTES,
} from "@hot-updater/plugin-core/internal";
import { Kysely, SqliteDialect } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createKyselyInsightsModel,
  migrateKyselyInsights,
  prepareKyselyInsightsSource,
  runKyselyInsightsMaintenanceStep,
} from ".";
import { createKyselyMigrator } from "../../../db/fixedMigrator";
import { kyselyAdapter } from "../../kysely";

const createDatabase = () => {
  const native = new DatabaseSync(":memory:");
  const db = new Kysely<object>({
    dialect: new SqliteDialect({
      database: {
        close: () => native.close(),
        prepare: (text) => {
          const statement = native.prepare(text);
          return {
            reader: statement.columns().length > 0,
            all: (parameters) =>
              statement.all(...(parameters as SqliteValue[])),
            run: (parameters) => {
              const result = statement.run(...(parameters as SqliteValue[]));
              return {
                changes: result.changes,
                lastInsertRowid: result.lastInsertRowid,
              };
            },
            iterate: (parameters) =>
              statement.iterate(...(parameters as SqliteValue[])),
          };
        },
      },
    }),
  });
  return { native, db };
};

type AppliedEvent = BundleEventRow & { readonly type: "UPDATE_APPLIED" };

const fixtureInstallationKey = (installId: string): string =>
  createHash("sha256").update(JSON.stringify(installId)).digest("hex");

const event = (
  id: string,
  installId: string,
  receivedAtMs: number,
  overrides: Partial<AppliedEvent> = {},
): BundleEventRow => {
  const row: AppliedEvent = {
    id,
    type: "UPDATE_APPLIED",
    install_id: installId,
    user_id: `user-${installId}`,
    username: `Name ${installId}`,
    from_release_id: "01900000-0000-7000-8000-000000000010",
    from_bundle_id: "01900000-0000-7000-8000-000000000020",
    to_release_id: "01900000-0000-7000-8000-000000000011",
    to_bundle_id: "01900000-0000-7000-8000-000000000021",
    platform: "ios",
    app_version: "1.0.0",
    channel: "production",
    cohort: "cohort-a",
    update_strategy: "appVersion",
    fingerprint_hash: null,
    sdk_version: "1.0.0",
    received_at_ms: receivedAtMs,
    ...overrides,
  };
  return row;
};

const readyReport = async (
  run: () => Promise<InsightsReportResult>,
  advance: () => Promise<unknown>,
): Promise<Extract<InsightsReportResult, { state: "ready" }>> => {
  for (let index = 0; index < 30; index += 1) {
    const result = await run();
    if (result.state === "ready") return result;
    expect(["preparing", "stale"]).toContain(result.state);
    await advance();
  }
  throw new Error("report did not publish");
};

describe("Kysely native Insights", () => {
  const databases: Kysely<object>[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.destroy()));
    vi.restoreAllMocks();
  });

  it("keeps append, source, live aliases, and exact reports consistent", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(3_000);
    const { native, db } = createDatabase();
    databases.push(db);
    const adapter = kyselyAdapter({ db, provider: "sqlite" });
    await adapter.createMigrator!()
      .migrateToLatest()
      .then((item) => item.execute());
    const insights = createKyselyInsightsModel(db, "sqlite");
    const advance = () =>
      runKyselyInsightsMaintenanceStep(db, "sqlite", {
        maxItems: 160,
        maxRequests: 4_096,
      });

    await insights.append(
      event("019a0000-0000-7000-8000-000000000001", "install-a", 1_000),
    );
    await insights.append(
      event("019a0000-0000-7000-8000-000000000002", "install-a", 2_000),
    );
    await insights.append(
      event("019a0000-0000-7000-8000-000000000003", "install-b", 1_500, {
        user_id: "historical-user",
        username: "A_B% Literal",
      }),
    );
    await insights.append(
      event("019a0000-0000-7000-8000-000000000004", "install-b", 2_500, {
        user_id: "current-user",
      }),
    );

    const history = await insights.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 3_000,
      limit: 2,
    });
    expect(history.state).toBe("ready");
    if (history.state !== "ready") return;
    expect(history.data.data.map(({ id }) => id)).toEqual([
      "019a0000-0000-7000-8000-000000000004",
      "019a0000-0000-7000-8000-000000000002",
    ]);
    expect(history.data.hasNext).toBe(true);
    await insights.append(
      event("019a0000-0000-7000-8000-000000000005", "install-a", 1_750),
    );
    const retainedHistory = await insights.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 3_000,
      limit: 10,
      cursor: history.data.nextCursor!,
    });
    expect(retainedHistory.state).toBe("ready");
    if (retainedHistory.state === "ready") {
      expect(retainedHistory.data.data.map(({ id }) => id)).toEqual([
        "019a0000-0000-7000-8000-000000000005",
        "019a0000-0000-7000-8000-000000000003",
        "019a0000-0000-7000-8000-000000000001",
      ]);
    }
    const installationHistory = await insights.pageEvents({
      selector: { kind: "installationId", installId: "install-a" },
      beforeReceivedAtMs: 3_000,
      limit: 10,
    });
    expect(installationHistory.state).toBe("ready");
    if (installationHistory.state === "ready") {
      expect(
        installationHistory.data.data.map(({ install_id }) => install_id),
      ).toEqual(["install-a", "install-a", "install-a"]);
    }
    const bundleHistory = await insights.pageEvents({
      selector: {
        kind: "bundleId",
        bundleId: "01900000-0000-7000-8000-000000000021",
      },
      beforeReceivedAtMs: 3_000,
      limit: 10,
    });
    expect(bundleHistory.state).toBe("ready");
    if (bundleHistory.state === "ready") {
      expect(bundleHistory.data.data).toHaveLength(5);
    }

    const installations = await insights.pageInstallations({
      kind: "all",
      limit: 10,
    });
    expect(installations.state).toBe("ready");
    if (installations.state !== "ready") return;
    expect(installations.data.data).toHaveLength(2);
    expect(
      installations.data.data.find((row) => row.install_id === "install-b")
        ?.user_id,
    ).toBe("current-user");
    const exactInstallation = await insights.pageInstallations({
      kind: "installationId",
      installId: "install-b",
      limit: 1,
    });
    expect(exactInstallation.state).toBe("ready");
    if (exactInstallation.state === "ready") {
      expect(exactInstallation.data.data).toMatchObject([
        { install_id: "install-b", user_id: "current-user" },
      ]);
    }

    const pendingAlias = await insights.pageInstallations({
      kind: "userId",
      userId: "historical-user",
      limit: 10,
    });
    expect(pendingAlias.state).toBe("preparing");
    const repeatedAlias = await insights.pageInstallations({
      kind: "userId",
      userId: "historical-user",
      limit: 10,
    });
    expect(repeatedAlias.state).toBe("preparing");
    if (
      pendingAlias.state !== "preparing" ||
      repeatedAlias.state !== "preparing"
    ) {
      return;
    }
    expect(repeatedAlias.job.id).toBe(pendingAlias.job.id);
    const reservedSearch = native
      .prepare(
        `select source_id, source_upper
          from private_hot_updater_kysely_insights_search_jobs
          where id = ?`,
      )
      .get(pendingAlias.job.id) as {
      source_id: string;
      source_upper: number;
    };
    expect(pendingAlias.versions.sourceGeneration).toBe(
      JSON.stringify([
        "kysely-insights-1",
        reservedSearch.source_id,
        reservedSearch.source_upper,
      ]),
    );
    expect(repeatedAlias.versions.sourceGeneration).toBe(
      pendingAlias.versions.sourceGeneration,
    );
    expect(
      native
        .prepare(
          `select count(*) as value from
            private_hot_updater_kysely_insights_search_rows
            where job_id = ?`,
        )
        .get(pendingAlias.job.id),
    ).toMatchObject({ value: 0 });
    await advance();
    const alias = await insights.pageInstallations({
      kind: "userId",
      userId: "historical-user",
      limit: 10,
    });
    expect(alias.state).toBe("ready");
    if (alias.state !== "ready") return;
    expect(alias.data.data).toMatchObject([
      { install_id: "install-b", user_id: "current-user" },
    ]);
    expect(alias.data.total.value).toBe(1);
    expect(
      native
        .prepare(
          `select h.publication_job_id, j.state
            from private_hot_updater_kysely_insights_search_heads h
            join private_hot_updater_kysely_insights_search_jobs j
              on j.id = h.publication_job_id
            where j.id = ?`,
        )
        .get(pendingAlias.job.id),
    ).toMatchObject({
      publication_job_id: pendingAlias.job.id,
      state: "ready",
    });

    await insights.pageInstallations({
      kind: "contains",
      query: "_b%",
      limit: 10,
    });
    await advance();
    const literal = await insights.pageInstallations({
      kind: "contains",
      query: "_b%",
      limit: 10,
    });
    expect(literal.state).toBe("ready");
    if (literal.state !== "ready") return;
    expect(literal.data.data.map(({ install_id }) => install_id)).toEqual([
      "install-b",
    ]);

    const reportInput = {
      query: {
        kind: "bundleSummaries",
        bundleIds: ["01900000-0000-7000-8000-000000000021"],
        window: "all",
      },
    } as const;
    const pendingReport = await insights.getReport(reportInput);
    expect(pendingReport.state).toBe("preparing");
    if (pendingReport.state !== "preparing") return;
    const reservedReport = native
      .prepare(
        `select source_id, source_upper
          from private_hot_updater_kysely_insights_report_jobs
          where id = ?`,
      )
      .get(pendingReport.job.id) as {
      source_id: string;
      source_upper: number;
    };
    expect(pendingReport.versions.sourceGeneration).toBe(
      JSON.stringify([
        "kysely-insights-1",
        reservedReport.source_id,
        reservedReport.source_upper,
      ]),
    );
    await insights.append(
      event(
        "019a0000-0000-7000-8000-000000000008",
        "report-after-reservation",
        2_750,
      ),
    );
    const report = await readyReport(
      () => insights.getReport(reportInput),
      advance,
    );
    expect(report.data.summary).toEqual([
      {
        bundleId: "01900000-0000-7000-8000-000000000021",
        installed: 2,
        recovered: 0,
      },
    ]);

    const detail = await readyReport(
      () =>
        insights.getReport({
          query: {
            kind: "bundleDetail",
            bundleId: "01900000-0000-7000-8000-000000000021",
            window: "all",
          },
        }),
      advance,
    );
    const series = await insights.pageReport({
      publicationId: detail.data.id,
      section: "movementSeries",
      metric: "installed",
      limit: 10,
    });
    expect(series.state).toBe("ready");
    if (series.state === "ready") {
      expect(series.data.data).toEqual([{ bucketStartMs: 0, value: 3 }]);
      expect(series.data.nextCursor).toBeNull();
      expect(series.data.total).toMatchObject({ state: "exact", value: 1 });
    }
    const cohorts = await insights.pageReport({
      publicationId: detail.data.id,
      section: "movementCohorts",
      metric: "installed",
      limit: 10,
    });
    expect(cohorts.state).toBe("ready");
    if (cohorts.state === "ready") {
      expect(cohorts.data.data).toEqual([{ cohort: "cohort-a", value: 3 }]);
    }

    const firstLivePage = await insights.pageInstallations({
      kind: "all",
      limit: 1,
    });
    expect(firstLivePage.state).toBe("ready");
    if (firstLivePage.state !== "ready" || !firstLivePage.data.nextCursor) {
      return;
    }
    const remainingInstallId =
      firstLivePage.data.data[0]?.install_id === "install-a"
        ? "install-b"
        : "install-a";
    await insights.append(
      event("019a0000-0000-7000-8000-000000000006", remainingInstallId, 3_000, {
        user_id: "after-cutoff",
      }),
    );
    const retainedCutoff = await insights.pageInstallations({
      kind: "all",
      limit: 1,
      cursor: firstLivePage.data.nextCursor,
    });
    expect(retainedCutoff.state).toBe("ready");
    if (retainedCutoff.state === "ready") {
      expect(retainedCutoff.data.data).toHaveLength(1);
      expect(retainedCutoff.data.data[0]?.user_id).not.toBe("after-cutoff");
    }

    const aliasPublication = alias.data.consistency.cutoff.publication;
    await insights.append(
      event("019a0000-0000-7000-8000-000000000007", "install-c", 3_500, {
        user_id: "historical-user",
      }),
    );
    const pinnedAlias = await insights.pageInstallations({
      kind: "userId",
      userId: "historical-user",
      publicationId: aliasPublication.id,
      limit: 10,
    });
    expect(pinnedAlias.state).toBe("ready");
    if (pinnedAlias.state === "ready") {
      expect(pinnedAlias.data.data.map(({ install_id }) => install_id)).toEqual(
        ["install-b"],
      );
    }
    clock.mockReturnValue(aliasPublication.asOfMs + 1);
    const refreshedPending = await insights.pageInstallations({
      kind: "userId",
      userId: "historical-user",
      minAsOfMs: aliasPublication.asOfMs + 1,
      limit: 10,
    });
    expect(refreshedPending.state).toBe("stale");
    if (refreshedPending.state === "stale") {
      expect(
        refreshedPending.data.data.map(({ install_id }) => install_id),
      ).toEqual(["install-b"]);
    }
    await advance();
    const refreshedAlias = await insights.pageInstallations({
      kind: "userId",
      userId: "historical-user",
      minAsOfMs: aliasPublication.asOfMs + 1,
      limit: 10,
    });
    expect(refreshedAlias.state).toBe("ready");
    if (refreshedAlias.state === "ready") {
      expect(
        refreshedAlias.data.data.map(({ install_id }) => install_id).sort(),
      ).toEqual(["install-b", "install-c"]);
    }
  });

  it("publishes every report kind and page section", async () => {
    const { db } = createDatabase();
    databases.push(db);
    const adapter = kyselyAdapter({ db, provider: "sqlite" });
    await adapter.createMigrator!()
      .migrateToLatest()
      .then((item) => item.execute());
    const insights = createKyselyInsightsModel(db, "sqlite");
    const advance = () =>
      runKyselyInsightsMaintenanceStep(db, "sqlite", {
        maxItems: 160,
        maxRequests: 4_096,
      });
    const now = Date.now();
    const bundleId = "01900000-0000-7000-8000-000000000021";
    await insights.append(
      event("019a1000-0000-7000-8000-000000000001", "report-a", now - 1_000),
    );
    await insights.append(
      event("019a1000-0000-7000-8000-000000000002", "report-b", now - 500),
    );

    const summaries = await readyReport(
      () =>
        insights.getReport({
          query: {
            kind: "bundleSummaries",
            bundleIds: [bundleId],
            window: "all",
          },
        }),
      advance,
    );
    expect(summaries.data.kind).toBe("bundleSummaries");
    const detail = await readyReport(
      () =>
        insights.getReport({
          query: { kind: "bundleDetail", bundleId, window: "all" },
        }),
      advance,
    );
    const installations = await readyReport(
      () => insights.getReport({ query: { kind: "installationOverview" } }),
      advance,
    );
    const active = await readyReport(
      () =>
        insights.getReport({
          query: { kind: "activeOverview", window: "24h" },
        }),
      advance,
    );
    const pageInputs = [
      {
        publicationId: detail.data.id,
        section: "movementSeries" as const,
        metric: "installed" as const,
        limit: 10,
      },
      {
        publicationId: detail.data.id,
        section: "movementCohorts" as const,
        metric: "installed" as const,
        limit: 10,
      },
      {
        publicationId: installations.data.id,
        section: "bundleDistribution" as const,
        limit: 10,
      },
      {
        publicationId: active.data.id,
        section: "activeSeries" as const,
        limit: 10,
      },
      {
        publicationId: active.data.id,
        section: "activeBundleSeries" as const,
        bundleId,
        limit: 10,
      },
    ];
    for (const input of pageInputs) {
      const page = await insights.pageReport(input);
      expect(page.state).toBe("ready");
    }
  });

  it("pages full active bundle series globally and per bundle", async () => {
    const { native, db } = createDatabase();
    databases.push(db);
    const adapter = kyselyAdapter({ db, provider: "sqlite" });
    await adapter.createMigrator!()
      .migrateToLatest()
      .then((item) => item.execute());
    const insights = createKyselyInsightsModel(db, "sqlite");
    const advance = () =>
      runKyselyInsightsMaintenanceStep(db, "sqlite", {
        maxItems: 160,
        maxRequests: 128,
      });
    const now = Date.now();
    const firstBundle = "10000000-0000-7000-8000-000000000001";
    const secondBundle = "10000000-0000-7000-8000-000000000002";
    await insights.append(
      event(
        "019a1100-0000-7000-8000-000000000001",
        "series-a",
        now - 10_800_000,
        {
          to_bundle_id: firstBundle,
        },
      ),
    );
    await insights.append(
      event(
        "019a1100-0000-7000-8000-000000000002",
        "series-b",
        now - 10_800_000,
        {
          to_bundle_id: secondBundle,
        },
      ),
    );
    await insights.append(
      event(
        "019a1100-0000-7000-8000-000000000003",
        "series-a",
        now - 3_600_000,
        {
          to_bundle_id: firstBundle,
        },
      ),
    );

    const report = await readyReport(
      () =>
        insights.getReport({
          query: { kind: "activeOverview", window: "24h" },
        }),
      advance,
    );
    const global = await insights.pageReport({
      publicationId: report.data.id,
      section: "activeBundleSeries",
      limit: 100,
    });
    expect(global.state).toBe("ready");
    if (
      global.state !== "ready" ||
      global.data.section !== "activeBundleSeries"
    ) {
      return;
    }
    expect(global.data.data).toHaveLength(48);
    expect(global.data.nextCursor).toBeNull();
    expect(global.data.total).toMatchObject({ state: "exact", value: 48 });
    expect(
      global.data.data
        .slice(0, 24)
        .every(({ bundleId }) => bundleId === firstBundle),
    ).toBe(true);
    expect(
      global.data.data
        .slice(24)
        .every(({ bundleId }) => bundleId === secondBundle),
    ).toBe(true);
    expect(
      global.data.data
        .filter(({ bundleId }) => bundleId === firstBundle)
        .reduce((total, row) => total + row.value, 0),
    ).toBe(2);
    expect(
      global.data.data
        .filter(({ bundleId }) => bundleId === secondBundle)
        .reduce((total, row) => total + row.value, 0),
    ).toBe(1);

    const filtered = await insights.pageReport({
      publicationId: report.data.id,
      section: "activeBundleSeries",
      bundleId: firstBundle,
      limit: 100,
    });
    expect(filtered.state).toBe("ready");
    if (
      filtered.state !== "ready" ||
      filtered.data.section !== "activeBundleSeries"
    ) {
      return;
    }
    expect(filtered.data.data).toHaveLength(24);
    expect(filtered.data.nextCursor).toBeNull();
    expect(filtered.data.total).toMatchObject({ state: "exact", value: 24 });
    expect(
      filtered.data.data.every(({ bundleId }) => bundleId === firstBundle),
    ).toBe(true);
    expect(
      filtered.data.data.reduce((total, row) => total + row.value, 0),
    ).toBe(2);

    await expect(
      insights.pageReport({
        publicationId: report.data.id,
        section: "activeBundleSeries",
        bundleId: "10000000-0000-7000-8000-000000000099",
        limit: 10,
      }),
    ).resolves.toMatchObject({
      state: "ready",
      data: { data: [], total: { state: "exact", value: 0 } },
    });
    const firstBundleKey = createHash("sha256")
      .update(JSON.stringify(firstBundle))
      .digest("hex");
    const filteredPlan = native
      .prepare(
        `explain query plan select label_ordinal, bucket_start_ms, value
          from private_hot_updater_kysely_insights_report_order
          where job_id = ? and order_kind = 'activeBundleSeries'
            and metric = '' and label_key = ? and label_ordinal >= 0
          order by label_ordinal limit 101`,
      )
      .all(report.data.id, firstBundleKey)
      .map((row) => String(row.detail))
      .join("\n");
    expect(filteredPlan).toContain("kysely_insights_order_label_idx");
    expect(filteredPlan).not.toContain("USE TEMP B-TREE");
  });

  it("keeps delayed latest identity and historical cursors pinned", async () => {
    const { db } = createDatabase();
    databases.push(db);
    const adapter = kyselyAdapter({ db, provider: "sqlite" });
    await adapter.createMigrator!()
      .migrateToLatest()
      .then((item) => item.execute());
    const insights = createKyselyInsightsModel(db, "sqlite");
    const advance = () =>
      runKyselyInsightsMaintenanceStep(db, "sqlite", {
        maxItems: 160,
        maxRequests: 4_096,
      });

    await insights.append(
      event("019a2000-0000-7000-8000-000000000001", "delayed-a", 200, {
        user_id: "current-user",
      }),
    );
    await insights.append(
      event("019a2000-0000-7000-8000-000000000002", "delayed-a", 100, {
        user_id: "historical-user",
      }),
    );
    await insights.append(
      event("019a2000-0000-7000-8000-000000000003", "delayed-b", 150, {
        user_id: "historical-user",
      }),
    );

    const exact = await insights.pageInstallations({
      kind: "installationId",
      installId: "delayed-a",
      limit: 1,
    });
    expect(exact.state).toBe("ready");
    if (exact.state === "ready") {
      expect(exact.data.data).toMatchObject([
        { install_id: "delayed-a", user_id: "current-user" },
      ]);
    }

    const firstPending = await insights.pageInstallations({
      kind: "userId",
      userId: "historical-user",
      limit: 1,
    });
    expect(firstPending.state).toBe("preparing");
    await advance();
    const publicationA = await insights.pageInstallations({
      kind: "userId",
      userId: "historical-user",
      limit: 1,
    });
    expect(publicationA.state).toBe("ready");
    if (
      publicationA.state !== "ready" ||
      publicationA.data.nextCursor === null
    ) {
      return;
    }
    expect(publicationA.data.total.value).toBe(2);
    const publication = publicationA.data.consistency.cutoff.publication;

    await insights.append(
      event("019a2000-0000-7000-8000-000000000004", "delayed-c", 250, {
        user_id: "historical-user",
      }),
    );
    const stale = await insights.pageInstallations({
      kind: "userId",
      userId: "historical-user",
      minAsOfMs: publication.asOfMs + 1,
      limit: 1,
    });
    expect(stale.state).toBe("stale");
    if (stale.state !== "stale") return;
    const activePin = await insights.pageInstallations({
      kind: "userId",
      userId: "historical-user",
      publicationId: stale.refresh.id,
      limit: 1,
    });
    expect(activePin).toEqual({
      state: "expired",
      publicationId: stale.refresh.id,
    });
    await advance();
    const publicationB = await insights.pageInstallations({
      kind: "userId",
      userId: "historical-user",
      minAsOfMs: publication.asOfMs + 1,
      limit: 1,
    });
    expect(publicationB.state).toBe("ready");

    const retainedA = await insights.pageInstallations({
      kind: "userId",
      userId: "historical-user",
      cursor: publicationA.data.nextCursor,
      limit: 1,
    });
    expect(retainedA.state).toBe("ready");
    if (retainedA.state === "ready") {
      expect(retainedA.data.consistency.cutoff.publication.id).toBe(
        publication.id,
      );
      expect(retainedA.data.data).toHaveLength(1);
      expect(
        [...publicationA.data.data, ...retainedA.data.data].find(
          (row) => row.install_id === "delayed-a",
        )?.user_id,
      ).toBe("current-user");
    }
    const tooOldPin = await insights.pageInstallations({
      kind: "userId",
      userId: "historical-user",
      publicationId: publication.id,
      minAsOfMs: publication.asOfMs + 1,
      limit: 1,
    });
    expect(tooOldPin).toEqual({
      state: "expired",
      publicationId: publication.id,
    });
  });

  it("orders report ties by an indexed JavaScript string key", async () => {
    vi.spyOn(Date, "now").mockReturnValue(86_400_000);
    const { native, db } = createDatabase();
    databases.push(db);
    const adapter = kyselyAdapter({ db, provider: "sqlite" });
    await adapter.createMigrator!()
      .migrateToLatest()
      .then((item) => item.execute());
    const insights = createKyselyInsightsModel(db, "sqlite");
    const advance = () =>
      runKyselyInsightsMaintenanceStep(db, "sqlite", {
        maxItems: 160,
        maxRequests: 4_096,
      });
    const labels = ["😀", "é", "Z", "a"];
    for (const [index, cohort] of labels.entries()) {
      await insights.append(
        event(
          `01a3000${index}-0000-7000-8000-00000000000${index}`,
          `order-${index}`,
          index + 1,
          { cohort },
        ),
      );
    }
    const detail = await readyReport(
      () =>
        insights.getReport({
          query: {
            kind: "bundleDetail",
            bundleId: "01900000-0000-7000-8000-000000000021",
            window: "all",
          },
        }),
      advance,
    );
    const cohorts = await insights.pageReport({
      publicationId: detail.data.id,
      section: "movementCohorts",
      metric: "installed",
      limit: 10,
    });
    expect(cohorts.state).toBe("ready");
    if (cohorts.state === "ready") {
      expect(
        cohorts.data.data.map((row) => Reflect.get(row, "cohort")),
      ).toEqual([...labels].sort());
    }
    const plan = native
      .prepare(
        `explain query plan select label, value
          from private_hot_updater_kysely_insights_report_counts
          where job_id = ? and section = 'movementCohorts'
            and metric = 'installed' and bucket_start_ms = -1
          order by label_order limit 160`,
      )
      .all(detail.data.id)
      .map((row) => String(row.detail))
      .join("\n");
    expect(plan).toContain("kysely_insights_counts_order_idx");
    expect(plan).not.toContain("USE TEMP B-TREE");
    const workPlan = native
      .prepare(
        `explain query plan select id from
          private_hot_updater_kysely_insights_report_jobs
          where state = 'preparing' order by as_of_ms, id limit 1`,
      )
      .all()
      .map((row) => String(row.detail))
      .join("\n");
    expect(workPlan).toContain("kysely_insights_report_work_idx");
    expect(workPlan).not.toContain("USE TEMP B-TREE");
  });

  it("uses a bounded native index page with 50,001 stored events", async () => {
    const { native, db } = createDatabase();
    databases.push(db);
    const adapter = kyselyAdapter({ db, provider: "sqlite" });
    await adapter.createMigrator!()
      .migrateToLatest()
      .then((item) => item.execute());

    const insert = native.prepare(`
      insert into private_hot_updater_kysely_insights_events
        (event_id, source_seq, received_at_ms, install_key, install_id,
          event_type, to_bundle_id, from_bundle_id, raw_json)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    native.exec("begin");
    for (let index = 1; index <= 50_001; index += 1) {
      const id = `019a${index.toString(16).padStart(4, "0")}-0000-7000-8000-${index
        .toString(16)
        .padStart(12, "0")}`;
      const row = event(id, `install-${index}`, index);
      insert.run(
        id,
        index,
        index,
        fixtureInstallationKey(row.install_id),
        row.install_id,
        row.type,
        row.to_bundle_id,
        row.from_bundle_id,
        JSON.stringify(row),
      );
    }
    native
      .prepare(
        "update private_hot_updater_kysely_insights_state set next_seq = ? where id = 1",
      )
      .run(50_001);
    native.exec("commit");

    const insights = createKyselyInsightsModel(db, "sqlite");
    const page = await insights.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 60_000,
      limit: 100,
    });
    expect(page.state).toBe("ready");
    if (page.state !== "ready") return;
    expect(page.data.data).toHaveLength(100);
    expect(page.data.nextCursor).not.toBeNull();

    const plan = native
      .prepare(
        `explain query plan select event_id
         from private_hot_updater_kysely_insights_events
         where received_at_ms >= 0 and received_at_ms < 60000
         order by received_at_ms desc, event_id desc limit 101`,
      )
      .all()
      .map((row) => String(row.detail))
      .join("\n");
    expect(plan).toContain("kysely_insights_events_order_idx");
    expect(plan).not.toContain("USE TEMP B-TREE");

    let visited = 0;
    native.function("record_kysely_event_visit", (_eventId: SqliteValue) => {
      visited += 1;
      return 1;
    });
    const physicallyRead = native
      .prepare(
        `select event_id
         from private_hot_updater_kysely_insights_events
         where received_at_ms >= 0 and received_at_ms < 60000
           and record_kysely_event_visit(event_id)
         order by received_at_ms desc, event_id desc limit 101`,
      )
      .all();
    expect(physicallyRead).toHaveLength(101);
    expect(visited).toBe(101);
  });

  it("pages late commits behind the live event keyset across 50,001 rows", async () => {
    const { native, db } = createDatabase();
    databases.push(db);
    const adapter = kyselyAdapter({ db, provider: "sqlite" });
    await adapter.createMigrator!()
      .migrateToLatest()
      .then((item) => item.execute());
    const insights = createKyselyInsightsModel(db, "sqlite");
    await insights.append(
      event("019f0000-0000-7000-8000-000000000001", "cutoff-first", 100_000),
    );
    await insights.append(
      event("019f0000-0000-7000-8000-000000000002", "cutoff-last", 1),
    );
    const first = await insights.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 200_000,
      limit: 1,
    });
    expect(first.state).toBe("ready");
    if (first.state !== "ready" || first.data.nextCursor === null) return;

    const insert = native.prepare(`
      insert into private_hot_updater_kysely_insights_events
        (event_id, source_seq, received_at_ms, install_key, install_id,
          event_type, to_bundle_id, from_bundle_id, raw_json)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    native.exec("begin");
    for (let index = 1; index <= 50_001; index += 1) {
      const id = `01a0${index.toString(16).padStart(4, "0")}-0000-7000-8000-${index
        .toString(16)
        .padStart(12, "0")}`;
      const row = event(id, `post-cutoff-${index}`, 100_000 - index);
      insert.run(
        id,
        index + 2,
        row.received_at_ms,
        fixtureInstallationKey(row.install_id),
        row.install_id,
        row.type,
        row.to_bundle_id,
        row.from_bundle_id,
        JSON.stringify(row),
      );
    }
    native
      .prepare(
        "update private_hot_updater_kysely_insights_state set next_seq = ? where id = 1",
      )
      .run(50_003);
    native.exec("commit");

    const continuation = await insights.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 200_000,
      limit: 7,
      cursor: first.data.nextCursor,
    });
    expect(continuation.state).toBe("ready");
    if (continuation.state === "ready") {
      expect(continuation.data.data).toHaveLength(7);
      expect(
        continuation.data.data.map(({ received_at_ms }) => received_at_ms),
      ).toEqual([99_999, 99_998, 99_997, 99_996, 99_995, 99_994, 99_993]);
      expect(continuation.data.nextCursor).not.toBeNull();
      expect(continuation.versions.sourceGeneration).not.toBe(
        first.versions.sourceGeneration,
      );
    }
  });

  it("finishes a captured alias prefix ahead of 50,001 future aliases", async () => {
    const { native, db } = createDatabase();
    databases.push(db);
    const adapter = kyselyAdapter({ db, provider: "sqlite" });
    await adapter.createMigrator!()
      .migrateToLatest()
      .then((item) => item.execute());
    const insights = createKyselyInsightsModel(db, "sqlite");
    await insights.append(
      event("01a10000-0000-7000-8000-000000000001", "bounded-alias", 1),
    );
    const pending = await insights.pageInstallations({
      kind: "contains",
      query: "bounded-alias",
      limit: 10,
    });
    expect(pending.state).toBe("preparing");

    const insert = native.prepare(`
      insert into private_hot_updater_kysely_insights_aliases
        (install_key, install_id, alias_kind, alias_hash, value_json,
          normalized_json, source_seq)
      values (?, ?, 'user', ?, ?, ?, ?)
    `);
    native.exec("begin");
    for (let index = 1; index <= 50_001; index += 1) {
      const installKey = index.toString(16).padStart(64, "0");
      const aliasHash = (index + 50_001).toString(16).padStart(64, "0");
      insert.run(
        installKey,
        `future-${index}`,
        aliasHash,
        JSON.stringify(`future-${index}`),
        JSON.stringify(`future-${index}`),
        index + 1,
      );
    }
    native.exec("commit");

    const step = await runKyselyInsightsMaintenanceStep(db, "sqlite", {
      maxItems: 160,
      maxRequests: 4_096,
    });
    expect(step).toMatchObject({
      state: "published",
      processed: 3,
      ...(pending.state === "preparing" ? { jobId: pending.job.id } : {}),
    });
    const ready = await insights.pageInstallations({
      kind: "contains",
      query: "bounded-alias",
      limit: 10,
    });
    expect(ready.state).toBe("ready");
    if (ready.state === "ready") {
      expect(ready.data.data).toMatchObject([{ install_id: "bounded-alias" }]);
    }
    const plan = native
      .prepare(
        `explain query plan select install_key
          from private_hot_updater_kysely_insights_aliases
          where source_seq <= 1
          order by source_seq, install_key, alias_kind, alias_hash
          limit 128`,
      )
      .all()
      .map((row) => String(row.detail))
      .join("\n");
    expect(plan).toContain("kysely_insights_alias_source_idx");
    expect(plan).not.toContain("USE TEMP B-TREE");
    const workPlan = native
      .prepare(
        `explain query plan select id from
          private_hot_updater_kysely_insights_search_jobs
          where state = 'preparing' order by as_of_ms, id limit 1`,
      )
      .all()
      .map((row) => String(row.detail))
      .join("\n");
    expect(workPlan).toContain("kysely_insights_search_work_idx");
    expect(workPlan).not.toContain("USE TEMP B-TREE");
  });

  it("shortens a byte-heavy page without dropping raw provider fields", async () => {
    const { db } = createDatabase();
    databases.push(db);
    const adapter = kyselyAdapter({ db, provider: "sqlite" });
    await adapter.createMigrator!()
      .migrateToLatest()
      .then((item) => item.execute());
    const insights = createKyselyInsightsModel(db, "sqlite");
    for (let index = 1; index <= 101; index += 1) {
      const id = `019b${index.toString(16).padStart(4, "0")}-0000-7000-8000-${index
        .toString(16)
        .padStart(12, "0")}`;
      const row = Object.assign(event(id, `large-${index}`, index), {
        provider_payload: Array.from({ length: 11 }, () => "x".repeat(1_000)),
      });
      await insights.append(row);
    }

    const page = await insights.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 200,
      limit: 100,
    });
    expect(page.state).toBe("ready");
    if (page.state !== "ready") return;
    expect(page.data.data.length).toBeLessThan(100);
    expect(page.data.nextCursor).not.toBeNull();
    const providerPayload = Reflect.get(page.data.data[0]!, "provider_payload");
    expect(providerPayload).toHaveLength(11);
    expect(providerPayload[0]).toHaveLength(1_000);
    expect(getCanonicalInsightsJsonByteLength(page)).toBeLessThanOrEqual(
      INSIGHTS_PAGE_MAX_BYTES,
    );
  });

  it("checkpoints an interrupted populated migration from the first UUID", async () => {
    const { native, db } = createDatabase();
    databases.push(db);
    const core = await createKyselyMigrator({
      db,
      provider: "sqlite",
    }).migrateToLatest();
    await core.execute();
    const rows = [
      event("00000000-0000-7000-8000-000000000000", "sentinel-install", 1),
      ...Array.from({ length: 320 }, (_, index) =>
        event(
          `019c${index.toString(16).padStart(4, "0")}-0000-7000-8000-${index
            .toString(16)
            .padStart(12, "0")}`,
          `legacy-${index}`,
          index + 2,
        ),
      ),
    ];
    const columns = Object.keys(rows[0]!).join(", ");
    const placeholders = Object.keys(rows[0]!)
      .map(() => "?")
      .join(", ");
    const insert = native.prepare(
      `insert into bundle_events (${columns}) values (${placeholders})`,
    );
    native.exec("begin");
    for (const row of rows) {
      insert.run(...(Object.values(row) as SqliteValue[]));
    }
    native.exec("commit");

    await migrateKyselyInsights(db, "sqlite");
    expect(
      native
        .prepare(
          `select ready, migration_after_id, migration_upper_id
            from private_hot_updater_kysely_insights_state where id = 1`,
        )
        .get(),
    ).toMatchObject({ ready: 0, migration_after_id: null });
    expect(
      native
        .prepare(
          "select count(*) as value from private_hot_updater_kysely_insights_events",
        )
        .get(),
    ).toMatchObject({ value: 0 });

    const first = await prepareKyselyInsightsSource(db, "sqlite", 1);
    expect(first).toEqual({ state: "progress", processed: 1 });
    expect(
      native
        .prepare(
          `select migration_after_id
            from private_hot_updater_kysely_insights_state where id = 1`,
        )
        .get(),
    ).toMatchObject({
      migration_after_id: "00000000-0000-7000-8000-000000000000",
    });
    await createKyselyInsightsModel(db, "sqlite").append(
      event(
        "019d0000-0000-7000-8000-000000000001",
        "accepted-before-ready",
        500,
      ),
    );
    await createKyselyInsightsModel(db, "sqlite").append(
      event(
        "00000000-0000-7000-8000-000000000001",
        "accepted-inside-captured-range",
        501,
      ),
    );
    for (;;) {
      const step = await prepareKyselyInsightsSource(db, "sqlite", 17);
      if (step.state === "ready") break;
    }
    await createKyselyInsightsModel(db, "sqlite").append(
      event(
        "019d0000-0000-7000-8000-000000000002",
        "accepted-after-ready",
        502,
      ),
    );
    expect(
      native
        .prepare(
          "select count(*) as value from private_hot_updater_kysely_insights_events",
        )
        .get(),
    ).toMatchObject({ value: rows.length + 3 });
  });

  it("rolls back source allocation when a native append fails", async () => {
    const { native, db } = createDatabase();
    databases.push(db);
    const adapter = kyselyAdapter({ db, provider: "sqlite" });
    await adapter.createMigrator!()
      .migrateToLatest()
      .then((item) => item.execute());
    const rejected = event(
      "019e0000-0000-7000-8000-000000000001",
      "rollback-install",
      1,
    );
    native.exec(`create trigger reject_kysely_insights_event
      before insert on private_hot_updater_kysely_insights_events
      when new.event_id = '${rejected.id}'
      begin select raise(abort, 'forced'); end`);
    const insights = createKyselyInsightsModel(db, "sqlite");
    const accepted = Array.from({ length: 20 }, (_, index) =>
      event(
        `019e${(index + 1).toString(16).padStart(4, "0")}-0000-7000-8000-${(
          index + 2
        )
          .toString(16)
          .padStart(12, "0")}`,
        `concurrent-${index}`,
        index + 2,
      ),
    );
    const writes = await Promise.allSettled([
      insights.append(rejected),
      ...accepted.map((row) => insights.append(row)),
    ]);
    expect(writes.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(
      native
        .prepare(
          `select next_seq,
            (select count(*) from bundle_events) as core_count,
            (select count(*) from private_hot_updater_kysely_insights_events)
              as source_count
            from private_hot_updater_kysely_insights_state where id = 1`,
        )
        .get(),
    ).toMatchObject({ next_seq: 20, core_count: 20, source_count: 20 });
    expect(
      native
        .prepare(
          `select source_seq from private_hot_updater_kysely_insights_events
            order by source_seq`,
        )
        .all()
        .map(({ source_seq }) => source_seq),
    ).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(
      native
        .prepare("select count(*) as value from bundle_events where id = ?")
        .get(rejected.id),
    ).toMatchObject({ value: 0 });
    native.exec("drop trigger reject_kysely_insights_event");
    await insights.append(rejected);
    expect(
      native
        .prepare(
          `select source_seq from private_hot_updater_kysely_insights_events
            where event_id = ?`,
        )
        .get(rejected.id),
    ).toMatchObject({ source_seq: 21 });
  });

  it("keeps a semantic search failure durable across polls", async () => {
    const { native, db } = createDatabase();
    databases.push(db);
    const adapter = kyselyAdapter({ db, provider: "sqlite" });
    await adapter.createMigrator!()
      .migrateToLatest()
      .then((item) => item.execute());
    const insights = createKyselyInsightsModel(db, "sqlite");
    await insights.append(
      event("019e1000-0000-7000-8000-000000000001", "failed-search", 1),
    );
    const pending = await insights.pageInstallations({
      kind: "contains",
      query: "failed",
      limit: 10,
    });
    expect(pending.state).toBe("preparing");
    if (pending.state !== "preparing") return;
    native.exec(`update private_hot_updater_kysely_insights_aliases
      set normalized_json = '{'`);
    const step = await runKyselyInsightsMaintenanceStep(db, "sqlite", {
      maxItems: 160,
      maxRequests: 4_096,
    });
    expect(step).toMatchObject({ state: "failed", jobId: pending.job.id });
    for (let index = 0; index < 2; index += 1) {
      const failed = await insights.pageInstallations({
        kind: "contains",
        query: "failed",
        limit: 10,
      });
      expect(failed).toMatchObject({
        state: "failed",
        error: { jobId: pending.job.id },
      });
    }
    expect(
      native
        .prepare(
          `select count(*) as value
            from private_hot_updater_kysely_insights_search_jobs`,
        )
        .get(),
    ).toMatchObject({ value: 1 });
  });

  it("durably names the first arbitrary-width legacy poison", async () => {
    const { native, db } = createDatabase();
    databases.push(db);
    const core = await createKyselyMigrator({
      db,
      provider: "sqlite",
    }).migrateToLatest();
    await core.execute();
    const poisonIds = [
      `A-${"x".repeat(80)}`,
      `a-${"x".repeat(80)}`,
      `a-${"x".repeat(79)} `,
    ];
    const poisons = poisonIds.map((id, index) =>
      event(id, `poison-install-${index}`, 1_000 + index),
    );
    const columns = Object.keys(poisons[0]!).join(", ");
    const placeholders = Object.keys(poisons[0]!)
      .map(() => "?")
      .join(", ");
    const insert = native.prepare(
      `insert into bundle_events (${columns}) values (${placeholders})`,
    );
    for (const poison of poisons) {
      insert.run(...(Object.values(poison) as SqliteValue[]));
    }
    await migrateKyselyInsights(db, "sqlite");

    await expect(prepareKyselyInsightsSource(db, "sqlite")).rejects.toThrow();
    expect(
      native.prepare("select count(*) as value from bundle_events").get(),
    ).toMatchObject({ value: 3 });
    expect(
      native
        .prepare(
          "select count(*) as value from private_hot_updater_kysely_insights_events",
        )
        .get(),
    ).toMatchObject({ value: 0 });
    expect(
      native
        .prepare(
          "select ready, poison_event_id from private_hot_updater_kysely_insights_state where id = 1",
        )
        .get(),
    ).toMatchObject({
      ready: 0,
      poison_event_id: poisonIds[0],
    });
  });

  it("rejects an oversized legacy field before source materialization", async () => {
    const { native, db } = createDatabase();
    databases.push(db);
    const core = await createKyselyMigrator({
      db,
      provider: "sqlite",
    }).migrateToLatest();
    await core.execute();
    const oversized = event(
      "01a20000-0000-7000-8000-000000000001",
      "oversized-legacy",
      1,
      { username: "x".repeat(20_481) },
    );
    const columns = Object.keys(oversized).join(", ");
    const placeholders = Object.keys(oversized)
      .map(() => "?")
      .join(", ");
    native
      .prepare(
        `insert into bundle_events (${columns}) values (${placeholders})`,
      )
      .run(...(Object.values(oversized) as SqliteValue[]));
    await migrateKyselyInsights(db, "sqlite");

    await expect(prepareKyselyInsightsSource(db, "sqlite")).rejects.toThrow();
    expect(
      native
        .prepare(
          `select poison_event_id
            from private_hot_updater_kysely_insights_state where id = 1`,
        )
        .get(),
    ).toMatchObject({ poison_event_id: oversized.id });
    expect(
      native
        .prepare(
          `select count(*) as value
            from private_hot_updater_kysely_insights_events`,
        )
        .get(),
    ).toMatchObject({ value: 0 });
    const plan = native
      .prepare(
        `explain query plan select id from bundle_events
          where id <= ? order by id limit 160`,
      )
      .all(oversized.id)
      .map((row) => String(row.detail))
      .join("\n");
    expect(plan).toContain("sqlite_autoindex_bundle_events_1");
    expect(plan).not.toContain("USE TEMP B-TREE");
  });

  it("runs the PostgreSQL native DDL and keyset read path", async () => {
    const db = new Kysely<object>({ dialect: new PGliteDialect(new PGlite()) });
    databases.push(db);
    const adapter = kyselyAdapter({ db, provider: "postgresql" });
    await adapter.createMigrator!()
      .migrateToLatest()
      .then((item) => item.execute());
    const insights = createKyselyInsightsModel(db, "postgresql");
    await insights.append(
      event("019a0000-0000-7000-8000-000000000011", "postgres-install", 1),
    );
    const page = await insights.pageEvents({
      selector: { kind: "installationId", installId: "postgres-install" },
      beforeReceivedAtMs: 2,
      limit: 1,
    });
    expect(page.state).toBe("ready");
    if (page.state === "ready") {
      expect(page.data.data).toMatchObject([
        { install_id: "postgres-install" },
      ]);
    }
  });
});
