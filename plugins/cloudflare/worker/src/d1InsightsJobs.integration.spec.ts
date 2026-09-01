import {
  INSIGHTS_EVENT_MAX_BYTES,
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
  INSIGHTS_PAGE_MAX_BYTES,
  canonicalInsightsJson,
  getCanonicalInsightsJsonByteLength,
} from "@hot-updater/plugin-core/internal";
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, expect, inject, it } from "vitest";

import { createBundleEventRowFixture } from "../../../../packages/test-utils/src/databaseTestFixtures";
import type { D1Executor, D1Statement } from "../../src/d1Implementation";
import {
  assertD1InsightsJobsLayout,
  createD1InsightsMaintenance,
} from "../../src/d1InsightsJobs";
import { createD1RequiredInsightsModel } from "../../src/d1InsightsRequired";
import { d1InsightsInstallKey } from "../../src/d1InsightsSource";

declare module "vitest" {
  export interface ProvidedContext {
    prepareSql: string;
  }
}

const executor: D1Executor = {
  async query(sql, params) {
    const result = await env.DB.prepare(sql)
      .bind(...params)
      .all();
    return result.results;
  },
  async batch(statements: readonly D1Statement[]) {
    const results = await env.DB.batch(
      statements.map(({ sql, params }) => env.DB.prepare(sql).bind(...params)),
    );
    return results.map(({ results }) => results ?? []);
  },
};

const reset = async () => {
  await env.DB.prepare(`
    DELETE FROM private_hot_updater_insights_job_page_rows;
    DELETE FROM private_hot_updater_insights_job_sections;
    DELETE FROM private_hot_updater_insights_job_order;
    DELETE FROM private_hot_updater_insights_job_memberships;
    DELETE FROM private_hot_updater_insights_job_counts;
    DELETE FROM private_hot_updater_insights_job_latest;
    DELETE FROM private_hot_updater_insights_jobs;
    DELETE FROM private_hot_updater_insights_job_heads;
    DELETE FROM private_hot_updater_insights_installation_versions;
    DELETE FROM private_hot_updater_insights_installation_aliases;
    DELETE FROM private_hot_updater_insights_live_installations;
    DELETE FROM private_hot_updater_insights_installation_events;
    DELETE FROM private_hot_updater_insights_bundle_events;
    DELETE FROM private_hot_updater_insights_source_events;
    DELETE FROM private_hot_updater_insights_pending_events;
    DELETE FROM bundle_events;
    UPDATE private_hot_updater_insights_source_state
    SET generation = 0, status = 'ready',
      backfill_upper_received_at_ms = NULL, backfill_upper_id = NULL,
      backfill_after_received_at_ms = NULL, backfill_after_id = NULL
    WHERE id = 1;
  `).run();
};

beforeAll(async () => {
  await env.DB.prepare(inject("prepareSql")).run();
});

beforeEach(reset);

it("rejects same-name job tables, indexes, and triggers with the wrong shape", async () => {
  const names = [
    "private_hot_updater_insights_job_sections",
    "private_hot_updater_insights_job_query_idx",
    "insights_job_membership_count",
  ] as const;
  const originals = new Map<string, string>();
  for (const name of names) {
    const sql = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE name = ?",
    )
      .bind(name)
      .first<string>("sql");
    if (sql === null) throw new Error(`missing schema object ${name}`);
    originals.set(name, sql);
  }

  await env.DB.prepare("DROP TRIGGER insights_job_membership_count").run();
  await env.DB.prepare(
    `CREATE TRIGGER insights_job_membership_count
    AFTER INSERT ON private_hot_updater_insights_job_memberships
    BEGIN SELECT 1; END`,
  ).run();
  await expect(assertD1InsightsJobsLayout(executor)).rejects.toThrow();
  await env.DB.prepare("DROP TRIGGER insights_job_membership_count").run();
  await env.DB.prepare(originals.get(names[2])!).run();

  await env.DB.prepare(
    "DROP INDEX private_hot_updater_insights_job_query_idx",
  ).run();
  await env.DB.prepare(
    `CREATE INDEX private_hot_updater_insights_job_query_idx
    ON private_hot_updater_insights_jobs(status, query_key, id)`,
  ).run();
  await expect(assertD1InsightsJobsLayout(executor)).rejects.toThrow();
  await env.DB.prepare(
    "DROP INDEX private_hot_updater_insights_job_query_idx",
  ).run();
  await env.DB.prepare(originals.get(names[1])!).run();

  await env.DB.prepare(
    "DROP TABLE private_hot_updater_insights_job_sections",
  ).run();
  await env.DB.prepare(
    `CREATE TABLE private_hot_updater_insights_job_sections (
      job_id TEXT, section_key TEXT, total_rows INTEGER
    )`,
  ).run();
  await expect(assertD1InsightsJobsLayout(executor)).rejects.toThrow();
  await env.DB.prepare(
    "DROP TABLE private_hot_updater_insights_job_sections",
  ).run();
  await env.DB.prepare(originals.get(names[0])!).run();
  await expect(assertD1InsightsJobsLayout(executor)).resolves.toBeUndefined();
});

const runToPublication = async (maximumSteps = 100) => {
  const maintenance = createD1InsightsMaintenance(executor);
  for (let step = 0; step < maximumSteps; step += 1) {
    const result = await maintenance.runStep({
      maxItems: 4096,
      maxRequests: 50,
    });
    expect(result.requests).toBeLessThanOrEqual(50);
    if (result.state === "published") return result;
    expect(result.state).toBe("progress");
  }
  throw new Error(
    "D1 Insights publication did not finish within the test bound.",
  );
};

