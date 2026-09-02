import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  createUUIDv7,
  type BundleEventRow,
  type InsightsProjectedReadVersions,
  type InsightsReadVersions,
  type InsightsReservedReadVersions,
  type InsightsReportInput,
  type InsightsReportPage,
  type InsightsReportPageInput,
  type InsightsReportPublication,
  type InsightsReportQuery,
  type InsightsReportResult,
} from "@hot-updater/plugin-core";
import {
  assertInsightsPageContract,
  assertInsightsQueryContract,
  createInsightsReportPageCursor,
  createInsightsReportProjection,
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
  readInsightsReportPageQuery,
  readInsightsReportQuery,
} from "@hot-updater/plugin-core/internal";
import { sql, type SQL } from "drizzle-orm";

import type { DrizzleProvider } from "../../drizzle";
import {
  mutateDrizzleInsights,
  queryDrizzleInsights,
  transactDrizzleInsights,
  type DrizzleDB,
} from "../../drizzleLazyDB";
import {
  DRIZZLE_INSIGHTS_EVENTS,
  DRIZZLE_INSIGHTS_JOBS,
  DRIZZLE_INSIGHTS_REPORT_DISTINCT,
  DRIZZLE_INSIGHTS_REPORT_LATEST,
  DRIZZLE_INSIGHTS_REPORT_OUTPUT,
} from "./schema";
import {
  createDrizzleInsightsSource,
  lockDrizzleInsightsSourceFence,
} from "./source";
import {
  assertDrizzleInsightsStoredInstallation,
  drizzleInsightsEventOrderKey,
  drizzleInsightsInstallKey,
  drizzleInsightsSemanticKey,
  getDrizzleInsightsEventBytes,
  readDrizzleInsightsEvent,
  readDrizzleInsightsStoredEvent,
} from "./storage";

const JOB_ROWS = 200;

const corruptVersions = (provider: DrizzleProvider): InsightsReadVersions => ({
  schemaVersion: "insights-v1",
  storageVersion: `drizzle-${provider}-v1`,
  projectionGeneration: null,
  sourceGeneration: null,
});

type ReportJob = {
  readonly jobId: string;
  readonly semanticKey: string;
  readonly query: InsightsReportQuery;
  readonly sourceId: string;
  readonly sourceMaxSeq: number;
  readonly cursorSeq: number;
  readonly phase: "source" | "filter" | "publish";
  readonly phaseSection: string;
  readonly phaseKey: string;
  readonly status: "queued" | "preparing" | "ready" | "failed";
  readonly asOfMs: number;
  readonly completedAtMs: number | null;
  readonly error: string | null;
};

type ReportAdvance = {
  readonly job: ReportJob;
  readonly items: number;
  readonly bytes: number;
};

type StagedReportPage =
  | {
      readonly section: "movementSeries";
      readonly metric: "installed" | "recovered";
      readonly rows: readonly { bucketStartMs: number; value: number }[];
      readonly nextCursor: string | null;
      readonly total: number;
    }
  | {
      readonly section: "movementCohorts";
      readonly metric: "installed" | "recovered";
      readonly rows: readonly { cohort: string; value: number }[];
      readonly nextCursor: string | null;
      readonly total: number;
    }
  | {
      readonly section: "bundleDistribution";
      readonly rows: readonly {
        bundleId: string;
        installations: number;
      }[];
      readonly nextCursor: string | null;
      readonly total: number;
    }
  | {
      readonly section: "activeSeries";
      readonly rows: readonly { bucketStartMs: number; value: number }[];
      readonly nextCursor: string | null;
      readonly total: number;
    }
  | {
      readonly section: "activeBundleSeries";
      readonly rows: readonly {
        bundleId: string;
        bucketStartMs: number;
        value: number;
      }[];
      readonly nextCursor: string | null;
      readonly total: number;
    };

const invalid = (): never => {
  throw new DatabasePluginInputError("invalid-query");
};
const invalidResult = (): never => {
  throw new DatabasePluginInputError("invalid-result");
};
const integer = (value: unknown, nullable = false): number | null => {
  if (nullable && value === null) return null;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0)
    return invalidResult();
  return parsed;
};
const text = (value: unknown): string =>
  typeof value === "string" ? value : invalidResult();

const outputLabel = (value: unknown, key: "bundleId" | "cohort"): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text(value));
  } catch {
    return invalidResult();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof Reflect.get(parsed, key) !== "string"
  ) {
    return invalidResult();
  }
  return Reflect.get(parsed, key);
};

const readJob = (row: Record<string, unknown>): ReportJob => {
  const status = row["status"];
  const phase = row["phase"];
  if (
    status !== "queued" &&
    status !== "preparing" &&
    status !== "ready" &&
    status !== "failed"
  ) {
    return invalidResult();
  }
  if (phase !== "source" && phase !== "filter" && phase !== "publish")
    return invalidResult();
  let canonical: InsightsReportQuery;
  try {
    const query: unknown = JSON.parse(text(row["query_json"]));
    canonical = readInsightsReportQuery({
      query: query as InsightsReportQuery,
    }).query;
  } catch {
    return invalidResult();
  }
  return {
    jobId: text(row["job_id"]),
    semanticKey: text(row["semantic_key"]),
    query: canonical,
    sourceId: text(row["source_id"]),
    sourceMaxSeq: integer(row["source_max_seq"])!,
    cursorSeq: integer(row["cursor_seq"])!,
    phase,
    phaseSection: text(row["phase_section"]),
    phaseKey: text(row["phase_key"]),
    status,
    asOfMs: integer(row["as_of_ms"])!,
    completedAtMs: integer(row["completed_at_ms"], true),
    error: row["error"] === null ? null : text(row["error"]),
  };
};

const sourceGeneration = (job: ReportJob): string =>
  JSON.stringify([1, job.sourceId, job.sourceMaxSeq]);
const versions = (
  provider: DrizzleProvider,
  job: ReportJob,
): InsightsProjectedReadVersions => ({
  schemaVersion: "insights-v1",
  storageVersion: `drizzle-${provider}-v1`,
  projectionGeneration: job.jobId,
  sourceGeneration: sourceGeneration(job),
});

const failureCode = (job: ReportJob) =>
  job.error === "migration-poison"
    ? ("migration-poison" as const)
    : ("preparation-failed" as const);

/** Big-endian UTF-16 code units preserve ECMAScript string comparison. */
const jsOrderKey = (value: string): Uint8Array => {
  const result = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    result[index * 2] = unit >>> 8;
    result[index * 2 + 1] = unit & 0xff;
  }
  return result;
};

const binary = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return invalidResult();
};

const outputMutation = (
  provider: DrizzleProvider,
  input: {
    readonly jobId: string;
    readonly section: string;
    readonly rowKey: string;
    readonly sortNumber?: number;
    readonly sortText?: Uint8Array;
    readonly row: unknown;
    readonly delta: 1 | -1;
  },
): SQL => {
  const base = sql`insert into ${sql.identifier(DRIZZLE_INSIGHTS_REPORT_OUTPUT)}
    (job_id,section_key,row_key,sort_number,sort_text,row_json,value)
    values (${input.jobId},${input.section},${input.rowKey},
      ${input.sortNumber ?? 0},${input.sortText ?? new Uint8Array()},
      ${JSON.stringify(input.row)},${input.delta})`;
  if (provider === "mysql") {
    return sql`${base} on duplicate key update value=value+values(value),
      row_json=values(row_json),sort_number=values(sort_number),
      sort_text=values(sort_text)`;
  }
  return sql`${base} on conflict(job_id,section_key,row_key) do update set
    value=${sql.identifier(DRIZZLE_INSIGHTS_REPORT_OUTPUT)}.value+excluded.value,
    row_json=excluded.row_json,sort_number=excluded.sort_number,
    sort_text=excluded.sort_text`;
};

