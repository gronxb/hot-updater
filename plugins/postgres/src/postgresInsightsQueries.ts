import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
  type InsightsModel,
  type InsightsInstallationPage,
  type InsightsInstallationPageInput,
  type InsightsInitialPublishedInstallationPage,
  type InsightsInitialPublishedInstallationPageInput,
  type InsightsLiveInstallationPage,
  type InsightsLiveInstallationPageInput,
  type InsightsPageEventsInput,
  type InsightsPageEventsResult,
  type InsightsPinnedInstallationPage,
  type InsightsPinnedInstallationPageInput,
  type InsightsProjectedReadVersions,
  type InsightsPublishedInstallationContinuation,
  type InsightsPublishedInstallationContinuationInput,
  type InsightsPublishedInstallationPage,
  type InsightsPublishedInstallationPageInput,
  type InsightsReadVersions,
  type InsightsReservedReadVersions,
  type InsightsReportInput,
  type InsightsReportPage,
  type InsightsReportPageInput,
  type InsightsReportResult,
  type InsightsSourceReadVersions,
} from "@hot-updater/plugin-core";
import {
  assertInsightsCursorContract,
  createInsightsReportPageCursor,
  InsightsContractError,
  isCanonicalInsightsEventId,
  readInsightsInstallationPageInput,
  readInsightsPageEventsInput,
  readInsightsReportPageInput,
  readInsightsReportPageQuery,
} from "@hot-updater/plugin-core/internal";
import { sql, type Kysely, type QueryExecutorProvider } from "kysely";

import {
  assertPostgresInsightsStoredEvent,
  fitPostgresInsightsPage,
  POSTGRES_INSIGHTS_EVENT_COLUMNS,
} from "./postgresInsightsContract";
import { createPostgresInsightsInstallationLookup } from "./postgresInsightsInstallation";
import type {
  PostgresInsightsInstallationPage,
  PostgresInsightsInstallationPageInput,
  PostgresInsightsReportResult,
} from "./postgresInsightsInternalTypes";
import {
  createPostgresInsightsJobs,
  readPostgresInsightsReportPublication,
} from "./postgresInsightsJobs";
import {
  createPostgresInsightsLivePageCursor,
  createPostgresInsightsLivePages,
} from "./postgresInsightsLive";
import { createPostgresInsightsReportPages } from "./postgresInsightsReportPages";
import { createPostgresInsightsReportWorker } from "./postgresInsightsReports";
import {
  createPostgresInsightsSearchPageCursor,
  createPostgresInsightsSearchPages,
} from "./postgresInsightsSearchPages";
import {
  appendPostgresInsightsEvent,
  readPostgresInsightsSourceGeneration,
  readPostgresInsightsSourceIdentity,
} from "./postgresInsightsSource";
import type { Database } from "./types";

const schemaVersion = "1.0.0";
const storageVersion = "postgres-insights-v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const unavailableVersions: InsightsReadVersions = {
  schemaVersion: null,
  storageVersion: null,
  projectionGeneration: null,
  sourceGeneration: null,
};
const sourceVersions = (
  sourceGeneration: string,
): InsightsSourceReadVersions => ({
  schemaVersion,
  storageVersion,
  projectionGeneration: null,
  sourceGeneration,
});
const projectedVersions = (
  sourceGeneration: string,
  projectionGeneration: string,
): InsightsProjectedReadVersions => ({
  schemaVersion,
  storageVersion,
  projectionGeneration,
  sourceGeneration,
});
const reservedVersions = (
  sourceGeneration: string,
): InsightsReservedReadVersions => ({
  schemaVersion,
  storageVersion,
  projectionGeneration: null,
  sourceGeneration,
});

const assertSourceNamespace = (
  sourceGeneration: string,
  databaseNamespace: string,
): void => {
  if (
    readPostgresInsightsSourceIdentity(sourceGeneration).sourceId !==
    databaseNamespace
  )
    throw new DatabasePluginInputError("invalid-result");
};