it("defers a healthy claimed job when request budget or D1 reads are exhausted", async () => {
  const insights = createD1RequiredInsightsModel(executor, "d1-jobs");
  await insights.append({
    ...createBundleEventRowFixture("959", 100),
    install_id: "retry-install",
    username: "retry-match",
  });
  const input = {
    kind: "contains" as const,
    query: "retry-match",
    limit: 100,
  };
  const preparing = await insights.pageInstallations(input);
  if (preparing.state !== "preparing") throw new Error("search was not queued");

  const bounded = await createD1InsightsMaintenance(executor).runStep({
    maxItems: 256,
    maxRequests: 9,
  });
  expect(bounded).toMatchObject({
    state: "not-ready",
    processed: 0,
    jobId: preparing.job.id,
  });
  expect(bounded.requests).toBeLessThanOrEqual(9);
  await expect(
    env.DB.prepare(
      `SELECT status, failure_code FROM private_hot_updater_insights_jobs
      WHERE id = ?`,
    )
      .bind(preparing.job.id)
      .first(),
  ).resolves.toEqual({ status: "queued", failure_code: null });

  await env.DB.prepare(
    `UPDATE private_hot_updater_insights_jobs SET claimable_at_ms = 0
    WHERE id = ?`,
  )
    .bind(preparing.job.id)
    .run();
  let failedOnce = false;
  const transient: D1Executor = {
    async query(sql, params) {
      if (
        !failedOnce &&
        /FROM private_hot_updater_insights_installation_aliases/.test(sql)
      ) {
        failedOnce = true;
        throw new Error("temporary D1 read failure");
      }
      return executor.query(sql, params);
    },
    batch: executor.batch,
  };
  const deferred = await createD1InsightsMaintenance(transient).runStep({
    maxItems: 256,
    maxRequests: 50,
  });
  expect(deferred).toMatchObject({
    state: "not-ready",
    processed: 0,
    jobId: preparing.job.id,
  });
  expect(deferred.requests).toBeLessThanOrEqual(50);
  await expect(
    env.DB.prepare(
      `SELECT status, failure_code FROM private_hot_updater_insights_jobs
      WHERE id = ?`,
    )
      .bind(preparing.job.id)
      .first(),
  ).resolves.toEqual({ status: "queued", failure_code: null });

  await env.DB.prepare(
    `UPDATE private_hot_updater_insights_jobs SET claimable_at_ms = 0
    WHERE id = ?`,
  )
    .bind(preparing.job.id)
    .run();
  await runToPublication();
  await expect(insights.pageInstallations(input)).resolves.toMatchObject({
    state: "ready",
    data: { total: { state: "exact", value: 1 } },
  });
});

it("deduplicates historical aliases with JS lowercase semantics", async () => {
  const insights = createD1RequiredInsightsModel(executor, "d1-jobs");
  const first = {
    ...createBundleEventRowFixture("1201", 100),
    install_id: "unicode-install",
    user_id: "historical-user",
    username: "İ😀PrefixCase",
  };
  await insights.append(first);
  for (let index = 0; index < 20; index += 1) {
    await insights.append({
      ...first,
      id: createBundleEventRowFixture(String(1_202 + index), 101 + index).id,
      received_at_ms: 101 + index,
    });
  }
  await expect(
    env.DB.prepare(
      `SELECT count(*) FROM private_hot_updater_insights_installation_aliases`,
    ).first<number>("count(*)"),
  ).resolves.toBe(3);

  const latest = {
    ...createBundleEventRowFixture("1222", 200),
    install_id: first.install_id,
    user_id: "current-user",
    username: "Current Name",
  };
  await insights.append(latest);
  const input = { kind: "contains" as const, query: "İ😀PRE", limit: 100 };
  const preparing = await insights.pageInstallations(input);
  if (preparing.state !== "preparing") throw new Error("search was not queued");
  await expect(
    env.DB.prepare(
      `SELECT source_alias_upper_id, source_generation
      FROM private_hot_updater_insights_jobs WHERE id = ?`,
    )
      .bind(preparing.job.id)
      .first(),
  ).resolves.toEqual({ source_alias_upper_id: 5, source_generation: 22 });

  const future = {
    ...createBundleEventRowFixture("1223", 300),
    install_id: "future-install",
    user_id: "future-user",
    username: first.username,
  };
  await insights.append(future);
  await runToPublication();
  await expect(insights.pageInstallations(input)).resolves.toMatchObject({
    state: "ready",
    data: {
      data: [expect.objectContaining({ id: latest.id })],
      total: { state: "exact", value: 1 },
    },
  });

  const userInput = {
    kind: "userId" as const,
    userId: "historical-user",
    limit: 100,
  };
  await expect(insights.pageInstallations(userInput)).resolves.toMatchObject({
    state: "preparing",
  });
  await runToPublication();
  await expect(insights.pageInstallations(userInput)).resolves.toMatchObject({
    state: "ready",
    data: {
      data: [expect.objectContaining({ id: latest.id })],
      total: { state: "exact", value: 1 },
    },
  });
});