const outputValue = async (
  db: DrizzleDB,
  jobId: string,
  section: string,
  rowKey: string,
): Promise<number> => {
  const rows = await queryDrizzleInsights<{ value: unknown }>(
    db,
    sql`select value from ${sql.identifier(DRIZZLE_INSIGHTS_REPORT_OUTPUT)}
      where job_id=${jobId} and section_key=${section} and row_key=${rowKey}
      limit 1`,
  );
  return rows[0] === undefined ? 0 : integer(rows[0].value)!;
};

const incrementMeta = (
  db: DrizzleDB,
  provider: DrizzleProvider,
  jobId: string,
  rowKey: string,
  delta: 1 | -1,
) =>
  mutateDrizzleInsights(
    db,
    outputMutation(provider, {
      jobId,
      section: "meta",
      rowKey,
      row: { key: rowKey },
      delta,
    }),
  );

const insertDistinct = async (
  db: DrizzleDB,
  input: {
    readonly jobId: string;
    readonly section: string;
    readonly key1: string;
    readonly key2: string;
    readonly key3: string;
    readonly key3Digest?: string;
    readonly bucketMs: number;
    readonly identity: unknown;
  },
): Promise<boolean> => {
  const entryKey = drizzleInsightsSemanticKey(input.identity);
  const key2Digest = drizzleInsightsSemanticKey(["report-key2", input.key2]);
  const key3Digest =
    input.key3Digest ?? drizzleInsightsSemanticKey(["report-key3", input.key3]);
  const existing = await queryDrizzleInsights(
    db,
    sql`select entry_key from ${sql.identifier(DRIZZLE_INSIGHTS_REPORT_DISTINCT)}
      where job_id=${input.jobId} and section=${input.section}
        and entry_key=${entryKey} limit 1`,
  );
  if (existing.length > 0) return false;
  await mutateDrizzleInsights(
    db,
    sql`insert into ${sql.identifier(DRIZZLE_INSIGHTS_REPORT_DISTINCT)}
      (job_id,section,entry_key,key1,key2,key2_digest,key3,key3_digest,bucket_ms,
        received_at_ms,event_order_key)
      values (${input.jobId},${input.section},${entryKey},${input.key1},
        ${input.key2},${key2Digest},${input.key3},${key3Digest},${input.bucketMs},
        null,null)`,
  );
  return true;
};

const upsertLatest = async (
  db: DrizzleDB,
  provider: DrizzleProvider,
  job: ReportJob,
  event: BundleEventRow,
): Promise<void> => {
  const installKey = await drizzleInsightsInstallKey(event.install_id);
  const existing = await queryDrizzleInsights(
    db,
    sql`select * from ${sql.identifier(DRIZZLE_INSIGHTS_REPORT_LATEST)}
      where job_id=${job.jobId} and install_key=${installKey} limit 1`,
  );
  const prior = existing[0];
  let priorEvent: BundleEventRow | null = null;
  if (prior !== undefined) {
    if (prior["install_id"] !== event.install_id) return invalidResult();
    const priorTime = integer(prior["received_at_ms"])!;
    const priorKey = binary(prior["event_order_key"]);
    if (
      priorTime > event.received_at_ms ||
      (priorTime === event.received_at_ms &&
        Buffer.compare(priorKey, drizzleInsightsEventOrderKey(event.id)) >= 0)
    ) {
      return;
    }
    priorEvent = readDrizzleInsightsEvent(prior["raw_event"]);
  }
  const included = (candidate: BundleEventRow): boolean =>
    job.query.kind !== "activeOverview" ||
    job.query.userId === undefined ||
    candidate.user_id === job.query.userId;
  const priorIncluded = priorEvent !== null && included(priorEvent);
  const nextIncluded = included(event);
  if (priorIncluded !== nextIncluded) {
    await incrementMeta(
      db,
      provider,
      job.jobId,
      "summaryInstallations",
      nextIncluded ? 1 : -1,
    );
  }
  if (
    priorEvent !== null &&
    priorIncluded &&
    (!nextIncluded || priorEvent.to_bundle_id !== event.to_bundle_id)
  ) {
    const priorValue = await outputValue(
      db,
      job.jobId,
      "bundleDistribution",
      drizzleInsightsSemanticKey(priorEvent.to_bundle_id),
    );
    await mutateDrizzleInsights(
      db,
      outputMutation(provider, {
        jobId: job.jobId,
        section: "bundleDistribution",
        rowKey: drizzleInsightsSemanticKey(priorEvent.to_bundle_id),
        sortText: jsOrderKey(priorEvent.to_bundle_id),
        row: { bundleId: priorEvent.to_bundle_id },
        delta: -1,
      }),
    );
    if (priorValue === 1) {
      await incrementMeta(
        db,
        provider,
        job.jobId,
        "bundleDistributionTotal",
        -1,
      );
    }
  }
  const userKey =
    event.user_id === undefined
      ? null
      : drizzleInsightsSemanticKey(["user", event.user_id]);
  const insert = sql`insert into ${sql.identifier(DRIZZLE_INSIGHTS_REPORT_LATEST)}
    (job_id,install_key,install_id,event_id,event_order_key,received_at_ms,raw_event,user_id,user_key,to_bundle_id)
    values (${job.jobId},${installKey},${event.install_id},${event.id},
      ${drizzleInsightsEventOrderKey(event.id)},${event.received_at_ms},
      ${JSON.stringify(event)},${event.user_id},${userKey},
      ${event.to_bundle_id})`;
  await mutateDrizzleInsights(
    db,
    provider === "mysql"
      ? sql`${insert} on duplicate key update event_id=values(event_id),
          event_order_key=values(event_order_key),
          received_at_ms=values(received_at_ms),raw_event=values(raw_event),
          user_id=values(user_id),user_key=values(user_key),
          to_bundle_id=values(to_bundle_id)`
      : sql`${insert} on conflict(job_id,install_key) do update set
          event_id=excluded.event_id,event_order_key=excluded.event_order_key,
          received_at_ms=excluded.received_at_ms,
          raw_event=excluded.raw_event,user_id=excluded.user_id,
          user_key=excluded.user_key,
          to_bundle_id=excluded.to_bundle_id`,
  );
  if (
    nextIncluded &&
    (!priorIncluded || priorEvent?.to_bundle_id !== event.to_bundle_id)
  ) {
    const nextValue = await outputValue(
      db,
      job.jobId,
      "bundleDistribution",
      drizzleInsightsSemanticKey(event.to_bundle_id),
    );
    await mutateDrizzleInsights(
      db,
      outputMutation(provider, {
        jobId: job.jobId,
        section: "bundleDistribution",
        rowKey: drizzleInsightsSemanticKey(event.to_bundle_id),
        sortText: jsOrderKey(event.to_bundle_id),
        row: { bundleId: event.to_bundle_id },
        delta: 1,
      }),
    );
    if (nextValue === 0) {
      await incrementMeta(
        db,
        provider,
        job.jobId,
        "bundleDistributionTotal",
        1,
      );
    }
  }
};

