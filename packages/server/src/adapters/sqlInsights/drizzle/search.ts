import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  createUUIDv7,
  type BundleEventRow,
  type InsightsInitialPublishedInstallationPage,
  type InsightsInitialPublishedInstallationPageInput,
  type InsightsInstallationRow,
  type InsightsPinnedInstallationPage,
  type InsightsPinnedInstallationPageInput,
  type InsightsPublishedInstallationContinuation,
  type InsightsPublishedInstallationContinuationInput,
  type InsightsPublishedInstallationPage,
  type InsightsPublishedInstallationPageData,
  type InsightsPublishedInstallationPageInput,
  type InsightsProjectedReadVersions,
  type InsightsReadVersions,
} from "@hot-updater/plugin-core";
import {
  assertInsightsCursorContract,
  assertInsightsPageContract,
  assertInsightsQueryContract,
  getCanonicalInsightsJsonByteLength,
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
  INSIGHTS_PAGE_MAX_BYTES,
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
  DRIZZLE_INSIGHTS_SEARCH_RESULTS,
} from "./schema";
import {
  createDrizzleInsightsSource,
  lockDrizzleInsightsSourceFence,
} from "./source";
import {
  drizzleInsightsEventOrderKey,
  drizzleInsightsSemanticKey,
  assertDrizzleInsightsStoredInstallation,
  getDrizzleInsightsEventBytes,
  readDrizzleInsightsEvent,
  readDrizzleInsightsStoredEvent,
} from "./storage";

const JOB_ROWS = 200;
const PAGE_ENVELOPE_RESERVE = 4 * 1024;
const SEARCH_CURSOR_REVISION = "drizzle-search-v1";
const hex = /^[0-9a-f]{64}$/;

type SearchJob = {
  readonly jobId: string;
  readonly semanticKey: string;
  readonly queryJson: string;
  readonly sourceId: string;
  readonly sourceMaxSeq: number;
  readonly cursorSeq: number;
  readonly status: "queued" | "preparing" | "ready" | "failed";
  readonly asOfMs: number;
  readonly completedAtMs: number | null;
  readonly total: number | null;
  readonly error: string | null;
};

type CanonicalSearch =
  | { readonly kind: "userId"; readonly value: string }
  | { readonly kind: "contains"; readonly value: string };