it("shortens a published search page before the serialized 1 MiB limit", async () => {
  const insights = createD1RequiredInsightsModel(executor, "d1-jobs");
  const large = (prefix: string) =>
    `${prefix}${"x".repeat(1024 - prefix.length)}`;
  for (let index = 0; index < 100; index += 1) {
    const fixture = createBundleEventRowFixture(
      String(10_000 + index),
      index + 1,
    );
    if (fixture.type === "UNCHANGED") throw new Error("invalid fixture type");
    const event = {
      ...fixture,
      install_id: large(`install-${index}-`),
      user_id: large(`user-${index}-`),
      username: large(`needle-${index}-`),
      from_bundle_id: large(`from-bundle-${index}-`),
      from_release_id: large(`from-release-${index}-`),
      to_bundle_id: large(`to-bundle-${index}-`),
      to_release_id: large(`to-release-${index}-`),
      app_version: large(`app-version-${index}-`),
      channel: large(`channel-${index}-`),
      cohort: large(`cohort-${index}-`),
      fingerprint_hash: large(`fingerprint-${index}-`),
      sdk_version: large(`sdk-${index}-`),
    };
    expect(getCanonicalInsightsJsonByteLength(event)).toBeLessThanOrEqual(
      INSIGHTS_EVENT_MAX_BYTES,
    );
    await insights.append(event);
  }
  const input = { kind: "contains" as const, query: "needle-", limit: 100 };
  await expect(insights.pageInstallations(input)).resolves.toMatchObject({
    state: "preparing",
  });
  await runToPublication();

  const initial = await insights.pageInstallations(input);
  if (initial.state !== "ready") throw new Error("search was not ready");
  const firstPublicationId = initial.data.consistency.cutoff.publication.id;
  await env.DB.prepare(
    `UPDATE private_hot_updater_insights_jobs
    SET as_of_ms = 0,
      publication_json = json_set(publication_json, '$.asOfMs', 0)
    WHERE id = ?`,
  )
    .bind(firstPublicationId)
    .run();
  const first = await insights.pageInstallations(input);
  expect(first.state).toBe("ready");
  if (first.state !== "ready") throw new Error("search was not ready");
  expect(first.data.data.length).toBeGreaterThan(0);
  expect(first.data.data.length).toBeLessThan(100);
  expect(first.data.hasNext).toBe(true);
  expect(first.data.nextCursor).not.toBeNull();
  expect(getCanonicalInsightsJsonByteLength(first)).toBeLessThanOrEqual(
    INSIGHTS_PAGE_MAX_BYTES,
  );
  expect(getCanonicalInsightsJsonByteLength(first)).toBeGreaterThan(500_000);

  const stale = await insights.pageInstallations({ ...input, minAsOfMs: 1 });
  expect(stale.state).toBe("stale");
  await runToPublication();
  const current = await insights.pageInstallations({ ...input, minAsOfMs: 1 });
  if (current.state !== "ready") throw new Error("refresh was not ready");
  expect(current.data.consistency.cutoff.publication.id).not.toBe(
    firstPublicationId,
  );

  const second = await insights.pageInstallations({
    ...input,
    cursor: first.data.nextCursor!,
  });
  expect(second.state).toBe("ready");
  if (second.state !== "ready") throw new Error("continuation was not ready");
  expect(second.data.consistency.cutoff.publication.id).toBe(
    firstPublicationId,
  );
  expect(second.data.total).toMatchObject({ state: "exact", value: 100 });
  expect(
    new Set(
      [...first.data.data, ...second.data.data].map(
        ({ install_id }) => install_id,
      ),
    ).size,
  ).toBe(100);
});

it("keeps active projection bind values bounded for canonical 20 KiB events", async () => {
  const textEncoder = new TextEncoder();
  let maximumBindBytes = 0;
  const measure = (params: readonly string[]) => {
    for (const param of params) {
      maximumBindBytes = Math.max(
        maximumBindBytes,
        textEncoder.encode(param).byteLength,
      );
    }
  };
  const measured: D1Executor = {
    async query(sql, params) {
      measure(params);
      return executor.query(sql, params);
    },
    async batch(statements) {
      for (const statement of statements) measure(statement.params);
      return executor.batch(statements);
    },
  };
  const insights = createD1RequiredInsightsModel(measured, "d1-jobs");
  const now = Date.now();
  for (let index = 0; index < 24; index += 1) {
    const base = {
      ...createBundleEventRowFixture(
        String(1_300 + index),
        now - 10_000 - index,
      ),
      type: "UNCHANGED" as const,
      from_bundle_id: null,
      from_release_id: null,
      update_strategy: null,
    };
    let boundary:
      | (typeof base & {
          readonly provider_extension: readonly string[];
        })
      | null = null;
    for (let full = 0; full < 32 && boundary === null; full += 1) {
      const providerExtension = [
        ...Array.from({ length: full }, () => "x".repeat(1_024)),
        "",
      ];
      const candidate = { ...base, provider_extension: providerExtension };
      const remaining =
        INSIGHTS_EVENT_MAX_BYTES -
        getCanonicalInsightsJsonByteLength(candidate);
      if (remaining >= 0 && remaining <= 1_024) {
        providerExtension[providerExtension.length - 1] = "x".repeat(remaining);
        boundary = candidate;
      }
    }
    if (boundary === null) throw new Error("20 KiB event was not constructed");
    expect(getCanonicalInsightsJsonByteLength(boundary)).toBe(
      INSIGHTS_EVENT_MAX_BYTES,
    );
    await insights.append(boundary);
  }

  const query = { kind: "activeOverview" as const, window: "24h" as const };
  await expect(insights.getReport({ query })).resolves.toMatchObject({
    state: "preparing",
  });
  const maintenance = createD1InsightsMaintenance(measured);
  let published = false;
  for (let step = 0; step < 100 && !published; step += 1) {
    const result = await maintenance.runStep({
      maxItems: 4_096,
      maxRequests: 128,
    });
    expect(result.state).not.toBe("failed");
    published = result.state === "published";
  }
  expect(published).toBe(true);
  await expect(insights.getReport({ query })).resolves.toMatchObject({
    state: "ready",
    data: { summary: { activeInstallations: 24 } },
  });
  expect(maximumBindBytes).toBe(790_705);
  expect(maximumBindBytes).toBeLessThanOrEqual(2_000_000);
});