const changeActiveBundle = async (
  db: DrizzleDB,
  provider: DrizzleProvider,
  jobId: string,
  bundleId: string,
  bucketMs: number,
  delta: 1 | -1,
): Promise<void> => {
  const bundleKey = drizzleInsightsSemanticKey(bundleId);
  const before = await outputValue(db, jobId, "activeBundleTotals", bundleKey);
  await mutateDrizzleInsights(
    db,
    outputMutation(provider, {
      jobId,
      section: `activeBundleSeries:${bundleKey}`,
      rowKey: String(bucketMs),
      sortNumber: bucketMs,
      row: { bundleId, bucketStartMs: bucketMs },
      delta,
    }),
  );
  await mutateDrizzleInsights(
    db,
    outputMutation(provider, {
      jobId,
      section: "activeBundleTotals",
      rowKey: bundleKey,
      sortText: jsOrderKey(bundleId),
      row: { bundleId },
      delta,
    }),
  );
  if ((delta === 1 && before === 0) || (delta === -1 && before === 1)) {
    await incrementMeta(db, provider, jobId, "activeBundleTotal", delta);
  }
};

const saveActiveBundle = async (
  db: DrizzleDB,
  provider: DrizzleProvider,
  jobId: string,
  event: BundleEventRow,
  bucketMs: number,
): Promise<void> => {
  const entryKey = drizzleInsightsSemanticKey([
    "activeBundleSeries",
    bucketMs,
    event.install_id,
  ]);
  const installKey = await drizzleInsightsInstallKey(event.install_id);
  const bundleDigest = drizzleInsightsSemanticKey([
    "report-key2",
    event.to_bundle_id,
  ]);
  const eventOrderKey = drizzleInsightsEventOrderKey(event.id);
  const rows = await queryDrizzleInsights(
    db,
    sql`select * from ${sql.identifier(DRIZZLE_INSIGHTS_REPORT_DISTINCT)}
      where job_id=${jobId} and section='activeBundleSeries'
        and entry_key=${entryKey} limit 1`,
  );
  const current = rows[0];
  if (current !== undefined) {
    const currentInstallId = text(current["key3"]);
    const currentInstallKey = text(current["key3_digest"]);
    await assertDrizzleInsightsStoredInstallation({
      install_id: currentInstallId,
      install_key: currentInstallKey,
    });
    const currentBundle = text(current["key1"]);
    if (
      currentInstallId !== event.install_id ||
      currentInstallKey !== installKey ||
      text(current["key2"]) !== currentBundle ||
      text(current["key2_digest"]) !==
        drizzleInsightsSemanticKey(["report-key2", currentBundle]) ||
      integer(current["bucket_ms"]) !== bucketMs ||
      current["received_at_ms"] === null ||
      current["event_order_key"] === null
    ) {
      return invalidResult();
    }
    const currentTime = integer(current["received_at_ms"])!;
    const currentOrderKey = binary(current["event_order_key"]);
    if (
      currentTime > event.received_at_ms ||
      (currentTime === event.received_at_ms &&
        Buffer.compare(currentOrderKey, eventOrderKey) >= 0)
    ) {
      return;
    }
    if (currentBundle !== event.to_bundle_id) {
      await changeActiveBundle(
        db,
        provider,
        jobId,
        currentBundle,
        bucketMs,
        -1,
      );
      await changeActiveBundle(
        db,
        provider,
        jobId,
        event.to_bundle_id,
        bucketMs,
        1,
      );
    }
    await mutateDrizzleInsights(
      db,
      sql`update ${sql.identifier(DRIZZLE_INSIGHTS_REPORT_DISTINCT)} set
        key1=${event.to_bundle_id},key2=${event.to_bundle_id},
        key2_digest=${bundleDigest},received_at_ms=${event.received_at_ms},
        event_order_key=${eventOrderKey}
        where job_id=${jobId} and section='activeBundleSeries'
          and entry_key=${entryKey}`,
    );
    return;
  }
  await mutateDrizzleInsights(
    db,
    sql`insert into ${sql.identifier(DRIZZLE_INSIGHTS_REPORT_DISTINCT)}
      (job_id,section,entry_key,key1,key2,key2_digest,key3,key3_digest,
        bucket_ms,received_at_ms,event_order_key)
      values (${jobId},'activeBundleSeries',${entryKey},${event.to_bundle_id},
        ${event.to_bundle_id},${bundleDigest},${event.install_id},${installKey},
        ${bucketMs},${event.received_at_ms},${eventOrderKey})`,
  );
  await changeActiveBundle(
    db,
    provider,
    jobId,
    event.to_bundle_id,
    bucketMs,
    1,
  );
};

const processEvent = async (
  db: DrizzleDB,
  provider: DrizzleProvider,
  job: ReportJob,
  event: BundleEventRow,
): Promise<void> => {
  const projection = createInsightsReportProjection(job.query, job.asOfMs);
  const item = projection.project(event);
  if (item === null) return;
  if (item.kind === "installation") {
    await upsertLatest(db, provider, job, item.event);
    if (item.bucketStartMs === null) return;
    if (
      await insertDistinct(db, {
        jobId: job.jobId,
        section: "activeSeries",
        key1: "",
        key2: "",
        key3: item.event.install_id,
        key3Digest: await drizzleInsightsInstallKey(item.event.install_id),
        bucketMs: item.bucketStartMs,
        identity: ["activeSeries", item.bucketStartMs, item.event.install_id],
      })
    ) {
      await mutateDrizzleInsights(
        db,
        outputMutation(provider, {
          jobId: job.jobId,
          section: "activeSeries",
          rowKey: String(item.bucketStartMs),
          sortNumber: item.bucketStartMs,
          row: { bucketStartMs: item.bucketStartMs },
          delta: 1,
        }),
      );
    }
    await saveActiveBundle(
      db,
      provider,
      job.jobId,
      item.event,
      item.bucketStartMs,
    );
    return;
  }
  if (
    await insertDistinct(db, {
      jobId: job.jobId,
      section: "movement",
      key1: item.bundleId,
      key2: item.metric,
      key3: item.installId,
      bucketMs: -1,
      identity: ["movement", item.bundleId, item.metric, item.installId],
    })
  ) {
    await mutateDrizzleInsights(
      db,
      outputMutation(provider, {
        jobId: job.jobId,
        section: "movementSummary",
        rowKey: drizzleInsightsSemanticKey([item.bundleId, item.metric]),
        row: { bundleId: item.bundleId, metric: item.metric },
        delta: 1,
      }),
    );
  }
  if (
    await insertDistinct(db, {
      jobId: job.jobId,
      section: "movementSeries",
      key1: item.bundleId,
      key2: item.metric,
      key3: item.installId,
      bucketMs: item.bucketStartMs,
      identity: [
        "movementSeries",
        item.bundleId,
        item.metric,
        item.bucketStartMs,
        item.installId,
      ],
    })
  ) {
    await mutateDrizzleInsights(
      db,
      outputMutation(provider, {
        jobId: job.jobId,
        section: `movementSeries:${item.metric}`,
        rowKey: String(item.bucketStartMs),
        sortNumber: item.bucketStartMs,
        row: { bucketStartMs: item.bucketStartMs },
        delta: 1,
      }),
    );
  }
  const newLabel = await insertDistinct(db, {
    jobId: job.jobId,
    section: "movementCohortLabels",
    key1: item.bundleId,
    key2: item.metric,
    key3: item.cohort,
    bucketMs: -1,
    identity: ["movementCohortLabels", item.bundleId, item.metric, item.cohort],
  });
  if (newLabel) {
    await incrementMeta(
      db,
      provider,
      job.jobId,
      `movementCohorts:${item.metric}`,
      1,
    );
  }
  if (
    await insertDistinct(db, {
      jobId: job.jobId,
      section: "movementCohorts",
      key1: item.bundleId,
      key2: item.metric,
      key3: item.cohort,
      bucketMs: -1,
      identity: [
        "movementCohorts",
        item.bundleId,
        item.metric,
        item.cohort,
        item.installId,
      ],
    })
  ) {
    await mutateDrizzleInsights(
      db,
      outputMutation(provider, {
        jobId: job.jobId,
        section: `movementCohorts:${item.metric}`,
        rowKey: drizzleInsightsSemanticKey(item.cohort),
        sortText: jsOrderKey(item.cohort),
        row: { cohort: item.cohort },
        delta: 1,
      }),
    );
  }
};