type SearchAdvance = {
  readonly job: SearchJob;
  readonly items: number;
  readonly bytes: number;
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

const readJob = (row: Record<string, unknown>): SearchJob => {
  const status = row["status"];
  if (
    status !== "queued" &&
    status !== "preparing" &&
    status !== "ready" &&
    status !== "failed"
  ) {
    return invalidResult();
  }
  const jobId = row["job_id"];
  const semanticKey = row["semantic_key"];
  const queryJson = row["query_json"];
  const sourceId = row["source_id"];
  if (
    typeof jobId !== "string" ||
    typeof semanticKey !== "string" ||
    typeof queryJson !== "string" ||
    typeof sourceId !== "string"
  ) {
    return invalidResult();
  }
  readStoredSearch(queryJson);
  return {
    jobId,
    semanticKey,
    queryJson,
    sourceId,
    sourceMaxSeq: integer(row["source_max_seq"])!,
    cursorSeq: integer(row["cursor_seq"])!,
    status,
    asOfMs: integer(row["as_of_ms"])!,
    completedAtMs: integer(row["completed_at_ms"], true),
    total: integer(row["total"], true),
    error: row["error"] === null ? null : String(row["error"]),
  };
};

const canonicalSearch = (
  input: InsightsPublishedInstallationPageInput,
): CanonicalSearch => {
  if (
    typeof input !== "object" ||
    input === null ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    return invalid();
  }
  if (input.kind === "userId") {
    if (
      typeof input.userId !== "string" ||
      input.userId.length > 1024 ||
      (input.publicationId !== undefined &&
        (typeof input.publicationId !== "string" ||
          input.publicationId.length > 1024)) ||
      (input.minAsOfMs !== undefined &&
        (!Number.isSafeInteger(input.minAsOfMs) || input.minAsOfMs < 0))
    ) {
      return invalid();
    }
    return { kind: input.kind, value: input.userId };
  }
  if (
    input.kind !== "contains" ||
    typeof input.query !== "string" ||
    input.query.length === 0 ||
    input.query.length > 1024 ||
    (input.publicationId !== undefined &&
      (typeof input.publicationId !== "string" ||
        input.publicationId.length > 1024)) ||
    (input.minAsOfMs !== undefined &&
      (!Number.isSafeInteger(input.minAsOfMs) || input.minAsOfMs < 0))
  ) {
    return invalid();
  }
  return { kind: input.kind, value: input.query.toLowerCase() };
};

const cursorJobId = (
  input: InsightsPublishedInstallationPageInput,
  semanticKey: string,
  databaseNamespace: string,
): { readonly sourceId: string; readonly jobId: string } | null => {
  if (input.cursor === undefined) return null;
  assertInsightsCursorContract(input.cursor);
  let value: unknown;
  try {
    value = JSON.parse(input.cursor);
  } catch {
    return invalid();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 6 ||
    value[0] !== 1 ||
    value[1] !== SEARCH_CURSOR_REVISION ||
    value[2] !== databaseNamespace ||
    typeof value[3] !== "string" ||
    value[4] !== semanticKey ||
    typeof value[5] !== "string" ||
    !hex.test(value[5])
  ) {
    return invalid();
  }
  return { sourceId: value[2], jobId: value[3] };
};

const sourceGeneration = (job: SearchJob): string =>
  JSON.stringify([1, job.sourceId, job.sourceMaxSeq]);

const versions = (
  provider: DrizzleProvider,
  job: SearchJob,
): InsightsProjectedReadVersions => ({
  schemaVersion: "insights-v1",
  storageVersion: `drizzle-${provider}-v1`,
  projectionGeneration: job.jobId,
  sourceGeneration: sourceGeneration(job),
});

const corruptVersions = (provider: DrizzleProvider): InsightsReadVersions => ({
  schemaVersion: "insights-v1",
  storageVersion: `drizzle-${provider}-v1`,
  projectionGeneration: null,
  sourceGeneration: null,
});

const failureCode = (job: SearchJob) =>
  job.error === "migration-poison"
    ? ("migration-poison" as const)
    : ("preparation-failed" as const);

const installationRow = (event: BundleEventRow): InsightsInstallationRow => ({
  id: event.id,
  install_id: event.install_id,
  user_id: event.user_id,
  username: event.username,
  to_bundle_id: event.to_bundle_id,
  type: event.type,
  platform: event.platform,
  app_version: event.app_version,
  channel: event.channel,
  cohort: event.cohort,
  received_at_ms: event.received_at_ms,
});

const upsertSearchResults = (
  provider: DrizzleProvider,
  jobId: string,
  rows: readonly ReturnType<typeof readDrizzleInsightsStoredEvent>[],
  matched: ReadonlySet<string>,
): SQL => {
  if (rows.length === 0) return invalidResult();
  const insert = sql`insert into ${sql.identifier(DRIZZLE_INSIGHTS_SEARCH_RESULTS)}
    (job_id,install_key,install_id,matched,event_id,event_order_key,received_at_ms,raw_event)
    values ${sql.join(
      rows.map(
        (row) =>
          sql`(${jobId},${row.install_key},${row.install_id},${matched.has(row.install_key) ? 1 : 0},
            ${row.event_id},${row.event_order_key},${row.received_at_ms},${row.raw_event})`,
      ),
      sql.raw(","),
    )}`;
  if (provider === "mysql") {
    return sql`${insert} on duplicate key update
      install_id=values(install_id),
      matched=greatest(matched,values(matched)),
      raw_event=if(received_at_ms < values(received_at_ms) or
        (received_at_ms=values(received_at_ms) and event_order_key<values(event_order_key)),
        values(raw_event),raw_event),
      event_id=if(received_at_ms < values(received_at_ms) or
        (received_at_ms=values(received_at_ms) and event_order_key<values(event_order_key)),
        values(event_id),event_id),
      event_order_key=if(received_at_ms < values(received_at_ms) or
        (received_at_ms=values(received_at_ms) and event_order_key<values(event_order_key)),
        values(event_order_key),event_order_key),
      received_at_ms=greatest(received_at_ms,values(received_at_ms))`;
  }
  const newer = sql`${sql.identifier(DRIZZLE_INSIGHTS_SEARCH_RESULTS)}.received_at_ms < excluded.received_at_ms
    or (${sql.identifier(DRIZZLE_INSIGHTS_SEARCH_RESULTS)}.received_at_ms=excluded.received_at_ms
      and ${sql.identifier(DRIZZLE_INSIGHTS_SEARCH_RESULTS)}.event_order_key<excluded.event_order_key)`;
  return sql`${insert} on conflict(job_id,install_key) do update set
    install_id=excluded.install_id,
    matched=case when excluded.matched=1 then 1
      else ${sql.identifier(DRIZZLE_INSIGHTS_SEARCH_RESULTS)}.matched end,
    event_id=case when ${newer} then excluded.event_id
      else ${sql.identifier(DRIZZLE_INSIGHTS_SEARCH_RESULTS)}.event_id end,
    event_order_key=case when ${newer} then excluded.event_order_key
      else ${sql.identifier(DRIZZLE_INSIGHTS_SEARCH_RESULTS)}.event_order_key end,
    received_at_ms=case when ${newer} then excluded.received_at_ms
      else ${sql.identifier(DRIZZLE_INSIGHTS_SEARCH_RESULTS)}.received_at_ms end,
    raw_event=case when ${newer} then excluded.raw_event
      else ${sql.identifier(DRIZZLE_INSIGHTS_SEARCH_RESULTS)}.raw_event end`;
};

const matches = (search: CanonicalSearch, event: BundleEventRow): boolean =>
  search.kind === "userId"
    ? event.user_id === search.value
    : event.install_id.toLowerCase().includes(search.value) ||
      (event.user_id?.toLowerCase().includes(search.value) ?? false) ||
      (event.username?.toLowerCase().includes(search.value) ?? false);

const readStoredSearch = (value: string): CanonicalSearch => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalidResult();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("kind" in parsed) ||
    !("value" in parsed) ||
    (parsed.kind !== "userId" && parsed.kind !== "contains") ||
    typeof parsed.value !== "string" ||
    parsed.value.length > 1024 ||
    (parsed.kind === "contains" && parsed.value.length === 0)
  ) {
    return invalidResult();
  }
  return { kind: parsed.kind, value: parsed.value };
};