it("hydrates 33 installations with 30 exact-20 KiB buckets in bounded steps", async () => {
  const insights = createD1RequiredInsightsModel(executor, "d1-jobs");
  const query = { kind: "activeOverview" as const, window: "30d" as const };
  const preparing = await insights.getReport({ query });
  if (preparing.state !== "preparing") throw new Error("report was not queued");
  const stored = await env.DB.prepare(
    `SELECT as_of_ms FROM private_hot_updater_insights_jobs WHERE id = ?`,
  )
    .bind(preparing.job.id)
    .first<{ as_of_ms: number }>();
  if (stored === null) throw new Error("report job was not stored");
  const day = 24 * 3_600_000;
  const firstBucketMs = stored.as_of_ms - 30 * day;
  const seeded: {
    installKey: string;
    bucketIndex: number;
    installId: string;
    eventId: string;
    receivedAtMs: number;
    rowBytes: number;
    eventJson: string;
  }[] = [];
  for (let install = 0; install < 33; install += 1) {
    const installId = `wide-install-${install}`;
    const installKey = await d1InsightsInstallKey(installId);
    let latest: (typeof seeded)[number] | null = null;
    for (let bucketIndex = 0; bucketIndex < 30; bucketIndex += 1) {
      const base = {
        ...createBundleEventRowFixture(
          String(300_000 + install * 30 + bucketIndex),
          firstBucketMs + bucketIndex * day + 1,
        ),
        type: "UNCHANGED" as const,
        install_id: installId,
        from_bundle_id: null,
        from_release_id: null,
        to_bundle_id: `wide-bundle-${bucketIndex}`,
        update_strategy: null,
      };
      let event: (typeof base & { provider_extension: string[] }) | null = null;
      for (let full = 0; full < 32 && event === null; full += 1) {
        const providerExtension = [
          ...Array.from({ length: full }, () => "x".repeat(1_024)),
          "",
        ];
        const candidate = { ...base, provider_extension: providerExtension };
        const remaining =
          INSIGHTS_EVENT_MAX_BYTES -
          getCanonicalInsightsJsonByteLength(candidate);
        if (remaining >= 0 && remaining <= 1_024) {
          providerExtension[providerExtension.length - 1] = "x".repeat(
            remaining,
          );
          event = candidate;
        }
      }
      if (event === null) throw new Error("20 KiB event was not constructed");
      expect(getCanonicalInsightsJsonByteLength(event)).toBe(
        INSIGHTS_EVENT_MAX_BYTES,
      );
      latest = {
        installKey,
        bucketIndex,
        installId,
        eventId: event.id,
        receivedAtMs: event.received_at_ms,
        rowBytes: INSIGHTS_EVENT_MAX_BYTES,
        eventJson: canonicalInsightsJson(event),
      };
      seeded.push(latest);
    }
    if (latest === null) throw new Error("latest event missing");
    seeded.push({ ...latest, bucketIndex: -1 });
  }
  for (let offset = 0; offset < seeded.length; offset += 20) {
    const rows = seeded.slice(offset, offset + 20);
    await env.DB.prepare(
      `INSERT INTO private_hot_updater_insights_job_latest (
        job_id, install_key, bucket_index, install_id, event_id,
        received_at_ms, row_bytes, event_json
      ) SELECT ?,
        json_extract(value, '$.installKey'),
        json_extract(value, '$.bucketIndex'),
        json_extract(value, '$.installId'),
        json_extract(value, '$.eventId'),
        json_extract(value, '$.receivedAtMs'),
        json_extract(value, '$.rowBytes'),
        json_extract(value, '$.eventJson')
      FROM json_each(?)`,
    )
      .bind(preparing.job.id, JSON.stringify(rows))
      .run();
  }
  await env.DB.prepare(
    `UPDATE private_hot_updater_insights_jobs
    SET checkpoint_json = '{"afterInstallKey":null,"phase":"installations"}',
      claimable_at_ms = 0
    WHERE id = ?`,
  )
    .bind(preparing.job.id)
    .run();

  let maximumQueryResultBytes = 0;
  let maximumBindBytes = 0;
  const measureParams = (params: readonly string[]) => {
    for (const param of params) {
      maximumBindBytes = Math.max(
        maximumBindBytes,
        new TextEncoder().encode(param).byteLength,
      );
    }
  };
  const measured: D1Executor = {
    async query(sql, params) {
      measureParams(params);
      const result = await executor.query(sql, params);
      maximumQueryResultBytes = Math.max(
        maximumQueryResultBytes,
        getCanonicalInsightsJsonByteLength(result),
      );
      return result;
    },
    async batch(statements) {
      for (const statement of statements) measureParams(statement.params);
      const result = await executor.batch(statements);
      maximumQueryResultBytes = Math.max(
        maximumQueryResultBytes,
        getCanonicalInsightsJsonByteLength(result),
      );
      return result;
    },
  };
  const maintenance = createD1InsightsMaintenance(measured);
  let processed = 0;
  for (let step = 0; step < 100; step += 1) {
    const checkpoint = await env.DB.prepare(
      `SELECT checkpoint_json FROM private_hot_updater_insights_jobs
      WHERE id = ?`,
    )
      .bind(preparing.job.id)
      .first<string>("checkpoint_json");
    if (!checkpoint?.includes('"phase":"installations"')) break;
    const result = await maintenance.runStep({
      maxItems: 4_096,
      maxRequests: 50,
    });
    expect(result.state).toBe("progress");
    expect(result.requests).toBeLessThanOrEqual(50);
    processed += result.processed;
  }
  expect(processed).toBe(33);
  expect(maximumQueryResultBytes).toBeLessThanOrEqual(
    INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
  );
  expect(maximumBindBytes).toBeLessThanOrEqual(
    INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
  );
  await expect(
    env.DB.prepare(
      `SELECT status, failure_code,
        (SELECT count(*) FROM private_hot_updater_insights_job_memberships
          WHERE job_id = job.id AND section = 'activeSeries') AS series_rows
      FROM private_hot_updater_insights_jobs AS job WHERE id = ?`,
    )
      .bind(preparing.job.id)
      .first(),
  ).resolves.toEqual({
    status: "queued",
    failure_code: null,
    series_rows: 990,
  });
  await runToPublication(200);
  await expect(insights.getReport({ query })).resolves.toMatchObject({
    state: "ready",
    data: { summary: { activeInstallations: 33 } },
  });
}, 30_000);