type PublishSection = {
  readonly key: string;
  readonly order: "text" | "value";
};

const publishSections = (job: ReportJob): readonly PublishSection[] => {
  switch (job.query.kind) {
    case "bundleSummaries":
      return [];
    case "bundleDetail":
      return [
        { key: "movementCohorts:installed", order: "text" },
        { key: "movementCohorts:recovered", order: "text" },
      ];
    case "installationOverview":
      return [{ key: "bundleDistribution", order: "value" }];
    case "activeOverview":
      return [
        { key: "bundleDistribution", order: "value" },
        {
          key:
            job.query.userId === undefined
              ? "activeBundleTotals"
              : "filteredActiveBundleTotals",
          order: "value",
        },
      ];
  }
};

const firstPublishSection = (job: ReportJob): string =>
  publishSections(job)[0]?.key ?? "";

export const createDrizzleInsightsReports = (
  db: DrizzleDB,
  provider: DrizzleProvider,
  databaseNamespace: string,
) => {
  const source = createDrizzleInsightsSource(db, provider, databaseNamespace);
  const readStoredJob = (row: Record<string, unknown>): ReportJob => {
    const job = readJob(row);
    if (job.sourceId !== databaseNamespace) return invalidResult();
    return job;
  };
  const findJob = async (jobId: string): Promise<ReportJob | null> => {
    const rows = await queryDrizzleInsights(
      db,
      sql`select * from ${sql.identifier(DRIZZLE_INSIGHTS_JOBS)}
        where job_id=${jobId} and job_kind='report' limit 1`,
    );
    return rows[0] === undefined ? null : readStoredJob(rows[0]);
  };
  const findReservation = async (
    reservationKey: string,
    target: DrizzleDB = db,
  ): Promise<ReportJob | null> => {
    const rows = await queryDrizzleInsights(
      target,
      sql`select * from ${sql.identifier(DRIZZLE_INSIGHTS_JOBS)}
        where reservation_key=${reservationKey} and job_kind='report' limit 1`,
    );
    return rows[0] === undefined ? null : readStoredJob(rows[0]);
  };
  const reserve = (
    semanticKey: string,
    query: InsightsReportQuery,
    sourceId: string,
    minimum: number,
  ) =>
    transactDrizzleInsights(db, async (transaction) => {
      const state = await lockDrizzleInsightsSourceFence(
        transaction,
        provider,
        databaseNamespace,
      );
      if (state.sourceId !== sourceId || state.status !== "ready") {
        return invalidResult();
      }
      const reservationKey = drizzleInsightsSemanticKey([
        1,
        "report",
        semanticKey,
      ]);
      const retained = await findReservation(reservationKey, transaction);
      if (
        retained !== null &&
        (retained.status !== "ready" || retained.asOfMs >= minimum)
      ) {
        return retained;
      }
      if (retained !== null) {
        await mutateDrizzleInsights(
          transaction,
          sql`update ${sql.identifier(DRIZZLE_INSIGHTS_JOBS)} set
            reservation_key=${drizzleInsightsSemanticKey(["archived", retained.jobId])}
            where job_id=${retained.jobId} and reservation_key=${reservationKey}`,
        );
      }
      const jobId = createUUIDv7();
      const asOfMs = Date.now();
      await mutateDrizzleInsights(
        transaction,
        provider === "mysql"
          ? sql`insert ignore into ${sql.identifier(DRIZZLE_INSIGHTS_JOBS)}
              (job_id,job_order_key,job_kind,semantic_key,reservation_key,query_json,source_id,
                source_max_seq,cursor_seq,phase,phase_section,phase_key,status,
                as_of_ms,completed_at_ms,total,error)
              values (${jobId},${drizzleInsightsEventOrderKey(jobId)},'report',${semanticKey},${reservationKey},
                ${JSON.stringify(query)},${sourceId},${state.committedSeq},0,'source','','','queued',
                ${asOfMs},null,null,null)`
          : sql`insert into ${sql.identifier(DRIZZLE_INSIGHTS_JOBS)}
              (job_id,job_order_key,job_kind,semantic_key,reservation_key,query_json,source_id,
                source_max_seq,cursor_seq,phase,phase_section,phase_key,status,
                as_of_ms,completed_at_ms,total,error)
              values (${jobId},${drizzleInsightsEventOrderKey(jobId)},'report',${semanticKey},${reservationKey},
                ${JSON.stringify(query)},${sourceId},${state.committedSeq},0,'source','','','queued',
                ${asOfMs},null,null,null)
              on conflict(reservation_key) do nothing`,
      );
      return (
        (await findReservation(reservationKey, transaction)) ?? invalidResult()
      );
    });
  const failJob = async (job: ReportJob, error: unknown) => {
    const message =
      error instanceof DatabasePluginInputError &&
      error.code === "invalid-result"
        ? "migration-poison"
        : error instanceof Error
          ? error.message.slice(0, 1024)
          : "job-failed";
    await mutateDrizzleInsights(
      db,
      sql`update ${sql.identifier(DRIZZLE_INSIGHTS_JOBS)} set
        status='failed',error=${message},completed_at_ms=${Date.now()}
        where job_id=${job.jobId} and status in ('queued','preparing')`,
    );
    return (await findJob(job.jobId)) ?? invalidResult();
  };
  const latest = async (
    semanticKey: string,
    status?: ReportJob["status"],
    minimum = 0,
  ): Promise<ReportJob | null> => {
    const rows = await queryDrizzleInsights(
      db,
      sql`select * from ${sql.identifier(DRIZZLE_INSIGHTS_JOBS)}
        where job_kind='report' and semantic_key=${semanticKey}
          ${status === undefined ? sql`` : sql`and status=${status}`}
          and as_of_ms >= ${minimum}
        order by as_of_ms desc,job_order_key desc limit 1`,
    );
    return rows[0] === undefined ? null : readStoredJob(rows[0]);
  };

  const advanceFilter = async (
    job: ReportJob,
    maxRows = JOB_ROWS,
  ): Promise<ReportAdvance> => {
    if (job.query.kind !== "activeOverview" || job.query.userId === undefined) {
      return invalidResult();
    }
    const userId = job.query.userId;
    const userKey = drizzleInsightsSemanticKey(["user", userId]);
    const rows = await queryDrizzleInsights(
      db,
      sql`select d.* from ${sql.identifier(DRIZZLE_INSIGHTS_REPORT_DISTINCT)} d
        where d.job_id=${job.jobId}
          and d.section in ('activeSeries','activeBundleSeries')
          and (d.section > ${job.phaseSection} or
            (d.section=${job.phaseSection} and d.entry_key>${job.phaseKey}))
        order by d.section asc,d.entry_key asc limit ${maxRows}`,
    );
    const bytes = Buffer.byteLength(JSON.stringify(rows), "utf8");
    if (bytes > INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES) {
      return invalidResult();
    }
    await transactDrizzleInsights(db, async (transaction) => {
      const lock = await queryDrizzleInsights(
        transaction,
        sql`select phase,phase_section,phase_key,status
          from ${sql.identifier(DRIZZLE_INSIGHTS_JOBS)} where job_id=${job.jobId}
          ${provider === "sqlite" ? sql`` : sql`for update`}`,
      );
      if (
        lock[0]?.["phase"] !== "filter" ||
        lock[0]?.["phase_section"] !== job.phaseSection ||
        lock[0]?.["phase_key"] !== job.phaseKey ||
        !["queued", "preparing"].includes(String(lock[0]?.["status"]))
      ) {
        return;
      }
      for (const row of rows) {
        const section = text(row["section"]);
        const bundleId = text(row["key1"]);
        const installId = text(row["key3"]);
        const installKey = text(row["key3_digest"]);
        await assertDrizzleInsightsStoredInstallation({
          install_id: installId,
          install_key: installKey,
        });
        const bucketMs = integer(row["bucket_ms"])!;
        const matching = await queryDrizzleInsights(
          transaction,
          sql`select install_id from ${sql.identifier(DRIZZLE_INSIGHTS_REPORT_LATEST)}
            where job_id=${job.jobId} and user_key=${userKey}
              and user_id=${userId} and install_key=${installKey}
              and install_id=${installId} limit 1`,
        );
        if (matching.length === 0) continue;
        if (section === "activeSeries") {
          await mutateDrizzleInsights(
            transaction,
            outputMutation(provider, {
              jobId: job.jobId,
              section: "filteredActiveSeries",
              rowKey: String(bucketMs),
              sortNumber: bucketMs,
              row: { bucketStartMs: bucketMs },
              delta: 1,
            }),
          );
        } else if (section === "activeBundleSeries") {
          const bundleKey = drizzleInsightsSemanticKey(bundleId);
          await mutateDrizzleInsights(
            transaction,
            outputMutation(provider, {
              jobId: job.jobId,
              section: `filteredActiveBundleSeries:${bundleKey}`,
              rowKey: String(bucketMs),
              sortNumber: bucketMs,
              row: { bundleId, bucketStartMs: bucketMs },
              delta: 1,
            }),
          );
          const before = await outputValue(
            transaction,
            job.jobId,
            "filteredActiveBundleTotals",
            bundleKey,
          );
          await mutateDrizzleInsights(
            transaction,
            outputMutation(provider, {
              jobId: job.jobId,
              section: "filteredActiveBundleTotals",
              rowKey: bundleKey,
              sortText: jsOrderKey(bundleId),
              row: { bundleId },
              delta: 1,
            }),
          );
          if (before === 0) {
            await incrementMeta(
              transaction,
              provider,
              job.jobId,
              "filteredActiveBundleTotal",
              1,
            );
          }
        } else {
          return invalidResult();
        }
      }
      const last = rows.at(-1);
      const section =
        last === undefined ? job.phaseSection : text(last["section"]);
      const key = last === undefined ? job.phaseKey : text(last["entry_key"]);
      const filtered = rows.length < maxRows;
      const publishSection = firstPublishSection(job);
      await mutateDrizzleInsights(
        transaction,
        sql`update ${sql.identifier(DRIZZLE_INSIGHTS_JOBS)} set
          phase=${filtered ? "publish" : "filter"},
          phase_section=${filtered ? publishSection : section},
          phase_key=${filtered ? "0" : key},
          status=${filtered && publishSection === "" ? "ready" : "preparing"},
          completed_at_ms=${filtered && publishSection === "" ? Date.now() : null}
          where job_id=${job.jobId} and phase='filter'
            and phase_section=${job.phaseSection} and phase_key=${job.phaseKey}`,
      );
    });
    return {
      job: (await findJob(job.jobId)) ?? invalidResult(),
      items: rows.length,
      bytes,
    };
  };

  const advancePublish = async (
    job: ReportJob,
    maxRows = JOB_ROWS,
  ): Promise<ReportAdvance> => {
    const sections = publishSections(job);
    const sectionIndex = sections.findIndex(
      (section) => section.key === job.phaseSection,
    );
    const section = sections[sectionIndex];
    if (section === undefined) return invalidResult();
    const ordinal = integer(job.phaseKey)!;
    const rows = await queryDrizzleInsights(
      db,
      sql`select row_key,sort_text,value,row_json
        from ${sql.identifier(DRIZZLE_INSIGHTS_REPORT_OUTPUT)}
        where job_id=${job.jobId} and section_key=${section.key}
          and page_ordinal is null and value>0
        order by ${
          section.order === "value"
            ? sql`value desc,sort_text asc,row_key asc`
            : sql`sort_text asc,row_key asc`
        } limit ${maxRows}`,
    );
    const bytes = Buffer.byteLength(JSON.stringify(rows), "utf8");
    if (bytes > INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES) return invalidResult();
    await transactDrizzleInsights(db, async (transaction) => {
      const lock = await queryDrizzleInsights(
        transaction,
        sql`select phase,phase_section,phase_key,status
          from ${sql.identifier(DRIZZLE_INSIGHTS_JOBS)} where job_id=${job.jobId}
          ${provider === "sqlite" ? sql`` : sql`for update`}`,
      );
      if (
        lock[0]?.["phase"] !== "publish" ||
        lock[0]?.["phase_section"] !== job.phaseSection ||
        lock[0]?.["phase_key"] !== job.phaseKey ||
        !["queued", "preparing"].includes(String(lock[0]?.["status"]))
      ) {
        return;
      }
      if (rows.length > 0) {
        await mutateDrizzleInsights(
          transaction,
          sql`update ${sql.identifier(DRIZZLE_INSIGHTS_REPORT_OUTPUT)} set
            page_ordinal=case row_key ${sql.join(
              rows.map(
                (row, index) =>
                  sql`when ${text(row["row_key"])} then ${ordinal + index}`,
              ),
              sql.raw(" "),
            )} else page_ordinal end
            where job_id=${job.jobId} and section_key=${section.key}
              and page_ordinal is null and row_key in (${sql.join(
                rows.map((row) => sql`${text(row["row_key"])}`),
                sql.raw(","),
              )})`,
        );
      }
      const sectionComplete = rows.length < maxRows;
      const nextSection = sections[sectionIndex + 1]?.key ?? "";
      const ready = sectionComplete && nextSection === "";
      await mutateDrizzleInsights(
        transaction,
        sql`update ${sql.identifier(DRIZZLE_INSIGHTS_JOBS)} set
          phase_section=${sectionComplete ? nextSection : section.key},
          phase_key=${sectionComplete ? "0" : String(ordinal + rows.length)},
          status=${ready ? "ready" : "preparing"},
          completed_at_ms=${ready ? Date.now() : null}
          where job_id=${job.jobId} and phase='publish'
            and phase_section=${job.phaseSection} and phase_key=${job.phaseKey}`,
      );
    });
    return {
      job: (await findJob(job.jobId)) ?? invalidResult(),
      items: rows.length,
      bytes,
    };
  };

  const advance = async (
    job: ReportJob,
    maxRows = JOB_ROWS,
    preflightRows = maxRows,
    process = true,
  ): Promise<ReportAdvance> => {
    if (job.status === "ready" || job.status === "failed") {
      return { job, items: 0, bytes: 0 };
    }
    if (job.phase === "filter") {
      return process
        ? advanceFilter(job, maxRows)
        : { job, items: 0, bytes: 0 };
    }
    if (job.phase === "publish") {
      return process
        ? advancePublish(job, maxRows)
        : { job, items: 0, bytes: 0 };
    }
    const candidates = await queryDrizzleInsights(
      db,
      sql`select * from ${sql.identifier(DRIZZLE_INSIGHTS_EVENTS)}
        where seq > ${job.cursorSeq} and seq <= ${job.sourceMaxSeq}
        order by seq asc limit ${preflightRows}`,
    );
    const examined = candidates.map(readDrizzleInsightsStoredEvent);
    let bytes = 0;
    for (const row of examined) {
      bytes += getDrizzleInsightsEventBytes(row.event);
      if (bytes > INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES) return invalidResult();
    }
    if (!process) return { job, items: examined.length, bytes };
    const rows = examined.slice(0, maxRows);
    await transactDrizzleInsights(db, async (transaction) => {
      const lock = await queryDrizzleInsights(
        transaction,
        sql`select cursor_seq,phase,status from ${sql.identifier(DRIZZLE_INSIGHTS_JOBS)}
          where job_id=${job.jobId}
          ${provider === "sqlite" ? sql`` : sql`for update`}`,
      );
      if (
        lock[0] === undefined ||
        lock[0]["phase"] !== "source" ||
        integer(lock[0]["cursor_seq"]) !== job.cursorSeq ||
        !["queued", "preparing"].includes(String(lock[0]["status"]))
      ) {
        return;
      }
      for (const row of rows) {
        await processEvent(transaction, provider, job, row.event);
      }
      const cursor = rows.at(-1)?.seq ?? job.cursorSeq;
      const sourceReady =
        examined.length === rows.length && examined.length < preflightRows;
      const filter =
        sourceReady &&
        job.query.kind === "activeOverview" &&
        job.query.userId !== undefined;
      const publishSection = firstPublishSection(job);
      const publish = sourceReady && !filter && publishSection !== "";
      await mutateDrizzleInsights(
        transaction,
        sql`update ${sql.identifier(DRIZZLE_INSIGHTS_JOBS)} set
          cursor_seq=${cursor},
          phase=${filter ? "filter" : publish ? "publish" : "source"},
          phase_section=${filter ? "" : publish ? publishSection : job.phaseSection},
          phase_key=${filter ? "" : publish ? "0" : job.phaseKey},
          status=${sourceReady && !filter && !publish ? "ready" : "preparing"},
          completed_at_ms=${sourceReady && !filter && !publish ? Date.now() : null}
          where job_id=${job.jobId} and phase='source'
            and cursor_seq=${job.cursorSeq}`,
      );
    });
    return {
      job: (await findJob(job.jobId)) ?? invalidResult(),
      items: examined.length,
      bytes,
    };
  };

  const publication = async (
    job: ReportJob,
  ): Promise<InsightsReportPublication> => {
    if (job.status !== "ready" || job.completedAtMs === null) {
      return invalidResult();
    }
    const base = {
      id: job.jobId,
      asOfMs: job.asOfMs,
      completedAtMs: job.completedAtMs,
      sourceGeneration: sourceGeneration(job),
      accuracy: "exact" as const,
    };
    switch (job.query.kind) {
      case "bundleSummaries": {
        const summary = await Promise.all(
          job.query.bundleIds.map(async (bundleId) => ({
            bundleId,
            installed: await outputValue(
              db,
              job.jobId,
              "movementSummary",
              drizzleInsightsSemanticKey([bundleId, "installed"]),
            ),
            recovered: await outputValue(
              db,
              job.jobId,
              "movementSummary",
              drizzleInsightsSemanticKey([bundleId, "recovered"]),
            ),
          })),
        );
        return { ...base, kind: job.query.kind, summary };
      }
      case "bundleDetail":
        return {
          ...base,
          kind: job.query.kind,
          summary: {
            installed: await outputValue(
              db,
              job.jobId,
              "movementSummary",
              drizzleInsightsSemanticKey([job.query.bundleId, "installed"]),
            ),
            recovered: await outputValue(
              db,
              job.jobId,
              "movementSummary",
              drizzleInsightsSemanticKey([job.query.bundleId, "recovered"]),
            ),
          },
        };
      case "installationOverview":
        return {
          ...base,
          kind: job.query.kind,
          summary: {
            trackedInstallations: await outputValue(
              db,
              job.jobId,
              "meta",
              "summaryInstallations",
            ),
          },
        };
      case "activeOverview":
        return {
          ...base,
          kind: job.query.kind,
          summary: {
            activeInstallations: await outputValue(
              db,
              job.jobId,
              "meta",
              "summaryInstallations",
            ),
          },
        };
    }
  };

  const pageOutput = async (
    job: ReportJob,
    input: InsightsReportPageInput,
    parsed: ReturnType<typeof readInsightsReportPageQuery>,
  ): Promise<InsightsReportPage> => {
    if (job.status !== "ready" || job.completedAtMs === null) {
      return invalidResult();
    }
    const start = integer(parsed.nextOrdinal)!;
    const projection = createInsightsReportProjection(job.query, job.asOfMs);
    const published = await publication(job);
    const baseData = {
      consistency: {
        kind: "snapshot" as const,
        cutoff: {
          kind: "publication" as const,
          publication: {
            id: published.id,
            asOfMs: published.asOfMs,
            completedAtMs: published.completedAtMs,
            sourceGeneration: published.sourceGeneration,
            accuracy: published.accuracy,
          },
        },
      },
    };
    const bounds = (total: number) => {
      if (!Number.isSafeInteger(total) || total < 0 || start > total) {
        return invalid();
      }
      const size = Math.min(input.limit, total - start);
      const next = start + size;
      return {
        size,
        nextCursor:
          next < total
            ? createInsightsReportPageCursor(
                input,
                String(next),
                databaseNamespace,
              )
            : null,
      };
    };
    const fixedSeries = async (
      sectionKey: string,
      first: number,
      last: number,
      bucketSize: number,
    ) => {
      const total = Math.max(0, Math.floor((last - first) / bucketSize) + 1);
      const page = bounds(total);
      const buckets = Array.from(
        { length: page.size },
        (_, index) => first + (start + index) * bucketSize,
      );
      const values =
        buckets.length === 0
          ? []
          : await queryDrizzleInsights<{
              sort_number: unknown;
              value: unknown;
            }>(
              db,
              sql`select sort_number,value
                from ${sql.identifier(DRIZZLE_INSIGHTS_REPORT_OUTPUT)}
                where job_id=${job.jobId} and section_key=${sectionKey}
                  and sort_number in (${sql.join(
                    buckets.map((bucket) => sql`${bucket}`),
                    sql.raw(","),
                  )})`,
            );
      const byBucket = new Map(
        values.map((row) => [integer(row.sort_number)!, integer(row.value)!]),
      );
      return {
        rows: buckets.map((bucketStartMs) => ({
          bucketStartMs,
          value: byBucket.get(bucketStartMs) ?? 0,
        })),
        nextCursor: page.nextCursor,
        total,
      };
    };
    const ordinalRows = async (sectionKey: string, total: number) => {
      const page = bounds(total);
      const rows =
        page.size === 0
          ? []
          : await queryDrizzleInsights(
              db,
              sql`select * from ${sql.identifier(DRIZZLE_INSIGHTS_REPORT_OUTPUT)}
                where job_id=${job.jobId} and section_key=${sectionKey}
                  and page_ordinal>=${start}
                order by page_ordinal asc limit ${page.size}`,
            );
      if (rows.length !== page.size) return invalidResult();
      return { rows, nextCursor: page.nextCursor, total };
    };

    let data: StagedReportPage;
    if (parsed.input.section === "movementSeries") {
      if (job.query.kind !== "bundleDetail") return invalid();
      let first = projection.firstBucketMs;
      if (first === null) {
        const rows = await queryDrizzleInsights<{ minimum: unknown }>(
          db,
          sql`select min(bucket_ms) minimum
            from ${sql.identifier(DRIZZLE_INSIGHTS_REPORT_DISTINCT)}
            where job_id=${job.jobId} and section='movementSeries'
              and key2=${parsed.input.metric}`,
        );
        first =
          rows[0]?.minimum === null
            ? projection.lastBucketMs
            : integer(rows[0]?.minimum)!;
      }
      const result = await fixedSeries(
        `movementSeries:${parsed.input.metric}`,
        first,
        projection.lastBucketMs,
        projection.bucketSizeMs,
      );
      data = {
        section: parsed.input.section,
        metric: parsed.input.metric,
        rows: result.rows,
        nextCursor: result.nextCursor,
        total: result.total,
      };
    } else if (parsed.input.section === "activeSeries") {
      if (job.query.kind !== "activeOverview") return invalid();
      const result = await fixedSeries(
        job.query.userId === undefined
          ? "activeSeries"
          : "filteredActiveSeries",
        projection.firstBucketMs!,
        projection.lastBucketMs,
        projection.bucketSizeMs,
      );
      data = {
        section: parsed.input.section,
        rows: result.rows,
        nextCursor: result.nextCursor,
        total: result.total,
      };
    } else if (parsed.input.section === "movementCohorts") {
      if (job.query.kind !== "bundleDetail") return invalid();
      const total = await outputValue(
        db,
        job.jobId,
        "meta",
        `movementCohorts:${parsed.input.metric}`,
      );
      const result = await ordinalRows(
        `movementCohorts:${parsed.input.metric}`,
        total,
      );
      data = {
        section: parsed.input.section,
        metric: parsed.input.metric,
        rows: result.rows.map((row) => ({
          cohort: outputLabel(row["row_json"], "cohort"),
          value: integer(row["value"])!,
        })),
        nextCursor: result.nextCursor,
        total,
      };
    } else if (parsed.input.section === "bundleDistribution") {
      if (
        job.query.kind !== "installationOverview" &&
        job.query.kind !== "activeOverview"
      )
        return invalid();
      const total = await outputValue(
        db,
        job.jobId,
        "meta",
        "bundleDistributionTotal",
      );
      const result = await ordinalRows("bundleDistribution", total);
      data = {
        section: parsed.input.section,
        rows: result.rows.map((row) => ({
          bundleId: outputLabel(row["row_json"], "bundleId"),
          installations: integer(row["value"])!,
        })),
        nextCursor: result.nextCursor,
        total,
      };
    } else {
      if (job.query.kind !== "activeOverview") return invalid();
      const bundleId = parsed.input.bundleId;
      if (bundleId !== undefined) {
        const result = await fixedSeries(
          `${
            job.query.userId === undefined
              ? "activeBundleSeries"
              : "filteredActiveBundleSeries"
          }:${drizzleInsightsSemanticKey(bundleId)}`,
          projection.firstBucketMs!,
          projection.lastBucketMs,
          projection.bucketSizeMs,
        );
        data = {
          section: parsed.input.section,
          rows: result.rows.map((row) => ({ ...row, bundleId })),
          nextCursor: result.nextCursor,
          total: result.total,
        };
      } else {
        const bucketCount =
          Math.floor(
            (projection.lastBucketMs - projection.firstBucketMs!) /
              projection.bucketSizeMs,
          ) + 1;
        const totalsSection =
          job.query.userId === undefined
            ? "activeBundleTotals"
            : "filteredActiveBundleTotals";
        const bundleCount = await outputValue(
          db,
          job.jobId,
          "meta",
          job.query.userId === undefined
            ? "activeBundleTotal"
            : "filteredActiveBundleTotal",
        );
        const total = bundleCount * bucketCount;
        const page = bounds(total);
        const bundleOrdinal = Math.floor(start / bucketCount);
        const bucketOffset = start % bucketCount;
        const requestedBundles = Math.ceil(
          (bucketOffset + page.size) / bucketCount,
        );
        const bundles =
          requestedBundles === 0
            ? []
            : await queryDrizzleInsights(
                db,
                sql`select * from ${sql.identifier(DRIZZLE_INSIGHTS_REPORT_OUTPUT)}
                  where job_id=${job.jobId} and section_key=${totalsSection}
                    and page_ordinal>=${bundleOrdinal}
                  order by page_ordinal asc limit ${requestedBundles}`,
              );
        if (bundles.length !== requestedBundles) return invalidResult();
        const rows: {
          bundleId: string;
          bucketStartMs: number;
          value: number;
        }[] = [];
        for (const [bundleIndex, bundle] of bundles.entries()) {
          const bundleId = outputLabel(bundle["row_json"], "bundleId");
          const firstOffset = bundleIndex === 0 ? bucketOffset : 0;
          const buckets = Array.from(
            {
              length: Math.min(
                bucketCount - firstOffset,
                page.size - rows.length,
              ),
            },
            (_, index) =>
              projection.firstBucketMs! +
              (firstOffset + index) * projection.bucketSizeMs,
          );
          const sectionKey = `${
            job.query.userId === undefined
              ? "activeBundleSeries"
              : "filteredActiveBundleSeries"
          }:${drizzleInsightsSemanticKey(bundleId)}`;
          const values =
            buckets.length === 0
              ? []
              : await queryDrizzleInsights<{
                  sort_number: unknown;
                  value: unknown;
                }>(
                  db,
                  sql`select sort_number,value
                    from ${sql.identifier(DRIZZLE_INSIGHTS_REPORT_OUTPUT)}
                    where job_id=${job.jobId} and section_key=${sectionKey}
                      and sort_number in (${sql.join(
                        buckets.map((bucket) => sql`${bucket}`),
                        sql.raw(","),
                      )})`,
                );
          const byBucket = new Map(
            values.map((row) => [
              integer(row.sort_number)!,
              integer(row.value)!,
            ]),
          );
          rows.push(
            ...buckets.map((bucketStartMs) => ({
              bundleId,
              bucketStartMs,
              value: byBucket.get(bucketStartMs) ?? 0,
            })),
          );
        }
        data = {
          section: parsed.input.section,
          rows,
          nextCursor: page.nextCursor,
          total,
        };
      }
    }
    const common = {
      nextCursor: data.nextCursor,
      hasNext: data.nextCursor !== null,
      ...baseData,
      total: {
        state: "exact" as const,
        value: data.total,
        sourceGeneration: sourceGeneration(job),
      },
    };
    let result: InsightsReportPage;
    switch (data.section) {
      case "movementSeries":
        result = {
          state: "ready",
          versions: versions(provider, job),
          data: {
            section: data.section,
            metric: data.metric,
            data: data.rows,
            ...common,
          },
        };
        break;
      case "movementCohorts":
        result = {
          state: "ready",
          versions: versions(provider, job),
          data: {
            section: data.section,
            metric: data.metric,
            data: data.rows,
            ...common,
          },
        };
        break;
      case "bundleDistribution":
        result = {
          state: "ready",
          versions: versions(provider, job),
          data: {
            section: data.section,
            data: data.rows,
            ...common,
          },
        };
        break;
      case "activeSeries":
        result = {
          state: "ready",
          versions: versions(provider, job),
          data: {
            section: data.section,
            data: data.rows,
            ...common,
          },
        };
        break;
      case "activeBundleSeries":
        result = {
          state: "ready",
          versions: versions(provider, job),
          data: {
            section: data.section,
            data: data.rows,
            ...common,
          },
        };
    }
    assertInsightsPageContract(result, input.limit);
    return result;
  };

  const stored = {
    async advanceJob(
      jobId: string,
      maxRows: number,
      preflightRows = maxRows,
      process = true,
    ): Promise<
      | { readonly status: "missing"; readonly items: 0; readonly bytes: 0 }
      | {
          readonly status: ReportJob["status"];
          readonly items: number;
          readonly bytes: number;
        }
    > {
      if (
        !Number.isSafeInteger(maxRows) ||
        maxRows < 1 ||
        maxRows > JOB_ROWS ||
        !Number.isSafeInteger(preflightRows) ||
        preflightRows < maxRows ||
        preflightRows > JOB_ROWS
      ) {
        return invalid();
      }
      let job;
      try {
        job = await findJob(jobId);
      } catch (error) {
        if (
          !(error instanceof DatabasePluginInputError) ||
          error.code !== "invalid-result"
        ) {
          throw error;
        }
        await mutateDrizzleInsights(
          db,
          sql`update ${sql.identifier(DRIZZLE_INSIGHTS_JOBS)} set
            status='failed',error='migration-poison',completed_at_ms=${Date.now()}
            where job_id=${jobId} and job_kind='report'`,
        );
        return { status: "failed" as const, items: 0, bytes: 0 };
      }
      if (job === null) return { status: "missing", items: 0, bytes: 0 };
      let items = 0;
      let bytes = 0;
      if (job.status === "queued" || job.status === "preparing") {
        try {
          const result = await advance(job, maxRows, preflightRows, process);
          job = result.job;
          items = result.items;
          bytes = result.bytes;
        } catch (error) {
          job = await failJob(job, error);
          items = maxRows;
        }
      }
      return { status: job.status, items, bytes };
    },
    async getReport(input: InsightsReportInput): Promise<InsightsReportResult> {
      assertInsightsQueryContract(input);
      const parsed = readInsightsReportQuery(input);
      const semanticKey = drizzleInsightsSemanticKey([1, parsed.semanticKey]);
      let state;
      try {
        await source.assertReadyLayout();
        state = await source.readState();
      } catch (error) {
        if (!(error instanceof InsightsQueryNotReadyError)) throw error;
        const saved = await source.readState();
        return {
          state: "failed",
          versions: {
            schemaVersion: "insights-v1",
            storageVersion: `drizzle-${provider}-v1`,
            projectionGeneration: null,
            sourceGeneration: JSON.stringify([1, saved.sourceId, 0]),
          },
          error: { code: "index-not-ready" },
        };
      }
      const placeholder: InsightsReservedReadVersions = {
        schemaVersion: "insights-v1",
        storageVersion: `drizzle-${provider}-v1`,
        projectionGeneration: null,
        sourceGeneration: JSON.stringify([1, state.sourceId, 0]),
      };
      if (state.status === "failed")
        return {
          state: "failed",
          versions: placeholder,
          error: { code: "migration-poison", jobId: state.sourceId },
        };
      if (state.status !== "ready")
        return {
          state: "preparing",
          versions: placeholder,
          job: { id: state.sourceId },
        };
      const minimum = parsed.minAsOfMs ?? 0;
      const ready = await latest(semanticKey, "ready", minimum);
      if (ready !== null && ready.sourceId === state.sourceId) {
        let data;
        try {
          data = await publication(ready);
        } catch (error) {
          if (
            !(error instanceof DatabasePluginInputError) ||
            error.code !== "invalid-result"
          ) {
            throw error;
          }
          return {
            state: "failed",
            versions: versions(provider, ready),
            error: { code: "storage-corruption" },
          };
        }
        return {
          state: "ready",
          versions: versions(provider, ready),
          data,
        };
      }
      let active = await latest(semanticKey);
      if (
        active === null ||
        active.status === "ready" ||
        active.status === "failed" ||
        active.sourceId !== state.sourceId ||
        active.asOfMs < minimum
      ) {
        active = await reserve(
          semanticKey,
          parsed.query,
          state.sourceId,
          minimum,
        );
      }
      if (active.status === "failed")
        return {
          state: "failed",
          versions: versions(provider, active),
          error: { code: failureCode(active), jobId: active.jobId },
        };
      if (active.status === "ready")
        try {
          return {
            state: "ready",
            versions: versions(provider, active),
            data: await publication(active),
          };
        } catch (error) {
          if (
            !(error instanceof DatabasePluginInputError) ||
            error.code !== "invalid-result"
          ) {
            throw error;
          }
          return {
            state: "failed",
            versions: versions(provider, active),
            error: { code: "storage-corruption" },
          };
        }
      const previous = await latest(semanticKey, "ready");
      if (previous !== null)
        try {
          return {
            state: "stale",
            versions: versions(provider, previous),
            data: await publication(previous),
            refresh: { id: active.jobId },
          };
        } catch (error) {
          if (
            !(error instanceof DatabasePluginInputError) ||
            error.code !== "invalid-result"
          ) {
            throw error;
          }
          return {
            state: "failed",
            versions: versions(provider, previous),
            error: { code: "storage-corruption" },
          };
        }
      return {
        state: "preparing",
        versions: versions(provider, active),
        job: { id: active.jobId },
      };
    },
    async pageReport(
      input: InsightsReportPageInput,
    ): Promise<InsightsReportPage> {
      assertInsightsQueryContract(input);
      const parsed = readInsightsReportPageQuery(input, databaseNamespace);
      try {
        await source.assertReadyLayout();
        await source.readState();
      } catch (error) {
        if (!(error instanceof InsightsQueryNotReadyError)) throw error;
        const saved = await source.readState();
        return {
          state: "failed",
          versions: {
            schemaVersion: "insights-v1",
            storageVersion: `drizzle-${provider}-v1`,
            projectionGeneration: null,
            sourceGeneration: JSON.stringify([1, saved.sourceId, 0]),
          },
          error: { code: "index-not-ready" },
        };
      }
      const job = await findJob(input.publicationId);
      if (job === null)
        return { state: "expired", publicationId: input.publicationId };
      if (job.sourceId !== databaseNamespace) return invalidResult();
      if (job.status === "failed")
        return {
          state: "failed",
          versions: versions(provider, job),
          error: { code: failureCode(job), jobId: job.jobId },
        };
      if (job.status !== "ready")
        return {
          state: "failed",
          versions: versions(provider, job),
          error: { code: "storage-not-ready" },
        };
      try {
        return await pageOutput(job, input, parsed);
      } catch (error) {
        if (
          !(error instanceof DatabasePluginInputError) ||
          error.code !== "invalid-result"
        ) {
          throw error;
        }
        return {
          state: "failed",
          versions: versions(provider, job),
          error: { code: "storage-corruption" },
        };
      }
    },
  };
  return {
    advanceJob: stored.advanceJob,
    async getReport(input: InsightsReportInput): Promise<InsightsReportResult> {
      try {
        return await stored.getReport(input);
      } catch (error) {
        if (
          !(error instanceof DatabasePluginInputError) ||
          error.code !== "invalid-result"
        ) {
          throw error;
        }
        return {
          state: "failed",
          versions: corruptVersions(provider),
          error: { code: "storage-corruption" },
        };
      }
    },
    async pageReport(
      input: InsightsReportPageInput,
    ): Promise<InsightsReportPage> {
      try {
        return await stored.pageReport(input);
      } catch (error) {
        if (
          !(error instanceof DatabasePluginInputError) ||
          error.code !== "invalid-result"
        ) {
          throw error;
        }
        return {
          state: "failed",
          versions: corruptVersions(provider),
          error: { code: "storage-corruption" },
        };
      }
    },
  };
};