export const createDrizzleInsightsSearch = (
  db: DrizzleDB,
  provider: DrizzleProvider,
  databaseNamespace: string,
) => {
  const source = createDrizzleInsightsSource(db, provider, databaseNamespace);
  const readStoredJob = (row: Record<string, unknown>): SearchJob => {
    const job = readJob(row);
    if (job.sourceId !== databaseNamespace) return invalidResult();
    return job;
  };

  const findJob = async (jobId: string): Promise<SearchJob | null> => {
    const rows = await queryDrizzleInsights(
      db,
      sql`select * from ${sql.identifier(DRIZZLE_INSIGHTS_JOBS)}
        where job_id=${jobId} and job_kind='search' limit 1`,
    );
    return rows[0] === undefined ? null : readStoredJob(rows[0]);
  };

  const findReservation = async (
    reservationKey: string,
    target: DrizzleDB = db,
  ): Promise<SearchJob | null> => {
    const rows = await queryDrizzleInsights(
      target,
      sql`select * from ${sql.identifier(DRIZZLE_INSIGHTS_JOBS)}
        where reservation_key=${reservationKey} and job_kind='search' limit 1`,
    );
    return rows[0] === undefined ? null : readStoredJob(rows[0]);
  };

  const reserve = (
    semanticKey: string,
    query: CanonicalSearch,
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
        "search",
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
              values (${jobId},${drizzleInsightsEventOrderKey(jobId)},'search',${semanticKey},${reservationKey},
                ${JSON.stringify(query)},${sourceId},${state.committedSeq},0,'source','','','queued',
                ${asOfMs},null,0,null)`
          : sql`insert into ${sql.identifier(DRIZZLE_INSIGHTS_JOBS)}
              (job_id,job_order_key,job_kind,semantic_key,reservation_key,query_json,source_id,
                source_max_seq,cursor_seq,phase,phase_section,phase_key,status,
                as_of_ms,completed_at_ms,total,error)
              values (${jobId},${drizzleInsightsEventOrderKey(jobId)},'search',${semanticKey},${reservationKey},
                ${JSON.stringify(query)},${sourceId},${state.committedSeq},0,'source','','','queued',
                ${asOfMs},null,0,null)
              on conflict(reservation_key) do nothing`,
      );
      return (
        (await findReservation(reservationKey, transaction)) ?? invalidResult()
      );
    });

  const failJob = async (job: SearchJob, error: unknown) => {
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

  const findLatest = async (
    semanticKey: string,
    sourceId: string | null,
    status?: SearchJob["status"],
    minimum = 0,
  ): Promise<SearchJob | null> => {
    const rows = await queryDrizzleInsights(
      db,
      sql`select * from ${sql.identifier(DRIZZLE_INSIGHTS_JOBS)}
        where job_kind='search' and semantic_key=${semanticKey}
          ${sourceId === null ? sql`` : sql`and source_id=${sourceId}`}
          ${status === undefined ? sql`` : sql`and status=${status}`}
          and as_of_ms >= ${minimum}
        order by as_of_ms desc,job_order_key desc limit 1`,
    );
    return rows[0] === undefined ? null : readStoredJob(rows[0]);
  };

  const advance = async (
    job: SearchJob,
    search: CanonicalSearch,
    maxRows = JOB_ROWS,
    preflightRows = maxRows,
    process = true,
  ): Promise<SearchAdvance> => {
    if (job.status === "ready" || job.status === "failed") {
      return { job, items: 0, bytes: 0 };
    }
    if (!process) return { job, items: 0, bytes: 0 };
    const candidates = await queryDrizzleInsights(
      db,
      sql`select * from ${sql.identifier(DRIZZLE_INSIGHTS_EVENTS)}
        where seq > ${job.cursorSeq} and seq <= ${job.sourceMaxSeq}
        order by seq asc limit ${preflightRows}`,
    );
    const examined = candidates.map(readDrizzleInsightsStoredEvent);
    await Promise.all(examined.map(assertDrizzleInsightsStoredInstallation));
    let bytes = 0;
    for (const row of examined) {
      bytes += getDrizzleInsightsEventBytes(row.event);
      if (bytes > INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES) return invalidResult();
    }
    const rows = examined.slice(0, maxRows);
    const matched = new Set<string>();
    for (const row of rows) {
      if (matches(search, row.event)) matched.add(row.install_key);
    }
    const keys = [...new Set(rows.map((row) => row.install_key))];
    const existing =
      keys.length === 0
        ? []
        : await queryDrizzleInsights<{
            install_key: unknown;
            install_id: unknown;
            matched: unknown;
          }>(
            db,
            sql`select install_key,install_id,matched
              from ${sql.identifier(DRIZZLE_INSIGHTS_SEARCH_RESULTS)}
              where job_id=${job.jobId} and install_key in (${sql.join(
                keys.map((key) => sql`${key}`),
                sql.raw(","),
              )})`,
          );
    await Promise.all(
      existing.map((row) =>
        assertDrizzleInsightsStoredInstallation({
          install_id: String(row.install_id),
          install_key: String(row.install_key),
        }),
      ),
    );
    const priorMatches = new Set(
      existing.flatMap((row) => {
        if (
          typeof row.install_key !== "string" ||
          typeof row.install_id !== "string" ||
          !hex.test(row.install_key)
        ) {
          return invalidResult();
        }
        const latestRow = rows.find(
          (candidate) => candidate.install_key === row.install_key,
        );
        if (
          latestRow !== undefined &&
          latestRow.install_id !== row.install_id
        ) {
          return invalidResult();
        }
        const value = integer(row.matched);
        if (value !== 0 && value !== 1) return invalidResult();
        return value === 1 ? [row.install_key] : [];
      }),
    );
    const added = [...matched].filter((key) => !priorMatches.has(key)).length;
    const latestRows = [
      ...rows
        .reduce((latest, row) => {
          const prior = latest.get(row.install_key);
          if (
            prior === undefined ||
            prior.received_at_ms < row.received_at_ms ||
            (prior.received_at_ms === row.received_at_ms &&
              Buffer.compare(prior.event_order_key, row.event_order_key) < 0)
          ) {
            latest.set(row.install_key, row);
          }
          return latest;
        }, new Map<string, (typeof rows)[number]>())
        .values(),
    ];
    await transactDrizzleInsights(db, async (transaction) => {
      const lock = await queryDrizzleInsights(
        transaction,
        sql`select cursor_seq,status from ${sql.identifier(DRIZZLE_INSIGHTS_JOBS)}
          where job_id=${job.jobId}
          ${provider === "sqlite" ? sql`` : sql`for update`}`,
      );
      if (
        lock[0] === undefined ||
        integer(lock[0]["cursor_seq"]) !== job.cursorSeq ||
        !["queued", "preparing"].includes(String(lock[0]["status"]))
      ) {
        return;
      }
      if (latestRows.length > 0) {
        await mutateDrizzleInsights(
          transaction,
          upsertSearchResults(provider, job.jobId, latestRows, matched),
        );
      }
      const cursorSeq = rows.at(-1)?.seq ?? job.cursorSeq;
      const ready =
        examined.length === rows.length && examined.length < preflightRows;
      await mutateDrizzleInsights(
        transaction,
        sql`update ${sql.identifier(DRIZZLE_INSIGHTS_JOBS)} set
          cursor_seq=${cursorSeq},status=${ready ? "ready" : "preparing"},
          completed_at_ms=${ready ? Date.now() : null},total=total+${added}
          where job_id=${job.jobId} and cursor_seq=${job.cursorSeq}
            and status in ('queued','preparing')`,
      );
    });
    return {
      job: (await findJob(job.jobId)) ?? invalidResult(),
      items: examined.length,
      bytes,
    };
  };

  const page = async (
    input: InsightsPublishedInstallationPageInput,
    search: CanonicalSearch,
    job: SearchJob,
  ): Promise<InsightsPublishedInstallationPageData> => {
    if (
      job.status !== "ready" ||
      job.completedAtMs === null ||
      job.total === null
    ) {
      return invalidResult();
    }
    let after: string | null = null;
    if (input.cursor !== undefined) {
      assertInsightsCursorContract(input.cursor);
      let cursor: unknown;
      try {
        cursor = JSON.parse(input.cursor);
      } catch {
        return invalid();
      }
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 6 ||
        cursor[0] !== 1 ||
        cursor[1] !== SEARCH_CURSOR_REVISION ||
        cursor[2] !== job.sourceId ||
        cursor[3] !== job.jobId ||
        cursor[4] !== job.semanticKey ||
        typeof cursor[5] !== "string" ||
        !hex.test(cursor[5])
      ) {
        return invalid();
      }
      after = cursor[5];
    }
    const rows = await queryDrizzleInsights(
      db,
      sql`select * from ${sql.identifier(DRIZZLE_INSIGHTS_SEARCH_RESULTS)}
        where job_id=${job.jobId} and matched=1
          ${after === null ? sql`` : sql`and install_key > ${after}`}
        order by install_key asc limit ${input.limit + 1}`,
    );
    const decoded = rows.map((row) => {
      const event = readDrizzleInsightsEvent(row["raw_event"]);
      const installKey = String(row["install_key"]);
      if (
        !hex.test(installKey) ||
        event.install_id !== row["install_id"] ||
        event.id !== row["event_id"]
      ) {
        return invalidResult();
      }
      return { event, installKey };
    });
    await Promise.all(
      decoded.map(({ event, installKey }) =>
        assertDrizzleInsightsStoredInstallation({
          install_id: event.install_id,
          install_key: installKey,
        }),
      ),
    );
    const emitted: {
      readonly row: InsightsInstallationRow;
      readonly installKey: string;
    }[] = [];
    for (const candidate of decoded.slice(0, input.limit)) {
      const row = installationRow(candidate.event);
      if (
        getCanonicalInsightsJsonByteLength([
          ...emitted.map((item) => item.row),
          row,
        ]) >
        INSIGHTS_PAGE_MAX_BYTES - PAGE_ENVELOPE_RESERVE
      ) {
        break;
      }
      emitted.push({ row, installKey: candidate.installKey });
    }
    const nextCursor =
      decoded.length > emitted.length
        ? JSON.stringify([
            1,
            SEARCH_CURSOR_REVISION,
            job.sourceId,
            job.jobId,
            job.semanticKey,
            emitted.at(-1)!.installKey,
          ])
        : null;
    if (nextCursor !== null) assertInsightsCursorContract(nextCursor);
    return {
      data: emitted.map(({ row }) => row),
      nextCursor,
      hasNext: nextCursor !== null,
      consistency: {
        kind: "snapshot",
        cutoff: {
          kind: "publication",
          publication: {
            id: job.jobId,
            asOfMs: job.asOfMs,
            completedAtMs: job.completedAtMs,
            sourceGeneration: sourceGeneration(job),
            accuracy: "exact",
          },
        },
      },
      total: {
        state: "exact",
        value: job.total,
        sourceGeneration: sourceGeneration(job),
      },
    };
  };

  const pageInstallationsStored = async (
    input: InsightsPublishedInstallationPageInput,
  ): Promise<InsightsPublishedInstallationPage> => {
    const search = canonicalSearch(input);
    const semanticKey = drizzleInsightsSemanticKey([1, search]);
    const cursorPublicationId = cursorJobId(
      input,
      semanticKey,
      databaseNamespace,
    );
    try {
      await source.assertReadyLayout();
    } catch (error) {
      if (!(error instanceof InsightsQueryNotReadyError)) throw error;
      const state = await source.readState();
      return {
        state: "failed",
        versions: {
          schemaVersion: "insights-v1",
          storageVersion: `drizzle-${provider}-v1`,
          projectionGeneration: null,
          sourceGeneration: JSON.stringify([1, state.sourceId, 0]),
        },
        error: { code: "index-not-ready" },
      };
    }
    if (
      input.publicationId !== undefined &&
      cursorPublicationId !== null &&
      input.publicationId !== cursorPublicationId.jobId
    ) {
      return invalid();
    }
    if (
      cursorPublicationId !== null &&
      cursorPublicationId.sourceId !== (await source.readState()).sourceId
    ) {
      return invalid();
    }
    const publicationId = input.publicationId ?? cursorPublicationId?.jobId;
    if (publicationId !== null && publicationId !== undefined) {
      const pinned = await findJob(publicationId);
      if (pinned === null) {
        return { state: "expired", publicationId };
      }
      if (pinned.semanticKey !== semanticKey) {
        return { state: "expired", publicationId };
      }
      if (input.minAsOfMs !== undefined && pinned.asOfMs < input.minAsOfMs) {
        return { state: "expired", publicationId };
      }
      if (pinned.status === "failed") {
        return {
          state: "failed",
          versions: versions(provider, pinned),
          error: { code: failureCode(pinned), jobId: pinned.jobId },
        };
      }
      if (pinned.status !== "ready") {
        return { state: "expired", publicationId };
      }
      let data;
      try {
        data = await page(input, search, pinned);
      } catch (error) {
        if (
          !(error instanceof DatabasePluginInputError) ||
          error.code !== "invalid-result"
        ) {
          throw error;
        }
        return {
          state: "failed",
          versions: versions(provider, pinned),
          error: { code: "storage-corruption" },
        };
      }
      const result = {
        state: "ready" as const,
        versions: versions(provider, pinned),
        data,
      };
      assertInsightsPageContract(result, input.limit);
      return result;
    }
    let state;
    try {
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
    if (state.status === "failed") {
      return {
        state: "failed",
        versions: {
          schemaVersion: "insights-v1",
          storageVersion: `drizzle-${provider}-v1`,
          projectionGeneration: null,
          sourceGeneration: JSON.stringify([1, state.sourceId, 0]),
        },
        error: { code: "migration-poison", jobId: state.sourceId },
      };
    }
    if (state.status !== "ready") {
      return {
        state: "preparing",
        versions: {
          schemaVersion: "insights-v1",
          storageVersion: `drizzle-${provider}-v1`,
          projectionGeneration: null,
          sourceGeneration: JSON.stringify([1, state.sourceId, 0]),
        },
        job: { id: state.sourceId },
      };
    }
    const minimum = input.minAsOfMs ?? 0;
    const ready = await findLatest(
      semanticKey,
      state.sourceId,
      "ready",
      minimum,
    );
    if (ready !== null && ready.sourceId === state.sourceId) {
      let data;
      try {
        data = await page(input, search, ready);
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
      const result = {
        state: "ready" as const,
        versions: versions(provider, ready),
        data,
      };
      assertInsightsPageContract(result, input.limit);
      return result;
    }
    let active = await findLatest(semanticKey, state.sourceId);
    if (
      active === null ||
      active.status === "ready" ||
      active.status === "failed" ||
      active.asOfMs < minimum
    ) {
      active = await reserve(semanticKey, search, state.sourceId, minimum);
    }
    if (active.status === "failed") {
      return {
        state: "failed",
        versions: versions(provider, active),
        error: { code: failureCode(active), jobId: active.jobId },
      };
    }
    if (active.status === "ready") {
      let data;
      try {
        data = await page(input, search, active);
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
      const result = {
        state: "ready" as const,
        versions: versions(provider, active),
        data,
      };
      assertInsightsPageContract(result, input.limit);
      return result;
    }
    const previous = await findLatest(semanticKey, null, "ready");
    if (previous !== null) {
      let data;
      try {
        data = await page(input, search, previous);
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
      const result = {
        state: "stale" as const,
        versions: versions(provider, previous),
        data,
        refresh: { id: active.jobId },
      };
      assertInsightsPageContract(result, input.limit);
      return result;
    }
    return {
      state: "preparing",
      versions: versions(provider, active),
      job: { id: active.jobId },
    };
  };

  async function pageInstallations(
    input: InsightsInitialPublishedInstallationPageInput,
  ): Promise<InsightsInitialPublishedInstallationPage>;
  async function pageInstallations(
    input: InsightsPinnedInstallationPageInput,
  ): Promise<InsightsPinnedInstallationPage>;
  async function pageInstallations(
    input: InsightsPublishedInstallationContinuationInput,
  ): Promise<InsightsPublishedInstallationContinuation>;
  async function pageInstallations(
    input: InsightsPublishedInstallationPageInput,
  ): Promise<InsightsPublishedInstallationPage>;
  async function pageInstallations(
    input: InsightsPublishedInstallationPageInput,
  ): Promise<InsightsPublishedInstallationPage> {
    assertInsightsQueryContract(input);
    try {
      return await pageInstallationsStored(input);
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
  }

  return {
    pageInstallations,
    async advanceJob(
      jobId: string,
      maxRows: number,
      preflightRows = maxRows,
      process = true,
    ): Promise<
      | { readonly status: "missing"; readonly items: 0; readonly bytes: 0 }
      | {
          readonly status: SearchJob["status"];
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
            where job_id=${jobId} and job_kind='search'`,
        );
        return { status: "failed", items: 0, bytes: 0 };
      }
      if (job === null) return { status: "missing", items: 0, bytes: 0 };
      let items = 0;
      let bytes = 0;
      if (job.status === "queued" || job.status === "preparing") {
        try {
          const result = await advance(
            job,
            readStoredSearch(job.queryJson),
            maxRows,
            preflightRows,
            process,
          );
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
  };
};