it("fences a stolen lease and reconciles a committed checkpoint after response loss", async () => {
  const insights = createD1RequiredInsightsModel(executor, "d1-jobs");
  await insights.append({
    ...createBundleEventRowFixture("981", 100),
    install_id: "lease-install",
    username: "lease-match",
  });
  const input = {
    kind: "contains" as const,
    query: "lease-match",
    limit: 100,
  };
  const reserved = await insights.pageInstallations(input);
  if (reserved.state !== "preparing")
    throw new Error("search was not reserved");

  let stolen = false;
  const fenced: D1Executor = {
    query: executor.query,
    async batch(statements) {
      if (!stolen && statements[0]?.sql.includes("lease_guard")) {
        stolen = true;
        await env.DB.prepare(
          `UPDATE private_hot_updater_insights_jobs
          SET lease_epoch = lease_epoch + 1, lease_until_ms = 0
          WHERE id = ?`,
        )
          .bind(reserved.job.id)
          .run();
      }
      return executor.batch(statements);
    },
  };
  await expect(
    createD1InsightsMaintenance(fenced).runStep({
      maxItems: 4096,
      maxRequests: 50,
    }),
  ).resolves.toMatchObject({ state: "lease-lost", processed: 0 });
  await expect(
    env.DB.prepare(
      `SELECT checkpoint_json,
        (SELECT count(*) FROM private_hot_updater_insights_job_latest
          WHERE job_id = job.id) AS latest_rows
      FROM private_hot_updater_insights_jobs AS job WHERE id = ?`,
    )
      .bind(reserved.job.id)
      .first(),
  ).resolves.toEqual({
    checkpoint_json: '{"afterAliasId":0,"phase":"aliases"}',
    latest_rows: 0,
  });

  let lostResponse = false;
  const uncertain: D1Executor = {
    query: executor.query,
    async batch(statements) {
      const result = await executor.batch(statements);
      if (
        !lostResponse &&
        statements.some(({ sql }) => sql.includes("checkpoint_json"))
      ) {
        lostResponse = true;
        throw new Error("simulated response loss after checkpoint commit");
      }
      return result;
    },
  };
  await expect(
    createD1InsightsMaintenance(uncertain).runStep({
      maxItems: 4096,
      maxRequests: 50,
    }),
  ).resolves.toMatchObject({ state: "progress", processed: 1 });
  await expect(
    env.DB.prepare(
      `SELECT checkpoint_json,
        (SELECT count(*) FROM private_hot_updater_insights_job_latest
          WHERE job_id = job.id) AS latest_rows
      FROM private_hot_updater_insights_jobs AS job WHERE id = ?`,
    )
      .bind(reserved.job.id)
      .first(),
  ).resolves.toEqual({
    checkpoint_json: '{"afterInstallKey":null,"phase":"searchLatest"}',
    latest_rows: 0,
  });
  await runToPublication();
  await expect(insights.pageInstallations(input)).resolves.toMatchObject({
    state: "ready",
    data: { total: { state: "exact", value: 1 } },
  });
});

it("rolls back a failed publication swap and retains the prior immutable head", async () => {
  const insights = createD1RequiredInsightsModel(executor, "d1-jobs");
  await insights.append({
    ...createBundleEventRowFixture("982", 100),
    install_id: "atomic-install",
    username: "atomic-match",
  });
  const input = {
    kind: "contains" as const,
    query: "atomic-match",
    limit: 100,
  };
  await insights.pageInstallations(input);
  await runToPublication();
  const ready = await insights.pageInstallations(input);
  if (ready.state !== "ready")
    throw new Error("initial publication was not ready");
  const priorId = ready.data.consistency.cutoff.publication.id;
  await env.DB.prepare(
    `UPDATE private_hot_updater_insights_jobs
    SET as_of_ms = 0,
      publication_json = json_set(publication_json, '$.asOfMs', 0)
    WHERE id = ?`,
  )
    .bind(priorId)
    .run();
  const stale = await insights.pageInstallations({ ...input, minAsOfMs: 1 });
  if (stale.state !== "stale") throw new Error("refresh was not reserved");
  const refreshId = stale.refresh.id;
  const maintenance = createD1InsightsMaintenance(executor);
  for (;;) {
    const checkpoint = await env.DB.prepare(
      "SELECT checkpoint_json FROM private_hot_updater_insights_jobs WHERE id = ?",
    )
      .bind(refreshId)
      .first<string>("checkpoint_json");
    if (checkpoint === '{"phase":"complete"}') break;
    await expect(
      maintenance.runStep({ maxItems: 4096, maxRequests: 50 }),
    ).resolves.toMatchObject({ state: "progress" });
  }

  let rejectedSwap = false;
  const failing: D1Executor = {
    query: executor.query,
    async batch(statements) {
      if (
        !rejectedSwap &&
        statements.some(({ sql }) =>
          sql.includes("HOT_UPDATER_INSIGHTS_PUBLICATION_NOT_ATOMIC"),
        )
      ) {
        rejectedSwap = true;
        return executor.batch([
          ...statements.slice(0, -1),
          {
            sql: "SELECT json_extract('ROLLBACK_PUBLICATION', '$') AS revision",
            params: [],
          },
        ]);
      }
      return executor.batch(statements);
    },
  };
  await expect(
    createD1InsightsMaintenance(failing).runStep({
      maxItems: 4096,
      maxRequests: 50,
    }),
  ).resolves.toMatchObject({ state: "failed", jobId: refreshId });
  await expect(
    env.DB.prepare(
      `SELECT publication_job_id, active_job_id,
        (SELECT status FROM private_hot_updater_insights_jobs
          WHERE id = active_job_id) AS active_status
      FROM private_hot_updater_insights_job_heads LIMIT 1`,
    ).first(),
  ).resolves.toEqual({
    publication_job_id: priorId,
    active_job_id: refreshId,
    active_status: "failed",
  });
  await expect(
    env.DB.prepare(
      "SELECT status FROM private_hot_updater_insights_jobs WHERE id = ?",
    )
      .bind(refreshId)
      .first<string>("status"),
  ).resolves.toBe("failed");
});