const eventSelectorKey = (input: InsightsPageEventsInput): string =>
  input.selector.kind === "all"
    ? JSON.stringify(["all"])
    : input.selector.kind === "installationId"
      ? JSON.stringify(["installationId", input.selector.installId])
      : JSON.stringify(["bundleId", input.selector.bundleId]);

type RequiredEventCursor = {
  readonly sourceId: string;
  readonly receivedAtMs: number;
  readonly id: string;
};

const readRequiredEventCursor = (
  input: InsightsPageEventsInput,
): RequiredEventCursor | undefined => {
  if (input.cursor === undefined) return undefined;
  try {
    assertInsightsCursorContract(input.cursor);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
  let value: unknown;
  try {
    value = JSON.parse(input.cursor);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 8 ||
    value[0] !== "postgres-events-v1" ||
    value[1] !== eventSelectorKey(input) ||
    value[2] !== input.beforeReceivedAtMs ||
    value[3] !== (input.sinceReceivedAtMs ?? 0) ||
    typeof value[4] !== "string" ||
    !uuid.test(value[4]) ||
    !Number.isSafeInteger(value[5]) ||
    value[5] < (input.sinceReceivedAtMs ?? 0) ||
    value[5] >= input.beforeReceivedAtMs ||
    !isCanonicalInsightsEventId(value[6]) ||
    value[7] !== "received-desc-id-desc"
  )
    throw new DatabasePluginInputError("invalid-query");
  return { sourceId: value[4], receivedAtMs: value[5], id: value[6] };
};

const createRequiredEventCursor = (
  input: InsightsPageEventsInput,
  sourceId: string,
  last: { readonly received_at_ms: number; readonly id: string },
): string => {
  const cursor = JSON.stringify([
    "postgres-events-v1",
    eventSelectorKey(input),
    input.beforeReceivedAtMs,
    input.sinceReceivedAtMs ?? 0,
    sourceId,
    last.received_at_ms,
    last.id,
    "received-desc-id-desc",
  ]);
  try {
    assertInsightsCursorContract(cursor);
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
  return cursor;
};

const readRequiredLiveCursor = (
  input: Extract<InsightsInstallationPageInput, { kind: "all" }>,
): { sourceId: string; installId: string } | undefined => {
  if (input.cursor === undefined) return undefined;
  try {
    assertInsightsCursorContract(input.cursor);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
  let value: unknown;
  try {
    value = JSON.parse(input.cursor);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value[0] !== "postgres-live-v1" ||
    typeof value[1] !== "string" ||
    !uuid.test(value[1]) ||
    typeof value[2] !== "string"
  )
    throw new DatabasePluginInputError("invalid-query");
  return { sourceId: value[1], installId: value[2] };
};

const createRequiredLiveCursor = (
  sourceId: string,
  installId: string,
): string => {
  const cursor = JSON.stringify(["postgres-live-v1", sourceId, installId]);
  try {
    assertInsightsCursorContract(cursor);
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
  return cursor;
};

const cutoffPublication = <
  TPublication extends {
    readonly id: string;
    readonly asOfMs: number;
    readonly completedAtMs: number;
    readonly sourceGeneration: string;
    readonly accuracy: "exact";
  },
>(
  publication: TPublication,
) => ({
  id: publication.id,
  asOfMs: publication.asOfMs,
  completedAtMs: publication.completedAtMs,
  sourceGeneration: publication.sourceGeneration,
  accuracy: publication.accuracy,
});

type PostgresInsightsEventStream =
  | { readonly kind: "all" }
  | {
      readonly kind: "installation";
      readonly installId: string;
      readonly type: "UPDATE_APPLIED" | "RECOVERED";
    }
  | {
      readonly kind: "bundle";
      readonly field: "to_bundle_id" | "from_bundle_id";
      readonly bundleId: string;
      readonly type: "UPDATE_APPLIED" | "RECOVERED";
    };

const compareEvents = (
  left: Pick<BundleEventRow, "received_at_ms" | "id">,
  right: Pick<BundleEventRow, "received_at_ms" | "id">,
): number =>
  right.received_at_ms - left.received_at_ms ||
  (left.id < right.id ? 1 : left.id > right.id ? -1 : 0);

const eventStreams = (
  input: InsightsPageEventsInput,
): readonly PostgresInsightsEventStream[] => {
  if (input.selector.kind === "all") return [{ kind: "all" }];
  if (input.selector.kind === "installationId") {
    const installId = input.selector.installId;
    return (["UPDATE_APPLIED", "RECOVERED"] as const).map((type) => ({
      kind: "installation" as const,
      installId,
      type,
    }));
  }
  if (!uuid.test(input.selector.bundleId))
    throw new DatabasePluginInputError("invalid-query");
  return [
    {
      kind: "bundle",
      field: "to_bundle_id",
      bundleId: input.selector.bundleId,
      type: "UPDATE_APPLIED",
    },
    {
      kind: "bundle",
      field: "from_bundle_id",
      bundleId: input.selector.bundleId,
      type: "RECOVERED",
    },
  ];
};

const assertPostgresInsightsEventIndexes = async (
  db: QueryExecutorProvider,
  input: InsightsPageEventsInput,
): Promise<void> => {
  if (input.selector.kind === "installationId") {
    const { rows } = await sql<{ ready: boolean }>`select count(*) = 2 as ready
      from pg_index i join pg_class c on c.oid=i.indexrelid
      join pg_am am on am.oid=c.relam
      join pg_attribute install on install.attrelid=i.indrelid and install.attname='install_id'
      join pg_attribute time on time.attrelid=i.indrelid and time.attname='received_at_ms'
      join pg_attribute id on id.attrelid=i.indrelid and id.attname='id'
      join pg_collation coll on coll.oid=install.attcollation
      where i.indrelid=to_regclass('bundle_events') and
        ((i.indexrelid=to_regclass('bundle_events_install_applied_idx')
          and pg_get_expr(i.indpred,i.indrelid)='(type = ''UPDATE_APPLIED''::text)')
        or (i.indexrelid=to_regclass('bundle_events_install_recovered_idx')
          and pg_get_expr(i.indpred,i.indrelid)='(type = ''RECOVERED''::text)'))
        and i.indisvalid and i.indisready and am.amname='btree'
        and i.indnkeyatts=3 and i.indnatts=3 and i.indexprs is null
        and i.indkey[0]=install.attnum and i.indkey[1]=time.attnum
        and i.indkey[2]=id.attnum and coll.collisdeterministic
        and not exists (select 1 from unnest(i.indoption) bits where bits<>0)
        and not exists (select 1 from unnest(i.indclass) class_id
          join pg_opclass opclass on opclass.oid=class_id
          where not opclass.opcdefault)`.execute(db);
    if (!rows[0]?.ready) throw new InsightsQueryNotReadyError();
    return;
  }
  const { rows } = await sql<{ uuid_id: boolean; columns: readonly string[] }>`
    select a.atttypid='uuid'::regtype as uuid_id,
      array(select pg_get_indexdef(i.indexrelid,n,false)
        from generate_series(1,i.indnkeyatts)n) as columns
    from pg_index i join pg_class c on c.oid=i.indexrelid
    join pg_am am on am.oid=c.relam
    join pg_attribute a on a.attrelid=i.indrelid and a.attname='id'
    where i.indrelid=to_regclass('bundle_events') and i.indisvalid
      and i.indisready and i.indpred is null and i.indexprs is null
      and am.amname='btree'
      and not exists (select 1 from unnest(i.indoption) bits where bits<>0)
      and not exists (select 1 from unnest(i.indclass) class_id
        join pg_opclass opclass on opclass.oid=class_id
        where not opclass.opcdefault)`.execute(db);
  const required =
    input.selector.kind === "all"
      ? [["received_at_ms", "id"]]
      : [
          ["type", "to_bundle_id", "received_at_ms", "id"],
          ["type", "from_bundle_id", "received_at_ms", "id"],
        ];
  if (
    !required.every((columns) =>
      rows.some(
        (row) =>
          row.uuid_id &&
          row.columns.length === columns.length &&
          columns.every((column, index) => row.columns[index] === column),
      ),
    )
  )
    throw new InsightsQueryNotReadyError();
};

const readPostgresInsightsEventCandidates = async (
  db: QueryExecutorProvider,
  input: InsightsPageEventsInput,
  cursor: RequiredEventCursor | undefined,
): Promise<{ rows: readonly BundleEventRow[]; hasMore: boolean }> => {
  const candidateLimit = input.limit + 1;
  const read = async (
    stream: PostgresInsightsEventStream,
    mode: "tie" | "older",
    limit: number,
  ): Promise<readonly BundleEventRow[]> => {
    const predicates = [
      sql`received_at_ms >= ${input.sinceReceivedAtMs ?? 0}`,
      mode === "tie"
        ? sql`received_at_ms = ${cursor!.receivedAtMs} and id < ${cursor!.id}::uuid`
        : sql`received_at_ms < ${cursor?.receivedAtMs ?? input.beforeReceivedAtMs}`,
    ];
    if (stream.kind === "installation") {
      predicates.push(
        sql`install_id = any(array[${stream.installId}]::text[])`,
        sql`type = ${sql.lit(stream.type)}`,
      );
    } else if (stream.kind === "bundle") {
      predicates.push(
        sql`${sql.ref(stream.field)} = ${stream.bundleId}::uuid`,
        sql`type = ${sql.lit(stream.type)}`,
      );
    }
    const order =
      stream.kind === "installation"
        ? sql`install_id desc, received_at_ms desc, id desc`
        : sql`received_at_ms desc, id desc`;
    const result = await sql<
      BundleEventRow & { insights_event: BundleEventRow | null }
    >`select ${sql.join(POSTGRES_INSIGHTS_EVENT_COLUMNS.map((field) => sql.ref(field)))},
        insights_event from bundle_events where ${sql.join(predicates, sql` and `)}
        order by ${order} limit ${limit}`.execute(db);
    return result.rows.map(({ insights_event: event, ...stored }, index) => {
      if (event === null) throw new DatabasePluginInputError("invalid-result");
      assertPostgresInsightsStoredEvent(event);
      if (
        POSTGRES_INSIGHTS_EVENT_COLUMNS.some(
          (field) => event[field] !== stored[field],
        ) ||
        event.received_at_ms < (input.sinceReceivedAtMs ?? 0) ||
        event.received_at_ms >= input.beforeReceivedAtMs ||
        (mode === "tie" &&
          (event.received_at_ms !== cursor!.receivedAtMs ||
            event.id >= cursor!.id)) ||
        (mode === "older" &&
          event.received_at_ms >=
            (cursor?.receivedAtMs ?? input.beforeReceivedAtMs)) ||
        (stream.kind === "installation" &&
          (event.install_id !== stream.installId ||
            event.type !== stream.type)) ||
        (stream.kind === "bundle" &&
          (event[stream.field] !== stream.bundleId ||
            event.type !== stream.type))
      )
        throw new DatabasePluginInputError("invalid-result");
      const previous = result.rows[index - 1];
      if (previous !== undefined && compareEvents(previous, event) >= 0)
        throw new DatabasePluginInputError("invalid-result");
      return event;
    });
  };
  const streams: BundleEventRow[][] = [];
  for (const stream of eventStreams(input)) {
    const ties =
      cursor === undefined ? [] : await read(stream, "tie", candidateLimit);
    const older =
      ties.length === candidateLimit
        ? []
        : await read(stream, "older", candidateLimit - ties.length);
    streams.push([...ties, ...older]);
  }
  const candidates = streams.flat().sort(compareEvents);
  if (new Set(candidates.map(({ id }) => id)).size !== candidates.length)
    throw new DatabasePluginInputError("invalid-result");
  return {
    rows: candidates.slice(0, input.limit),
    hasMore: candidates.length > input.limit,
  };
};

const sourceFailure = (): InsightsPageEventsResult => ({
  state: "failed",
  versions: unavailableVersions,
  error: { code: "source-not-ready" },
});

const storageFailure = () => ({
  state: "failed" as const,
  versions: unavailableVersions,
  error: { code: "storage-corruption" as const },
});
const isStoredCorruption = (error: unknown): boolean =>
  error instanceof InsightsContractError ||
  (error instanceof DatabasePluginInputError &&
    error.code === "invalid-result");

const mapReportResult = (
  result: PostgresInsightsReportResult,
  databaseNamespace: string,
): InsightsReportResult => {
  if (result.state === "ready") {
    const generation = result.publication.sourceGeneration;
    assertSourceNamespace(generation, databaseNamespace);
    return {
      state: "ready",
      versions: projectedVersions(generation, generation),
      data: result.publication,
    };
  }
  if (result.state === "failed") {
    assertSourceNamespace(result.sourceGeneration, databaseNamespace);
    if (result.previous !== null)
      assertSourceNamespace(
        result.previous.sourceGeneration,
        databaseNamespace,
      );
    return {
      state: "failed",
      versions:
        result.previous === null
          ? reservedVersions(result.sourceGeneration)
          : projectedVersions(
              result.previous.sourceGeneration,
              result.previous.sourceGeneration,
            ),
      error: { code: "migration-poison", jobId: result.error.jobId },
    };
  }
  if (result.previous !== null) {
    const generation = result.previous.sourceGeneration;
    assertSourceNamespace(result.sourceGeneration, databaseNamespace);
    assertSourceNamespace(generation, databaseNamespace);
    return {
      state: "stale",
      versions: projectedVersions(generation, generation),
      data: result.previous,
      refresh: { id: result.jobId },
    };
  }
  assertSourceNamespace(result.sourceGeneration, databaseNamespace);
  return {
    state: "preparing",
    versions: reservedVersions(result.sourceGeneration),
    job: { id: result.jobId },
  };
};

export const createPostgresInsightsQueries = (
  db: Kysely<Database>,
  databaseNamespace: string,
): InsightsModel => {
  if (!uuid.test(databaseNamespace))
    throw new DatabasePluginInputError("invalid-query");
  const search = createPostgresInsightsSearchPages(db, databaseNamespace);
  const jobs = createPostgresInsightsJobs(db, databaseNamespace);
  const reports = createPostgresInsightsReportPages(db, databaseNamespace);
  const worker = createPostgresInsightsReportWorker(db, databaseNamespace);

  const pageEvents = async (
    input: InsightsPageEventsInput,
  ): Promise<InsightsPageEventsResult> => {
    input = readInsightsPageEventsInput(input);
    const cursor = readRequiredEventCursor(input);
    if (cursor !== undefined && cursor.sourceId !== databaseNamespace)
      throw new DatabasePluginInputError("invalid-query");
    return db
      .transaction()
      .setIsolationLevel("repeatable read")
      .setAccessMode("read only")
      .execute(async (transaction) => {
        let generation: string;
        try {
          generation = await readPostgresInsightsSourceGeneration(transaction);
        } catch (error) {
          if (error instanceof InsightsQueryNotReadyError)
            return sourceFailure();
          throw error;
        }
        const sourceId =
          readPostgresInsightsSourceIdentity(generation).sourceId;
        if (sourceId !== databaseNamespace)
          throw new DatabasePluginInputError("invalid-result");
        let page: { rows: readonly BundleEventRow[]; hasMore: boolean };
        try {
          await assertPostgresInsightsEventIndexes(transaction, input);
          page = await readPostgresInsightsEventCandidates(
            transaction,
            input,
            cursor,
          );
        } catch (error) {
          if (error instanceof InsightsQueryNotReadyError)
            return {
              state: "failed" as const,
              versions: sourceVersions(generation),
              error: { code: "index-not-ready" as const },
            };
          throw error;
        }
        return fitPostgresInsightsPage(
          page.rows,
          input.limit,
          (rows, shortened) => {
            const last = rows.at(-1);
            const nextCursor =
              last !== undefined && (shortened || page.hasMore)
                ? createRequiredEventCursor(input, sourceId, last)
                : null;
            return {
              state: "ready" as const,
              versions: sourceVersions(generation),
              data: {
                data: rows,
                nextCursor,
                hasNext: nextCursor !== null,
                consistency: {
                  kind: "live" as const,
                  cutoff: {
                    kind: "event-time" as const,
                    beforeReceivedAtMs: input.beforeReceivedAtMs,
                  },
                },
                total: { state: "unavailable" as const },
              },
            };
          },
        );
      })
      .catch((error: unknown) => {
        if (isStoredCorruption(error)) return storageFailure();
        throw error;
      });
  };

  const wrapInstallationPage = (
    page: PostgresInsightsInstallationPage,
    generation: string | undefined,
    requestedLimit: number,
    refreshJobId?: string,
    shortCursor?: (emittedRows: number) => string | null,
  ): InsightsInstallationPage => {
    if (page.state === "expired") return page;
    if (page.state !== "ready") {
      if (page.state === "failed") {
        return {
          state: "failed",
          versions:
            page.previous === null
              ? reservedVersions(page.sourceGeneration)
              : projectedVersions(
                  page.previous.sourceGeneration,
                  page.previous.sourceGeneration,
                ),
          error: page.error,
        };
      }
      return {
        state: "preparing",
        versions: reservedVersions(page.sourceGeneration),
        job: { id: page.jobId },
      };
    }
    const publication =
      page.consistency === "snapshot" ? page.publication : null;
    const observedAtMs =
      page.consistency === "live" ? page.observedAtMs : undefined;
    const pageGeneration = publication?.sourceGeneration ?? generation;
    if (pageGeneration === undefined)
      throw new DatabasePluginInputError("invalid-result");
    assertSourceNamespace(pageGeneration, databaseNamespace);
    const projectionGeneration = pageGeneration;
    return fitPostgresInsightsPage(
      page.rows,
      requestedLimit,
      (rows, shortened) => {
        const nextCursor =
          shortCursor !== undefined && (shortened || page.nextCursor !== null)
            ? shortCursor(rows.length)
            : page.nextCursor;
        const data = {
          data: rows,
          nextCursor,
          hasNext: nextCursor !== null,
          consistency:
            publication === null
              ? {
                  kind: "live" as const,
                  cutoff: {
                    kind: "projection" as const,
                    observedAtMs: observedAtMs!,
                    projectionGeneration,
                  },
                }
              : {
                  kind: "snapshot" as const,
                  cutoff: {
                    kind: "publication" as const,
                    publication: cutoffPublication(publication),
                  },
                },
          total:
            publication === null
              ? ({ state: "unavailable" as const } as const)
              : ({
                  state: "exact" as const,
                  value: publication.total,
                  sourceGeneration: publication.sourceGeneration,
                } as const),
        };
        return refreshJobId === undefined
          ? {
              state: "ready" as const,
              versions: projectedVersions(pageGeneration, projectionGeneration),
              data,
            }
          : {
              state: "stale" as const,
              versions: projectedVersions(pageGeneration, projectionGeneration),
              data,
              refresh: { id: refreshJobId },
            };
      },
    ) as InsightsInstallationPage;
  };

  function pageInstallations(
    input: InsightsLiveInstallationPageInput,
  ): Promise<InsightsLiveInstallationPage>;
  function pageInstallations(
    input: InsightsInitialPublishedInstallationPageInput,
  ): Promise<InsightsInitialPublishedInstallationPage>;
  function pageInstallations(
    input: InsightsPinnedInstallationPageInput,
  ): Promise<InsightsPinnedInstallationPage>;
  function pageInstallations(
    input: InsightsPublishedInstallationContinuationInput,
  ): Promise<InsightsPublishedInstallationContinuation>;
  function pageInstallations(
    input: InsightsPublishedInstallationPageInput,
  ): Promise<InsightsPublishedInstallationPage>;
  function pageInstallations(
    input: InsightsInstallationPageInput,
  ): Promise<InsightsInstallationPage>;
  async function pageInstallations(
    input: InsightsInstallationPageInput,
  ): Promise<InsightsInstallationPage> {
    input = readInsightsInstallationPageInput(input);
    if (input.kind === "contains" || input.kind === "userId") {
      const query =
        input.kind === "contains" ? input.query.toLowerCase() : input.userId;
      const publicationId =
        "publicationId" in input ? input.publicationId : undefined;
      const minAsOfMs = "minAsOfMs" in input ? input.minAsOfMs : undefined;
      if (publicationId === undefined && input.cursor === undefined) {
        let job: Awaited<ReturnType<typeof jobs.getSearch>>;
        try {
          job = await jobs.getSearch({
            kind: input.kind,
            query,
            ...(minAsOfMs === undefined ? {} : { minAsOfMs }),
          });
        } catch (error) {
          if (error instanceof InsightsQueryNotReadyError) {
            return {
              state: "failed",
              versions: unavailableVersions,
              error: { code: "source-not-ready" },
            };
          }
          throw error;
        }
        if (job.state === "ready") {
          assertSourceNamespace(
            job.publication.sourceGeneration,
            databaseNamespace,
          );
        } else {
          assertSourceNamespace(job.sourceGeneration, databaseNamespace);
          if (job.previous !== null)
            assertSourceNamespace(
              job.previous.sourceGeneration,
              databaseNamespace,
            );
        }
        if (job.state === "failed") {
          return {
            state: "failed",
            versions:
              job.previous === null
                ? reservedVersions(job.sourceGeneration)
                : projectedVersions(
                    job.previous.sourceGeneration,
                    job.previous.sourceGeneration,
                  ),
            error: { code: "migration-poison", jobId: job.error.jobId },
          };
        }
        if (job.state !== "ready" && job.previous === null) {
          return {
            state: "preparing",
            versions: reservedVersions(job.sourceGeneration),
            job: { id: job.jobId },
          };
        }
        const publication =
          job.state === "ready" ? job.publication : job.previous!;
        const { minAsOfMs: _minAsOfMs, ...pageInput } = input;
        let page: PostgresInsightsInstallationPage;
        try {
          page = await search.pageContains({
            ...pageInput,
            publicationId: publication.id,
          } as PostgresInsightsInstallationPageInput & {
            kind: "contains" | "userId";
          });
        } catch (error) {
          if (isStoredCorruption(error)) return storageFailure();
          throw error;
        }
        return wrapInstallationPage(
          page,
          publication.sourceGeneration,
          input.limit,
          job.state === "ready" ? undefined : job.jobId,
          (emittedRows) =>
            emittedRows === 0
              ? null
              : createPostgresInsightsSearchPageCursor(
                  input as PostgresInsightsInstallationPageInput & {
                    kind: "contains" | "userId";
                  },
                  publication.id,
                  emittedRows,
                  readPostgresInsightsSourceIdentity(
                    publication.sourceGeneration,
                  ).sourceId,
                ),
        );
      }
      let page: PostgresInsightsInstallationPage;
      try {
        page = await search.pageContains(
          input as PostgresInsightsInstallationPageInput & {
            kind: "contains" | "userId";
          },
        );
      } catch (error) {
        if (isStoredCorruption(error)) return storageFailure();
        throw error;
      }
      const generation =
        page.state === "ready" && page.consistency === "snapshot"
          ? page.publication.sourceGeneration
          : undefined;
      return wrapInstallationPage(
        page,
        generation,
        input.limit,
        undefined,
        (emittedRows) =>
          emittedRows === 0
            ? null
            : createPostgresInsightsSearchPageCursor(
                input as PostgresInsightsInstallationPageInput & {
                  kind: "contains" | "userId";
                },
                publicationId,
                emittedRows,
                readPostgresInsightsSourceIdentity(generation!).sourceId,
              ),
      );
    }

    const liveCursor =
      input.kind === "all" ? readRequiredLiveCursor(input) : undefined;
    if (liveCursor !== undefined && liveCursor.sourceId !== databaseNamespace)
      throw new DatabasePluginInputError("invalid-query");
    try {
      const { generation, page, sourceId } = await db
        .transaction()
        .setIsolationLevel("repeatable read")
        .setAccessMode("read only")
        .execute(async (transaction) => {
          const generation =
            await readPostgresInsightsSourceGeneration(transaction);
          const sourceId =
            readPostgresInsightsSourceIdentity(generation).sourceId;
          if (sourceId !== databaseNamespace)
            throw new DatabasePluginInputError("invalid-result");
          const page =
            input.kind === "all"
              ? await createPostgresInsightsLivePages(transaction).pageAll({
                  ...input,
                  ...(liveCursor === undefined
                    ? {}
                    : {
                        cursor: createPostgresInsightsLivePageCursor(
                          liveCursor.installId,
                        ),
                      }),
                })
              : await createPostgresInsightsInstallationLookup(
                  transaction,
                ).pageInstallation({
                  kind: "installation",
                  installId: input.installId,
                  limit: input.limit,
                });
          return { generation, page, sourceId };
        });
      return wrapInstallationPage(
        page,
        generation,
        input.limit,
        undefined,
        input.kind === "all"
          ? (emittedRows) => {
              const row =
                page.state === "ready" ? page.rows[emittedRows - 1] : undefined;
              return row === undefined
                ? null
                : createRequiredLiveCursor(sourceId, row.install_id);
            }
          : () => null,
      );
    } catch (error) {
      if (error instanceof InsightsQueryNotReadyError) {
        return {
          state: "failed",
          versions: unavailableVersions,
          error: { code: "source-not-ready" },
        };
      }
      if (isStoredCorruption(error)) return storageFailure();
      throw error;
    }
  }

  const getReport = async (
    input: InsightsReportInput,
  ): Promise<InsightsReportResult> => {
    try {
      return mapReportResult(await jobs.getReport(input), databaseNamespace);
    } catch (error) {
      if (error instanceof InsightsQueryNotReadyError) {
        return {
          state: "failed",
          versions: unavailableVersions,
          error: { code: "source-not-ready" },
        };
      }
      if (isStoredCorruption(error)) return storageFailure();
      throw error;
    }
  };

  const pageReport = async (
    input: InsightsReportPageInput,
  ): Promise<InsightsReportPage> => {
    input = readInsightsReportPageInput(input);
    const parsed = readInsightsReportPageQuery(input, databaseNamespace);
    let page: Awaited<ReturnType<typeof reports.pageReport>>;
    let saved: Awaited<
      ReturnType<typeof readPostgresInsightsReportPublication>
    >;
    try {
      page = await reports.pageReport(input);
      if (page.state === "expired") return page;
      saved = await readPostgresInsightsReportPublication(
        db,
        input.publicationId,
        databaseNamespace,
      );
    } catch (error) {
      if (
        error instanceof InsightsQueryNotReadyError ||
        isStoredCorruption(error)
      ) {
        return storageFailure();
      }
      throw error;
    }
    if (saved === null)
      return { state: "expired", publicationId: input.publicationId };
    const generation = saved.publication.sourceGeneration;
    try {
      if (
        readPostgresInsightsSourceIdentity(generation).sourceId !==
        databaseNamespace
      )
        return storageFailure();
    } catch (error) {
      if (isStoredCorruption(error)) return storageFailure();
      throw error;
    }
    const start = BigInt(parsed.nextOrdinal);
    return fitPostgresInsightsPage(
      page.rows as readonly unknown[],
      input.limit,
      (rows, shortened) => {
        const nextCursor = shortened
          ? createInsightsReportPageCursor(
              input,
              (start + BigInt(rows.length)).toString(),
              databaseNamespace,
            )
          : page.nextCursor;
        return {
          state: "ready" as const,
          versions: projectedVersions(generation, generation),
          data: {
            section: page.section,
            ...(page.section === "movementSeries" ||
            page.section === "movementCohorts"
              ? { metric: page.metric }
              : {}),
            data: rows as never,
            nextCursor,
            hasNext: nextCursor !== null,
            consistency: {
              kind: "snapshot" as const,
              cutoff: {
                kind: "publication" as const,
                publication: cutoffPublication(saved.publication),
              },
            },
            total: {
              state: "exact" as const,
              value: page.total,
              sourceGeneration: generation,
            },
          },
        };
      },
    ) as InsightsReportPage;
  };

  return {
    append: (row) =>
      appendPostgresInsightsEvent(db, row, databaseNamespace).then(
        () => undefined,
      ),
    async runMaintenanceStep({ maxItems, maxRequests }) {
      await worker.runStep({ maxItems, maxRequests });
    },
    pageEvents,
    pageInstallations,
    getReport,
    pageReport,
  };
};
