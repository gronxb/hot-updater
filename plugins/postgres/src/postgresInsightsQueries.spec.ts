import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import {
  createInsightsReportPageCursor,
  type DatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import {
  migratePostgresInsightsLive,
  migratePostgresInsightsReports,
  migratePostgresInsightsSource,
} from "./db";
import { createPostgresInsightsLiveTools } from "./postgresInsightsLive";
import { createPostgresInsightsQueries } from "./postgresInsightsQueries";
import { createPostgresInsightsReportWorker } from "./postgresInsightsReports";
import { createPostgresInsightsSearchPageCursor } from "./postgresInsightsSearchPages";
import {
  appendPostgresInsightsEvent,
  createPostgresInsightsSourceTools,
} from "./postgresInsightsSource";
import type { Database } from "./types";

const unsupported = async (): Promise<never> => {
  throw new Error("unexpected generic database operation");
};

describe("PostgreSQL required Insights port", () => {
  let client: PGlite;
  let db: Kysely<Database>;
  let databaseNamespace: string;
  let statements: string[];

  beforeEach(async () => {
    client = new PGlite();
    await client.exec(
      await readFile("plugins/postgres/sql/bundles.sql", "utf8"),
    );
    statements = [];
    db = new Kysely<Database>({
      dialect: new PGliteDialect(client),
      log: (event) => {
        statements.push(event.query.sql);
      },
    });
    await migratePostgresInsightsSource(db);
    await createPostgresInsightsSourceTools(db).backfillStep(10);
    await migratePostgresInsightsLive(db);
    await createPostgresInsightsLiveTools(db).backfillStep(10);
    await migratePostgresInsightsReports(db);
    databaseNamespace = (
      await sql<{ source_id: string }>`select source_id::text
        from private_hot_updater_insights_source_state where id=1`.execute(db)
    ).rows[0]!.source_id;
  });

  afterEach(async () => {
    await db.destroy();
    await client.close();
  });

  it("wires all five required methods and rejects foreign namespaces before I/O", async () => {
    const appendBundleEvent = vi.fn((row) =>
      appendPostgresInsightsEvent(db, row).then(() => undefined),
    );
    const implementation: DatabasePluginImplementation = {
      appendBundleEvent,
      create: unsupported,
      update: unsupported,
      delete: unsupported,
      count: unsupported,
      findOne: unsupported,
      findMany: unsupported,
      insertChannel: unsupported,
      deleteChannel: unsupported,
    };
    const insights = createPostgresInsightsQueries(
      db,
      implementation,
      databaseNamespace,
    );
    const event = {
      ...createBundleEventRowFixture("1", 100),
      install_id: "required-port-installation",
    };

    await insights.append(event);
    expect(appendBundleEvent).toHaveBeenCalledExactlyOnceWith(event);

    await expect(
      insights.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: 101,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      state: "ready",
      data: { data: [event], hasNext: false, nextCursor: null },
    });
    await expect(
      insights.pageInstallations({ kind: "all", limit: 1 }),
    ).resolves.toMatchObject({
      state: "ready",
      data: { data: [expect.objectContaining({ id: event.id })] },
    });

    const preparing = await insights.getReport({
      query: { kind: "installationOverview" },
    });
    expect(preparing.state).toBe("preparing");
    if (preparing.state !== "preparing")
      throw new Error("Expected a reserved report job.");
    await expect(
      insights.pageReport({
        publicationId: preparing.job.id,
        section: "movementSeries",
        metric: "installed",
        limit: 1,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });

    const reportInput = {
      publicationId: preparing.job.id,
      section: "movementSeries" as const,
      metric: "installed" as const,
      limit: 1,
    };
    statements = [];
    await expect(
      insights.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: 101,
        limit: 1,
        cursor: JSON.stringify([
          "postgres-events-v1",
          JSON.stringify(["all"]),
          101,
          0,
          "00000000-0000-0000-0000-000000000099",
          100,
          event.id,
          "received-desc-id-desc",
        ]),
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    const foreignSearchInput = {
      kind: "contains" as const,
      query: "required-port",
      publicationId: preparing.job.id,
      limit: 1,
    };
    await expect(
      insights.pageInstallations({
        ...foreignSearchInput,
        cursor: createPostgresInsightsSearchPageCursor(
          foreignSearchInput,
          preparing.job.id,
          0,
          "00000000-0000-0000-0000-000000000099",
        ),
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    await expect(
      insights.pageInstallations({
        kind: "all",
        limit: 1,
        cursor: JSON.stringify([
          "postgres-live-v1",
          "00000000-0000-0000-0000-000000000099",
          event.install_id,
        ]),
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    await expect(
      insights.pageReport({
        ...reportInput,
        cursor: createInsightsReportPageCursor(
          reportInput,
          "0",
          "00000000-0000-0000-0000-000000000099",
        ),
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    expect(statements).toEqual([]);

    const worker = createPostgresInsightsReportWorker(db);
    const finish = async (input: Parameters<typeof insights.getReport>[0]) => {
      for (let i = 0; i < 100; i++) {
        const result = await insights.getReport(input);
        if (result.state === "ready") return result.data;
        await worker.runStep({ maxItems: 4096, maxRequests: 4096 });
      }
      throw new Error("Report fixture did not publish.");
    };
    await finish({ query: { kind: "installationOverview" } });
    await sql`delete from private_hot_updater_insights_report_order_rows
      where job_id=${preparing.job.id}::uuid and section='bundleDistribution'`.execute(
      db,
    );
    await expect(
      insights.pageReport({
        publicationId: preparing.job.id,
        section: "bundleDistribution",
        limit: 1,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });

    const activeEvent = {
      ...createBundleEventRowFixture("2", Date.now() - 1_000),
      install_id: "active-installation",
    };
    await insights.append(activeEvent);
    const activeInput = {
      query: { kind: "activeOverview" as const, window: "7d" as const },
    };
    const active = await finish(activeInput);
    const positive = (
      await sql<{ count_key: string }>`select count_key
        from private_hot_updater_insights_report_counts
        where job_id=${active.id}::uuid and section='activeSeries' limit 1`.execute(
        db,
      )
    ).rows[0];
    expect(positive).toBeDefined();
    await sql`delete from private_hot_updater_insights_report_counts
      where job_id=${active.id}::uuid and count_key=${positive!.count_key}`.execute(
      db,
    );
    await expect(
      insights.pageReport({
        publicationId: active.id,
        section: "activeSeries",
        limit: 7,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
    await sql`delete from private_hot_updater_insights_report_count_manifest
      where job_id=${active.id}::uuid and count_key=(select count_key
        from private_hot_updater_insights_report_counts
        where job_id=${active.id}::uuid and section='activeBundleSeries' limit 1)`.execute(
      db,
    );
    await expect(
      insights.pageReport({
        publicationId: active.id,
        section: "activeBundleSeries",
        bundleId: activeEvent.to_bundle_id,
        limit: 7,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });

    const publishedSearchInput = {
      kind: "contains" as const,
      query: "required-port",
      limit: 1,
    };
    let searchPublicationId: string | undefined;
    for (let i = 0; i < 100; i++) {
      const result = await insights.pageInstallations(publishedSearchInput);
      if (result.state === "ready") {
        const cutoff = result.data.consistency.cutoff;
        if (cutoff.kind !== "publication")
          throw new Error("Expected a search publication.");
        searchPublicationId = cutoff.publication.id;
        break;
      }
      await worker.runStep({ maxItems: 4096, maxRequests: 4096 });
    }
    expect(searchPublicationId).toBeDefined();
    await sql`update private_hot_updater_insights_report_jobs set publication='{}'::json
      where id=${searchPublicationId!}::uuid`.execute(db);
    await expect(
      insights.pageInstallations({
        ...publishedSearchInput,
        publicationId: searchPublicationId!,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });

    await sql`update private_hot_updater_insights_report_jobs set publication='{}'::json
      where id=${preparing.job.id}::uuid`.execute(db);
    await expect(
      insights.getReport({ query: { kind: "installationOverview" } }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });

    await sql`update bundle_events set install_id=${"x".repeat(1025)}
      where id=${activeEvent.id}::uuid`.execute(db);
    await expect(
      insights.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: Date.now() + 1_000,
        limit: 2,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
    await sql`update private_hot_updater_insights_live_installations
      set event=jsonb_set(event,'{install_id}','"tampered"'::jsonb)
      where install_id=${activeEvent.install_id}`.execute(db);
    await expect(
      insights.pageInstallations({ kind: "all", limit: 2 }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
  });
});