it("publishes an empty bundle summary without reading the source", async () => {
  const measured = { sourceReads: 0 };
  const guarded: D1Executor = {
    async query(sql, params) {
      if (
        /FROM private_hot_updater_insights_source_events AS source/i.test(sql)
      ) {
        measured.sourceReads += 1;
      }
      return executor.query(sql, params);
    },
    batch: executor.batch,
  };
  const insights = createD1RequiredInsightsModel(guarded, "d1-jobs");
  const query = {
    kind: "bundleSummaries" as const,
    bundleIds: [],
    window: "all" as const,
  };
  const preparing = await insights.getReport({ query });
  expect(preparing).toMatchObject({ state: "preparing" });
  const result = await createD1InsightsMaintenance(guarded).runStep({
    maxItems: 256,
    maxRequests: 50,
  });
  expect(result.state).toBe("published");
  expect(measured.sourceReads).toBe(0);
  await expect(insights.getReport({ query })).resolves.toMatchObject({
    state: "ready",
    data: { kind: "bundleSummaries", summary: [] },
  });
});

it("fails and rolls back a cross-count install digest collision", async () => {
  const insights = createD1RequiredInsightsModel(executor, "d1-jobs");
  const event = {
    ...createBundleEventRowFixture("1199", 100),
    install_id: "collision-source",
    to_bundle_id: "bundle-collision",
  };
  await insights.append(event);
  const query = {
    kind: "bundleSummaries" as const,
    bundleIds: ["bundle-collision"],
    window: "all" as const,
  };
  const preparing = await insights.getReport({ query });
  if (preparing.state !== "preparing") throw new Error("report was not queued");
  const installKey = await d1InsightsInstallKey(event.install_id);
  await env.DB.prepare(
    `INSERT INTO private_hot_updater_insights_job_memberships (
      job_id, count_key, install_key, install_id, section, metric, label,
      bucket_start_ms
    ) VALUES (?, ?, ?, ?, 'summary', 'installed', 'other-bundle', -1)`,
  )
    .bind(
      preparing.job.id,
      '["summary","installed","other-bundle",-1]',
      installKey,
      "different-full-install-id",
    )
    .run();
  const result = await createD1InsightsMaintenance(executor).runStep({
    maxItems: 256,
    maxRequests: 50,
  });
  expect(result).toMatchObject({ state: "failed", jobId: preparing.job.id });
  await expect(
    env.DB.prepare(
      `SELECT status, publication_json FROM private_hot_updater_insights_jobs
      WHERE id = ?`,
    )
      .bind(preparing.job.id)
      .first(),
  ).resolves.toEqual({ status: "failed", publication_json: null });
  await expect(
    env.DB.prepare(
      `SELECT count(*) AS count
      FROM private_hot_updater_insights_job_memberships WHERE job_id = ?`,
    )
      .bind(preparing.job.id)
      .first<number>("count"),
  ).resolves.toBe(1);
});

it("proves a 50,001-member search uses bounded native seeks without a temp sort", async () => {
  const insights = createD1RequiredInsightsModel(executor, "d1-jobs");
  await env.DB.prepare(`
      WITH RECURSIVE source(n) AS (
        VALUES (1) UNION ALL SELECT n + 1 FROM source WHERE n < 100002
      ), rows AS (
        SELECT
          n,
          ((n - 1) % 50001) + 1 AS install_number,
          printf('00000000-0000-7000-8000-%012d', n) AS id
        FROM source
      ), saved AS (
        SELECT *, 'install-' || install_number AS install_id,
          json_object(
            'app_version', '1.0.0', 'channel', 'production', 'cohort', '0',
            'fingerprint_hash', NULL, 'from_bundle_id', 'from-bundle',
            'from_release_id', NULL, 'id', id,
            'install_id', 'install-' || install_number,
            'platform', 'ios', 'received_at_ms', n, 'sdk_version', NULL,
            'to_bundle_id', 'bundle-a', 'to_release_id', NULL,
            'type', 'UPDATE_APPLIED', 'update_strategy', 'appVersion',
            'user_id', NULL, 'username', NULL
          ) AS event_json
        FROM rows
      )
      INSERT INTO bundle_events (
        id, type, install_id, user_id, username, from_bundle_id,
        from_release_id, to_bundle_id, to_release_id, platform,
        app_version, channel, cohort, update_strategy, fingerprint_hash,
        sdk_version, received_at_ms, insights_write_version,
        insights_install_key, insights_row_bytes, insights_event_json,
        insights_aliases_json
      )
      SELECT
        id, 'UPDATE_APPLIED', install_id, NULL, NULL, 'from-bundle',
        NULL, 'bundle-a', NULL, 'ios', '1.0.0', 'production', '0',
        'appVersion', NULL, NULL, n, 2, printf('%064x', install_number),
        length(CAST(event_json AS BLOB)), event_json,
        json_array(json_object(
          'folded', install_id, 'kind', 'installId', 'value', install_id
        ))
      FROM saved
    `).run();

  const identities = await Promise.all(
    Array.from({ length: 50_001 }, async (_, index) => {
      const ordinal = index + 1;
      return {
        aliasId: ordinal,
        installId: `install-${ordinal}`,
        installKey: await d1InsightsInstallKey(`install-${ordinal}`),
        eventId: `00000000-0000-7000-8000-${String(ordinal + 50_001).padStart(12, "0")}`,
      };
    }),
  );
  await env.DB.prepare(`
    DELETE FROM private_hot_updater_insights_installation_versions;
    DELETE FROM private_hot_updater_insights_installation_aliases;
    DELETE FROM private_hot_updater_insights_live_installations;
  `).run();
  for (let offset = 0; offset < identities.length; offset += 2_500) {
    const payload = JSON.stringify(identities.slice(offset, offset + 2_500));
    await env.DB.batch([
      env.DB.prepare(`UPDATE bundle_events SET insights_install_key = (
          SELECT json_extract(value, '$.installKey') FROM json_each(?)
          WHERE json_extract(value, '$.installId') = bundle_events.install_id
        ) WHERE install_id IN (
          SELECT json_extract(value, '$.installId') FROM json_each(?)
        )`).bind(payload, payload),
      env.DB.prepare(`INSERT INTO private_hot_updater_insights_installation_aliases (
          alias_id, install_key, install_id, alias_kind, alias_value,
          folded_value, first_generation
        ) SELECT json_extract(value, '$.aliasId'),
          json_extract(value, '$.installKey'),
          json_extract(value, '$.installId'), 'installId',
          json_extract(value, '$.installId'),
          json_extract(value, '$.installId'),
          json_extract(value, '$.aliasId') FROM json_each(?)`).bind(payload),
      env.DB.prepare(`INSERT INTO private_hot_updater_insights_live_installations (
          install_key, install_id, event_id, received_at_ms, row_bytes
        ) SELECT json_extract(value, '$.installKey'),
          json_extract(value, '$.installId'), raw.id, raw.received_at_ms,
          raw.insights_row_bytes FROM json_each(?) AS saved
        JOIN bundle_events AS raw
          ON raw.id = json_extract(saved.value, '$.eventId')`).bind(payload),
      env.DB.prepare(`INSERT INTO private_hot_updater_insights_installation_versions (
          install_key, generation, install_id, event_id, received_at_ms,
          row_bytes
        ) SELECT live.install_key, source.generation, live.install_id,
          live.event_id, live.received_at_ms, live.row_bytes
        FROM json_each(?) AS saved
        JOIN private_hot_updater_insights_live_installations AS live
          ON live.install_key = json_extract(saved.value, '$.installKey')
        CROSS JOIN private_hot_updater_insights_source_state AS source
        WHERE source.id = 1`).bind(payload),
    ]);
  }
  await expect(
    env.DB.prepare(`SELECT
      (SELECT count(*) FROM private_hot_updater_insights_source_events)
        AS source_rows,
      (SELECT count(*) FROM private_hot_updater_insights_installation_aliases)
        AS alias_rows,
      (SELECT count(*) FROM private_hot_updater_insights_installation_versions)
        AS version_rows`).first(),
  ).resolves.toEqual({
    source_rows: 100_002,
    alias_rows: 50_001,
    version_rows: 50_001,
  });

  const aliasPlan = await env.DB.prepare(`
      EXPLAIN QUERY PLAN
      SELECT alias_id, install_key
      FROM private_hot_updater_insights_installation_aliases
      WHERE alias_id > 0 AND alias_id <= 50001
        AND instr(folded_value, 'install-') > 0
      ORDER BY alias_id ASC LIMIT 101
    `).all<{ detail: string }>();
  const aliasDetails = aliasPlan.results.map(({ detail }) => detail).join("\n");
  expect(aliasDetails).toMatch(
    /SEARCH .*installation_aliases USING INTEGER PRIMARY KEY/,
  );
  expect(aliasDetails).not.toMatch(/SCAN |USE TEMP B-TREE/);
  const aliasCandidates = await env.DB.prepare(`
      SELECT alias_id, install_key
      FROM private_hot_updater_insights_installation_aliases
      WHERE alias_id > 0 AND alias_id <= 50001
        AND instr(folded_value, 'install-') > 0
      ORDER BY alias_id ASC LIMIT 101
    `).all();
  expect(aliasCandidates.results).toHaveLength(101);
  expect(
    (aliasCandidates.meta as { rows_read: number }).rows_read,
  ).toBeLessThanOrEqual(202);

  const first = await insights.pageInstallations({
    kind: "contains",
    query: "install-",
    limit: 100,
  });
  expect(first.state).toBe("preparing");
  const claimPlan = await env.DB.prepare(`
      EXPLAIN QUERY PLAN
      SELECT job.id
      FROM private_hot_updater_insights_jobs AS job
        INDEXED BY private_hot_updater_insights_job_claim_idx
      JOIN private_hot_updater_insights_job_heads AS head
        ON head.active_job_id = job.id
      WHERE job.status = 'queued' AND job.claimable_at_ms <= 0
      ORDER BY job.claimable_at_ms ASC, job.id COLLATE BINARY ASC LIMIT 1
    `).all<{ detail: string }>();
  const claimDetails = claimPlan.results.map(({ detail }) => detail).join("\n");
  expect(claimDetails).toMatch(/SEARCH job USING .*job_claim_idx/);
  expect(claimDetails).not.toMatch(/SCAN |USE TEMP B-TREE/);
  const leasePlan = await env.DB.prepare(`
      EXPLAIN QUERY PLAN
      SELECT job.id
      FROM private_hot_updater_insights_jobs AS job
        INDEXED BY private_hot_updater_insights_job_lease_idx
      JOIN private_hot_updater_insights_job_heads AS head
        ON head.active_job_id = job.id
      WHERE job.status = 'preparing' AND job.lease_until_ms <= 0
      ORDER BY job.lease_until_ms ASC, job.id COLLATE BINARY ASC LIMIT 1
    `).all<{ detail: string }>();
  const leaseDetails = leasePlan.results.map(({ detail }) => detail).join("\n");
  expect(leaseDetails).toMatch(/SEARCH job USING .*job_lease_idx/);
  expect(leaseDetails).not.toMatch(/SCAN |USE TEMP B-TREE/);
  await runToPublication(1_100);

  const page = await insights.pageInstallations({
    kind: "contains",
    query: "install-",
    limit: 100,
  });
  expect(page).toMatchObject({
    state: "ready",
    data: {
      data: expect.any(Array),
      total: { state: "exact", value: 50001 },
      hasNext: true,
    },
  });
  if (page.state !== "ready") throw new Error("large search was not ready");
  expect(page.data.data).toHaveLength(100);
  const cursor = page.data.nextCursor!;
  const parsedCursor = JSON.parse(cursor) as unknown[];
  parsedCursor[3] = '[2,"different-source",1]';
  await expect(
    insights.pageInstallations({
      kind: "contains",
      query: "install-",
      limit: 100,
      cursor: JSON.stringify(parsedCursor),
    }),
  ).rejects.toThrow();
  await expect(
    insights.pageInstallations({
      kind: "contains",
      query: "user-",
      limit: 100,
      cursor,
    }),
  ).rejects.toThrow();
  const next = await insights.pageInstallations({
    kind: "contains",
    query: "install-",
    limit: 100,
    cursor,
  });
  expect(next).toMatchObject({
    state: "ready",
    data: { data: expect.any(Array) },
  });
  if (next.state !== "ready") throw new Error("next page was not ready");
  expect(
    new Set([
      ...page.data.data.map(({ install_id }) => install_id),
      ...next.data.data.map(({ install_id }) => install_id),
    ]).size,
  ).toBe(200);

  const publicationId = page.data.consistency.cutoff.publication.id;
  const plan = await env.DB.prepare(`
      EXPLAIN QUERY PLAN
      SELECT membership.install_key
      FROM private_hot_updater_insights_job_memberships AS membership
      JOIN private_hot_updater_insights_job_latest AS latest
        ON latest.job_id = membership.job_id
        AND latest.install_key = membership.install_key
        AND latest.bucket_index = -1
      WHERE membership.job_id = ?
        AND membership.count_key = '["search","","",-1]'
        AND membership.install_key > ?
      ORDER BY membership.install_key COLLATE BINARY ASC LIMIT 101
    `)
    .bind(publicationId, "0".repeat(64))
    .all<{ detail: string }>();
  const details = plan.results.map(({ detail }) => detail).join("\n");
  expect(details).toMatch(/SEARCH membership USING.*install_key>/);
  expect(details).toMatch(
    /SEARCH latest USING.*job_id=.*install_key=.*bucket_index=/,
  );
  expect(details).not.toMatch(/SCAN |USE TEMP B-TREE/);

  const measured = await env.DB.prepare(`
      SELECT membership.install_key
      FROM private_hot_updater_insights_job_memberships AS membership
      JOIN private_hot_updater_insights_job_latest AS latest
        ON latest.job_id = membership.job_id
        AND latest.install_key = membership.install_key
        AND latest.bucket_index = -1
      WHERE membership.job_id = ?
        AND membership.count_key = '["search","","",-1]'
        AND membership.install_key > ?
      ORDER BY membership.install_key COLLATE BINARY ASC LIMIT 101
    `)
    .bind(publicationId, "0".repeat(64))
    .all();
  expect(measured.results).toHaveLength(101);
  expect(
    (measured.meta as { rows_read: number }).rows_read,
  ).toBeLessThanOrEqual(202);

  const latestPlan = await env.DB.prepare(`
      EXPLAIN QUERY PLAN
      SELECT membership.install_key, version.event_id
      FROM private_hot_updater_insights_job_memberships AS membership
      JOIN private_hot_updater_insights_installation_versions AS version
        ON version.install_key = membership.install_key
        AND version.generation = (
          SELECT max(candidate.generation)
          FROM private_hot_updater_insights_installation_versions AS candidate
          WHERE candidate.install_key = membership.install_key
            AND candidate.generation <= 100002
        )
      WHERE membership.job_id = ?
        AND membership.count_key = '["search","","",-1]'
        AND membership.install_key > ?
      ORDER BY membership.install_key COLLATE BINARY ASC LIMIT 101
    `)
    .bind(publicationId, "0".repeat(64))
    .all<{ detail: string }>();
  const latestDetails = latestPlan.results
    .map(({ detail }) => detail)
    .join("\n");
  expect(latestDetails).toMatch(/SEARCH membership USING/);
  expect(latestDetails).toMatch(/SEARCH candidate USING COVERING INDEX/);
  expect(latestDetails).not.toMatch(/SCAN |USE TEMP B-TREE/);
  const latestCandidates = await env.DB.prepare(`
      SELECT membership.install_key, version.event_id
      FROM private_hot_updater_insights_job_memberships AS membership
      JOIN private_hot_updater_insights_installation_versions AS version
        ON version.install_key = membership.install_key
        AND version.generation = (
          SELECT max(candidate.generation)
          FROM private_hot_updater_insights_installation_versions AS candidate
          WHERE candidate.install_key = membership.install_key
            AND candidate.generation <= 100002
        )
      WHERE membership.job_id = ?
        AND membership.count_key = '["search","","",-1]'
        AND membership.install_key > ?
      ORDER BY membership.install_key COLLATE BINARY ASC LIMIT 101
    `)
    .bind(publicationId, "0".repeat(64))
    .all();
  expect(latestCandidates.results).toHaveLength(101);
  expect(
    (latestCandidates.meta as { rows_read: number }).rows_read,
  ).toBeLessThanOrEqual(505);
}, 600_000);
