import {
  DatabasePluginInputError,
  type BundleEventRow,
  type InsightsInstallationRow,
  type InsightsProjectedReadVersions,
  type InsightsPublishedInstallationPage,
  type InsightsPublishedInstallationPageData,
  type InsightsPublishedInstallationPageInput,
} from "@hot-updater/plugin-core";
import {
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
  INSIGHTS_MAINTENANCE_MAX_ITEMS,
  INSIGHTS_MAINTENANCE_MAX_REQUESTS,
  assertInsightsCursorContract,
  assertInsightsQueryContract,
  canonicalInsightsJson,
  getCanonicalInsightsJsonByteLength,
} from "@hot-updater/plugin-core/internal";

import type { ORMSQLProvider } from "../../../db/types";
import {
  executePrismaInsights,
  PrismaInsightsSql,
  queryPrismaInsights,
  runPrismaInsightsTransaction,
  type PrismaInsightsClient,
  type PrismaInsightsRawClient,
} from "./client";
import {
  assertPrismaInsightsLimit,
  assertPrismaInsightsString,
  parsePrismaInsightsEventJson,
  prismaInsightsEventOrder,
  prismaInsightsInstallKey,
  takePrismaInsightsPageRows,
  toPrismaInsightsInstallationRow,
  validatedPrismaInsightsPageResult,
} from "./codec";
import {
  insertPrismaInsightsIgnore,
  selectPrismaInsightsRows,
  updatePrismaInsightsRows,
} from "./rawStore";
import {
  PRISMA_INSIGHTS_EVENTS,
  PRISMA_INSIGHTS_SEARCH_HEADS,
  PRISMA_INSIGHTS_SEARCH_JOBS,
  PRISMA_INSIGHTS_SEARCH_ROWS,
} from "./schema";
import { readReadyPrismaInsightsState } from "./source";
import {
  newPrismaInsightsId,
  prismaInsightsDigest,
  prismaInsightsPublication,
  prismaInsightsReadVersions,
  prismaInsightsSafeInteger,
  readPrismaInsightsDatabaseTime,
} from "./utils";

type SearchPhase = "membership" | "latest";
type SearchJob = {
  id: string;
  query_key: Uint8Array;
  query_json: string;
  state: "queued" | "preparing" | "ready" | "failed";
  phase: SearchPhase;
  source_generation: unknown;
  as_of_ms: unknown;
  completed_at_ms: unknown | null;
  after_generation: unknown;
  total: unknown | null;
  failure_json: string | null;
  lease_owner: string | null;
  lease_version: unknown;
};
type SearchHead = {
  query_key: Uint8Array;
  query_json: string;
  active_job_id: string | null;
  publication_job_id: string | null;
};
type SearchRow = {
  install_key: Uint8Array;
  install_id: string;
  event_id: string | null;
  received_at_ms: unknown | null;
  event_order: Uint8Array | null;
  event_json: string | null;
};
type SourceRow = { source_generation: unknown; event_json: string };

const searchJobColumns = [
  "id",
  "query_key",
  "query_json",
  "state",
  "phase",
  "source_generation",
  "as_of_ms",
  "completed_at_ms",
  "after_generation",
  "total",
  "failure_json",
  "lease_owner",
  "lease_version",
] as const;

const searchJobFence = (job: SearchJob) => {
  if (job.lease_owner === null)
    throw new DatabasePluginInputError("invalid-result");
  return {
    id: job.id,
    lease_owner: job.lease_owner,
    lease_version: prismaInsightsSafeInteger(job.lease_version),
  } as const;
};

type SearchQuery =
  | { readonly kind: "userId"; readonly value: string }
  | { readonly kind: "contains"; readonly value: string };

const parseInput = (
  input: InsightsPublishedInstallationPageInput,
): {
  readonly query: SearchQuery;
  readonly queryJson: string;
  readonly queryKey: Buffer;
} => {
  try {
    assertInsightsQueryContract(input);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
  assertPrismaInsightsLimit(input.limit);
  if (input.kind === "userId") {
    if (
      Object.keys(input).some(
        (key) =>
          ![
            "kind",
            "userId",
            "publicationId",
            "minAsOfMs",
            "limit",
            "cursor",
          ].includes(key),
      ) ||
      (input.minAsOfMs !== undefined &&
        (!Number.isSafeInteger(input.minAsOfMs) || input.minAsOfMs < 0))
    )
      throw new DatabasePluginInputError("invalid-query");
    assertPrismaInsightsString(input.userId);
    if (input.publicationId !== undefined)
      assertPrismaInsightsString(input.publicationId);
    const query = { kind: input.kind, value: input.userId } as const;
    const queryJson = JSON.stringify(query);
    return {
      query,
      queryJson,
      queryKey: prismaInsightsDigest(["prisma-search-1", query]),
    };
  }
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "kind",
          "query",
          "publicationId",
          "minAsOfMs",
          "limit",
          "cursor",
        ].includes(key),
    ) ||
    (input.minAsOfMs !== undefined &&
      (!Number.isSafeInteger(input.minAsOfMs) || input.minAsOfMs < 0))
  )
    throw new DatabasePluginInputError("invalid-query");
  assertPrismaInsightsString(input.query);
  if (input.publicationId !== undefined)
    assertPrismaInsightsString(input.publicationId);
  const query = { kind: input.kind, value: input.query.toLowerCase() } as const;
  const queryJson = JSON.stringify(query);
  return {
    query,
    queryJson,
    queryKey: prismaInsightsDigest(["prisma-search-1", query]),
  };
};

const readHead = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  queryKey: Buffer,
): Promise<SearchHead | undefined> =>
  (
    await selectPrismaInsightsRows<SearchHead>(client, provider, {
      table: PRISMA_INSIGHTS_SEARCH_HEADS,
      columns: [
        "query_key",
        "query_json",
        "active_job_id",
        "publication_job_id",
      ],
      where: { query_key: queryKey },
      limit: 1,
    })
  )[0];

const readJob = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  id: string,
): Promise<SearchJob | undefined> =>
  (
    await selectPrismaInsightsRows<SearchJob>(client, provider, {
      table: PRISMA_INSIGHTS_SEARCH_JOBS,
      columns: searchJobColumns,
      where: { id },
      limit: 1,
    })
  )[0];

const verifyJobQuery = (
  job: SearchJob,
  queryKey: Buffer,
  queryJson: string,
): void => {
  if (
    !Buffer.from(job.query_key).equals(queryKey) ||
    job.query_json !== queryJson
  )
    throw new DatabasePluginInputError("invalid-result");
};

const reserveJob = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  queryKey: Buffer,
  queryJson: string,
  sourceGeneration: number,
): Promise<SearchJob> => {
  const existing = await readHead(client, provider, queryKey);
  if (existing?.active_job_id) {
    const job = await readJob(client, provider, existing.active_job_id);
    if (
      job &&
      (job.state === "queued" ||
        job.state === "preparing" ||
        job.state === "failed")
    ) {
      verifyJobQuery(job, queryKey, queryJson);
      return job;
    }
  }
  const id = newPrismaInsightsId();
  const asOfMs = await readPrismaInsightsDatabaseTime(client, provider);
  await insertPrismaInsightsIgnore(
    client,
    provider,
    PRISMA_INSIGHTS_SEARCH_HEADS,
    {
      query_key: queryKey,
      query_json: queryJson,
      active_job_id: null,
      publication_job_id: null,
    },
    ["query_key"],
  );
  const head = await readHead(client, provider, queryKey);
  if (head === undefined || head.query_json !== queryJson) {
    throw new DatabasePluginInputError("invalid-result");
  }
  if (head.active_job_id) {
    const active = await readJob(client, provider, head.active_job_id);
    if (
      active &&
      (active.state === "queued" ||
        active.state === "preparing" ||
        active.state === "failed")
    )
      return active;
  }
  const jobInserted = await insertPrismaInsightsIgnore(
    client,
    provider,
    PRISMA_INSIGHTS_SEARCH_JOBS,
    {
      id,
      query_key: queryKey,
      query_json: queryJson,
      state: "queued",
      phase: "membership",
      source_generation: sourceGeneration,
      as_of_ms: asOfMs,
      completed_at_ms: null,
      after_generation: 0,
      total: 0,
      failure_json: null,
      lease_owner: null,
      lease_version: 0,
    },
    ["id"],
  );
  if (jobInserted !== 1) throw new DatabasePluginInputError("invalid-result");
  const changed = await updatePrismaInsightsRows(
    client,
    provider,
    PRISMA_INSIGHTS_SEARCH_HEADS,
    { active_job_id: id },
    { query_key: queryKey, active_job_id: null },
  );
  if (changed !== 1) throw new DatabasePluginInputError("invalid-result");
  const job = await readJob(client, provider, id);
  if (!job) throw new DatabasePluginInputError("invalid-result");
  return job;
};

const searchCursorRevision = "prisma-search-sha256-v3";
const searchNamespaceIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const parseCursor = (
  cursor: string,
): {
  readonly sourceId: string;
  readonly jobId: string;
  readonly queryKey: Buffer;
  readonly installKey: Buffer;
} => {
  try {
    assertInsightsCursorContract(cursor);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
  let value: unknown;
  try {
    value = JSON.parse(cursor);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 5 ||
    value[0] !== searchCursorRevision ||
    typeof value[1] !== "string" ||
    !searchNamespaceIdPattern.test(value[1]) ||
    typeof value[2] !== "string" ||
    value[2].length === 0 ||
    typeof value[3] !== "string" ||
    !/^[0-9a-f]{64}$/.test(value[3]) ||
    typeof value[4] !== "string" ||
    !/^[0-9a-f]{64}$/.test(value[4])
  )
    throw new DatabasePluginInputError("invalid-query");
  return {
    sourceId: value[1],
    jobId: value[2],
    queryKey: Buffer.from(value[3], "hex"),
    installKey: Buffer.from(value[4], "hex"),
  };
};

const readCursor = (
  input: InsightsPublishedInstallationPageInput,
  sourceId: string,
  jobId: string,
  queryKey: Buffer,
): Buffer | undefined => {
  if (input.cursor === undefined) return undefined;
  const cursor = parseCursor(input.cursor);
  if (
    cursor.sourceId !== sourceId ||
    cursor.jobId !== jobId ||
    !cursor.queryKey.equals(queryKey)
  )
    throw new DatabasePluginInputError("invalid-query");
  return cursor.installKey;
};

const createCursor = (
  sourceId: string,
  jobId: string,
  queryKey: Buffer,
  key: Buffer,
): string => {
  if (!searchNamespaceIdPattern.test(sourceId))
    throw new DatabasePluginInputError("invalid-result");
  const cursor = JSON.stringify([
    searchCursorRevision,
    sourceId,
    jobId,
    queryKey.toString("hex"),
    key.toString("hex"),
  ]);
  try {
    assertInsightsCursorContract(cursor);
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
  return cursor;
};

const pageReadyJob = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  input: InsightsPublishedInstallationPageInput,
  sourceId: string,
  job: SearchJob,
): Promise<{
  readonly versions: InsightsProjectedReadVersions;
  readonly data: InsightsPublishedInstallationPageData;
}> => {
  if (
    job.state !== "ready" ||
    job.completed_at_ms === null ||
    job.total === null
  )
    throw new DatabasePluginInputError("invalid-result");
  const sourceGeneration = prismaInsightsSafeInteger(job.source_generation);
  const queryKey = Buffer.from(job.query_key);
  const cursor = readCursor(input, sourceId, job.id, queryKey);
  const stored = await selectPrismaInsightsRows<SearchRow>(client, provider, {
    table: PRISMA_INSIGHTS_SEARCH_ROWS,
    columns: [
      "install_key",
      "install_id",
      "event_id",
      "received_at_ms",
      "event_order",
      "event_json",
    ],
    where: {
      job_id: job.id,
      ...(cursor === undefined
        ? {}
        : { install_key: { operator: "gt", value: cursor } as const }),
      event_json: { operator: "is-not-null" },
    },
    orderBy: [{ column: "install_key", direction: "asc" }],
    limit: input.limit + 1,
  });
  const keyed = stored.map((row) => {
    if (
      row.event_json === null ||
      row.event_id === null ||
      row.event_order === null
    )
      throw new DatabasePluginInputError("invalid-result");
    const event = parsePrismaInsightsEventJson(row.event_json);
    const key = Buffer.from(row.install_key);
    if (
      !key.equals(prismaInsightsInstallKey(row.install_id)) ||
      event.install_id !== row.install_id ||
      event.id !== row.event_id ||
      event.received_at_ms !== prismaInsightsSafeInteger(row.received_at_ms) ||
      !Buffer.from(row.event_order).equals(
        prismaInsightsEventOrder(row.event_id),
      )
    )
      throw new DatabasePluginInputError("invalid-result");
    return { key, row: toPrismaInsightsInstallationRow(event) };
  });
  const publication = {
    ...prismaInsightsPublication({
      id: job.id,
      asOfMs: prismaInsightsSafeInteger(job.as_of_ms),
      completedAtMs: prismaInsightsSafeInteger(job.completed_at_ms),
      sourceGeneration,
    }),
  };
  const versions = prismaInsightsReadVersions(sourceGeneration, job.id);
  const makeData = (
    data: readonly InsightsInstallationRow[],
    nextCursor: string | null,
  ): InsightsPublishedInstallationPageData => ({
    data,
    nextCursor,
    hasNext: nextCursor !== null,
    consistency: {
      kind: "snapshot",
      cutoff: { kind: "publication", publication },
    },
    total: {
      state: "exact",
      value: prismaInsightsSafeInteger(job.total),
      sourceGeneration: publication.sourceGeneration,
    },
  });
  const keys = new Map(keyed.map(({ key, row }) => [row.id, key]));
  const page = takePrismaInsightsPageRows(
    keyed.map(({ row }) => row),
    input.limit,
    (rows, nextCursor) => ({
      state: "ready",
      versions,
      data: makeData(rows, nextCursor),
    }),
    (row) => {
      const key = keys.get(row.id);
      if (!key) throw new DatabasePluginInputError("invalid-result");
      return createCursor(sourceId, job.id, queryKey, key);
    },
  );
  return { versions, data: makeData(page.rows, page.nextCursor) };
};

export const createPrismaInsightsSearchPages = (
  client: PrismaInsightsClient,
  provider: ORMSQLProvider,
  databaseNamespace: string,
) => ({
  async pageInstallations(
    input: InsightsPublishedInstallationPageInput,
  ): Promise<InsightsPublishedInstallationPage> {
    const parsed = parseInput(input);
    const parsedCursor =
      input.cursor === undefined ? undefined : parseCursor(input.cursor);
    if (parsedCursor && !parsedCursor.queryKey.equals(parsed.queryKey))
      throw new DatabasePluginInputError("invalid-query");
    if (
      parsedCursor &&
      input.publicationId !== undefined &&
      parsedCursor.jobId !== input.publicationId
    )
      throw new DatabasePluginInputError("invalid-query");
    return runPrismaInsightsTransaction<InsightsPublishedInstallationPage>(
      client,
      provider,
      async (transaction) => {
        const state = await readReadyPrismaInsightsState(
          transaction,
          provider,
          databaseNamespace,
        );
        if ("state" in state)
          return validatedPrismaInsightsPageResult(state, input.limit);
        if (parsedCursor && parsedCursor.sourceId !== state.sourceId)
          throw new DatabasePluginInputError("invalid-query");
        const cursorPublicationId = parsedCursor?.jobId;
        const pinnedPublicationId = cursorPublicationId ?? input.publicationId;
        let requested: SearchJob | undefined;
        if (pinnedPublicationId !== undefined) {
          requested = await readJob(transaction, provider, pinnedPublicationId);
          if (
            !requested ||
            requested.state !== "ready" ||
            requested.completed_at_ms === null ||
            !Buffer.from(requested.query_key).equals(parsed.queryKey) ||
            requested.query_json !== parsed.queryJson ||
            (input.minAsOfMs !== undefined &&
              prismaInsightsSafeInteger(requested.as_of_ms) < input.minAsOfMs)
          )
            return validatedPrismaInsightsPageResult(
              { state: "expired", publicationId: pinnedPublicationId },
              input.limit,
            );
          verifyJobQuery(requested, parsed.queryKey, parsed.queryJson);
          const page = await pageReadyJob(
            transaction,
            provider,
            input,
            state.sourceId,
            requested,
          );
          return validatedPrismaInsightsPageResult(
            { state: "ready", ...page },
            input.limit,
          );
        }
        const head = await readHead(transaction, provider, parsed.queryKey);
        if (head && head.query_json !== parsed.queryJson)
          throw new DatabasePluginInputError("invalid-result");
        if (head?.publication_job_id) {
          requested = await readJob(
            transaction,
            provider,
            head.publication_job_id,
          );
          if (requested)
            verifyJobQuery(requested, parsed.queryKey, parsed.queryJson);
        }
        const fresh =
          requested?.state === "ready" &&
          (input.minAsOfMs === undefined ||
            prismaInsightsSafeInteger(requested.as_of_ms) >= input.minAsOfMs);
        if (fresh && requested) {
          const page = await pageReadyJob(
            transaction,
            provider,
            input,
            state.sourceId,
            requested,
          );
          return validatedPrismaInsightsPageResult(
            { state: "ready", ...page },
            input.limit,
          );
        }
        const active =
          head?.active_job_id === undefined || head.active_job_id === null
            ? undefined
            : await readJob(transaction, provider, head.active_job_id);
        const job =
          active &&
          (active.state === "queued" ||
            active.state === "preparing" ||
            active.state === "failed")
            ? active
            : await reserveJob(
                transaction,
                provider,
                parsed.queryKey,
                parsed.queryJson,
                prismaInsightsSafeInteger(state.generation),
              );
        if (requested?.state === "ready") {
          const page = await pageReadyJob(
            transaction,
            provider,
            input,
            state.sourceId,
            requested,
          );
          return validatedPrismaInsightsPageResult(
            {
              state: "stale",
              ...page,
              refresh: { id: job.id },
            },
            input.limit,
          );
        }
        if (job.state === "failed") {
          return validatedPrismaInsightsPageResult(
            {
              state: "failed",
              versions: prismaInsightsReadVersions(
                prismaInsightsSafeInteger(job.source_generation),
                job.id,
              ),
              error: { code: "preparation-failed", jobId: job.id },
            },
            input.limit,
          );
        }
        return validatedPrismaInsightsPageResult(
          {
            state: "preparing",
            versions: prismaInsightsReadVersions(
              prismaInsightsSafeInteger(job.source_generation),
              job.id,
            ),
            job: { id: job.id },
          },
          input.limit,
        );
      },
    );
  },
});

const readSourcePage = (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  job: SearchJob,
  limit: number,
): Promise<SourceRow[]> => {
  const sql = new PrismaInsightsSql(provider);
  const after = sql.value(prismaInsightsSafeInteger(job.after_generation));
  const upper = sql.value(prismaInsightsSafeInteger(job.source_generation));
  const limitMarker = sql.value(limit);
  const top = provider === "mssql" ? `top (${limitMarker}) ` : "";
  const suffix = provider === "mssql" ? "" : ` limit ${limitMarker}`;
  const sourceIndex =
    provider === "mysql"
      ? " force index (source_generation)"
      : provider === "mssql"
        ? " with (forceseek)"
        : "";
  return queryPrismaInsights<SourceRow[]>(
    client,
    sql.statement(
      `select ${top}source_generation,event_json from ${PRISMA_INSIGHTS_EVENTS}${sourceIndex}
       where source_generation>${after} and source_generation<=${upper}
       order by source_generation asc${suffix}`,
    ),
  );
};

const matches = (query: SearchQuery, event: BundleEventRow): boolean => {
  if (query.kind === "userId") return event.user_id === query.value;
  return [event.install_id, event.user_id, event.username].some(
    (value) => value !== null && value.toLowerCase().includes(query.value),
  );
};

const parseJobQuery = (job: SearchJob): SearchQuery => {
  let value: unknown;
  try {
    value = JSON.parse(job.query_json);
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (Reflect.get(value, "kind") !== "userId" &&
      Reflect.get(value, "kind") !== "contains") ||
    typeof Reflect.get(value, "value") !== "string"
  )
    throw new DatabasePluginInputError("invalid-result");
  return value as SearchQuery;
};

const searchRowColumns = [
  "install_key",
  "install_id",
  "event_id",
  "received_at_ms",
  "event_order",
  "event_json",
] as const;

const readSearchRows = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  jobId: string,
  keys: readonly Buffer[],
): Promise<SearchRow[]> => {
  if (keys.length === 0) return [];
  const sql = new PrismaInsightsSql(provider);
  const job = sql.value(jobId);
  const keyList = keys.map((key) => sql.value(key)).join(",");
  return queryPrismaInsights<SearchRow[]>(
    client,
    sql.statement(
      `select ${searchRowColumns.join(",")} from ${PRISMA_INSIGHTS_SEARCH_ROWS}
       where job_id=${job} and install_key in (${keyList})`,
    ),
  );
};

const insertSearchRows = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  jobId: string,
  rows: readonly {
    readonly key: Buffer;
    readonly installId: string;
    readonly event: BundleEventRow | null;
  }[],
): Promise<void> => {
  if (rows.length === 0) return;
  const sql = new PrismaInsightsSql(provider);
  const values = rows.map(({ key, installId, event }) => {
    const fields = [
      jobId,
      key,
      installId,
      event?.id ?? null,
      event?.received_at_ms ?? null,
      event === null ? null : prismaInsightsEventOrder(event.id),
      event === null ? null : canonicalInsightsJson(event),
    ];
    return `(${fields.map((field) => sql.value(field)).join(",")})`;
  });
  const inserted = await executePrismaInsights(
    client,
    sql.statement(
      `insert into ${PRISMA_INSIGHTS_SEARCH_ROWS}
       (job_id,install_key,install_id,event_id,received_at_ms,event_order,event_json)
       values ${values.join(",")}`,
    ),
  );
  if (inserted !== rows.length)
    throw new DatabasePluginInputError("invalid-result");
};

const membershipBatch = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  job: SearchJob,
  query: SearchQuery,
  events: readonly BundleEventRow[],
): Promise<number> => {
  const candidates = new Map<
    string,
    { readonly key: Buffer; readonly installId: string }
  >();
  for (const event of events) {
    if (!matches(query, event)) continue;
    const key = prismaInsightsInstallKey(event.install_id);
    const digest = key.toString("hex");
    const current = candidates.get(digest);
    if (current && current.installId !== event.install_id)
      throw new DatabasePluginInputError("invalid-result");
    candidates.set(digest, { key, installId: event.install_id });
  }
  const existing = await readSearchRows(
    client,
    provider,
    job.id,
    [...candidates.values()].map(({ key }) => key),
  );
  const existingKeys = new Set<string>();
  for (const row of existing) {
    const digest = Buffer.from(row.install_key).toString("hex");
    const candidate = candidates.get(digest);
    if (!candidate || candidate.installId !== row.install_id)
      throw new DatabasePluginInputError("invalid-result");
    if (
      row.event_id !== null ||
      row.received_at_ms !== null ||
      row.event_order !== null ||
      row.event_json !== null
    )
      throw new DatabasePluginInputError("invalid-result");
    if (existingKeys.has(digest))
      throw new DatabasePluginInputError("invalid-result");
    existingKeys.add(digest);
  }
  const missing = [...candidates.entries()]
    .filter(([digest]) => !existingKeys.has(digest))
    .map(([, candidate]) => ({ ...candidate, event: null }));
  await insertSearchRows(client, provider, job.id, missing);
  return missing.length;
};

const latestBatch = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  job: SearchJob,
  events: readonly BundleEventRow[],
): Promise<void> => {
  const candidates = new Map<
    string,
    { readonly key: Buffer; readonly event: BundleEventRow }
  >();
  for (const event of events) {
    const key = prismaInsightsInstallKey(event.install_id);
    const digest = key.toString("hex");
    const current = candidates.get(digest);
    if (current && current.event.install_id !== event.install_id)
      throw new DatabasePluginInputError("invalid-result");
    if (
      !current ||
      current.event.received_at_ms < event.received_at_ms ||
      (current.event.received_at_ms === event.received_at_ms &&
        current.event.id < event.id)
    )
      candidates.set(digest, { key, event });
  }
  const existing = await readSearchRows(
    client,
    provider,
    job.id,
    [...candidates.values()].map(({ key }) => key),
  );
  const updates: {
    readonly key: Buffer;
    readonly installId: string;
    readonly event: BundleEventRow;
  }[] = [];
  const existingKeys = new Set<string>();
  for (const row of existing) {
    const key = Buffer.from(row.install_key);
    const digest = key.toString("hex");
    const candidate = candidates.get(digest);
    if (!candidate || candidate.event.install_id !== row.install_id)
      throw new DatabasePluginInputError("invalid-result");
    if (existingKeys.has(digest))
      throw new DatabasePluginInputError("invalid-result");
    existingKeys.add(digest);
    if (row.event_id !== null) {
      if (
        row.received_at_ms === null ||
        row.event_order === null ||
        row.event_json === null ||
        !Buffer.from(row.event_order).equals(
          prismaInsightsEventOrder(row.event_id),
        )
      )
        throw new DatabasePluginInputError("invalid-result");
      const stored = parsePrismaInsightsEventJson(row.event_json);
      if (stored.id !== row.event_id || stored.install_id !== row.install_id)
        throw new DatabasePluginInputError("invalid-result");
      const receivedAtMs = prismaInsightsSafeInteger(row.received_at_ms);
      if (
        receivedAtMs > candidate.event.received_at_ms ||
        (receivedAtMs === candidate.event.received_at_ms &&
          row.event_id >= candidate.event.id)
      )
        continue;
    } else if (
      row.received_at_ms !== null ||
      row.event_order !== null ||
      row.event_json !== null
    ) {
      throw new DatabasePluginInputError("invalid-result");
    }
    updates.push({
      key,
      installId: row.install_id,
      event: candidate.event,
    });
  }
  if (updates.length === 0) return;
  const sql = new PrismaInsightsSql(provider);
  const jobFilter = sql.value(job.id);
  const keys = updates.map(({ key }) => sql.value(key)).join(",");
  const deleted = await executePrismaInsights(
    client,
    sql.statement(
      `delete from ${PRISMA_INSIGHTS_SEARCH_ROWS}
       where job_id=${jobFilter} and install_key in (${keys})`,
    ),
  );
  if (deleted !== updates.length)
    throw new DatabasePluginInputError("invalid-result");
  await insertSearchRows(client, provider, job.id, updates);
};

export interface PrismaInsightsSearchStepInput {
  readonly maxItems: number;
  readonly maxRequests: number;
  readonly jobId?: string;
}

export const runPrismaInsightsSearchStep = (
  client: PrismaInsightsClient,
  provider: ORMSQLProvider,
  input: PrismaInsightsSearchStepInput,
): Promise<{ readonly processed: number; readonly jobId: string | null }> => {
  if (
    !Number.isSafeInteger(input.maxItems) ||
    input.maxItems < 1 ||
    input.maxItems > INSIGHTS_MAINTENANCE_MAX_ITEMS ||
    !Number.isSafeInteger(input.maxRequests) ||
    input.maxRequests < 1 ||
    input.maxRequests > INSIGHTS_MAINTENANCE_MAX_REQUESTS ||
    (input.jobId !== undefined &&
      (typeof input.jobId !== "string" || input.jobId.length === 0))
  )
    throw new DatabasePluginInputError("invalid-query");
  if (input.maxRequests < 8)
    return Promise.resolve({ processed: 0, jobId: null });
  const capacity = Math.min(200, input.maxItems);
  return runPrismaInsightsTransaction(client, provider, async (transaction) => {
    const jobs = await selectPrismaInsightsRows<SearchJob>(
      transaction,
      provider,
      {
        table: PRISMA_INSIGHTS_SEARCH_JOBS,
        columns: searchJobColumns,
        where: {
          state: "queued",
          ...(input.jobId === undefined ? {} : { id: input.jobId }),
        },
        orderBy: [{ column: "id", direction: "asc" }],
        limit: 1,
        lock: "skip-locked",
      },
    );
    const selected =
      jobs[0] ??
      (
        await selectPrismaInsightsRows<SearchJob>(transaction, provider, {
          table: PRISMA_INSIGHTS_SEARCH_JOBS,
          columns: searchJobColumns,
          where: {
            state: "preparing",
            ...(input.jobId === undefined ? {} : { id: input.jobId }),
          },
          orderBy: [{ column: "id", direction: "asc" }],
          limit: 1,
          lock: "skip-locked",
        })
      )[0];
    if (!selected) return { processed: 0, jobId: null };
    const leaseVersion = prismaInsightsSafeInteger(selected.lease_version);
    const leaseOwner = newPrismaInsightsId();
    const claimed = await updatePrismaInsightsRows(
      transaction,
      provider,
      PRISMA_INSIGHTS_SEARCH_JOBS,
      {
        state: "preparing",
        lease_owner: leaseOwner,
        lease_version: leaseVersion + 1,
      },
      {
        id: selected.id,
        state: selected.state,
        lease_version: leaseVersion,
      },
    );
    if (claimed !== 1) return { processed: 0, jobId: null };
    const job: SearchJob = {
      ...selected,
      state: "preparing",
      lease_owner: leaseOwner,
      lease_version: leaseVersion + 1,
    };
    try {
      const rows = await readSourcePage(transaction, provider, job, capacity);
      const accepted: SourceRow[] = [];
      for (const row of rows) {
        const normalized = {
          source_generation: prismaInsightsSafeInteger(row.source_generation),
          event_json: row.event_json,
        };
        const next = [...accepted, normalized];
        if (
          getCanonicalInsightsJsonByteLength(next) >
          INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES
        )
          break;
        accepted.push(normalized);
      }
      if (rows.length > 0 && accepted.length === 0)
        throw new DatabasePluginInputError("invalid-result");
      const query = parseJobQuery(job);
      const events = accepted.map((source) =>
        parsePrismaInsightsEventJson(source.event_json),
      );
      const newMemberships =
        job.phase === "membership"
          ? await membershipBatch(transaction, provider, job, query, events)
          : 0;
      if (job.phase === "latest")
        await latestBatch(transaction, provider, job, events);
      const last = accepted.at(-1);
      const exhausted =
        accepted.length === rows.length && rows.length < capacity;
      if (last && (!exhausted || job.phase === "latest")) {
        const changed = await updatePrismaInsightsRows(
          transaction,
          provider,
          PRISMA_INSIGHTS_SEARCH_JOBS,
          {
            state: "preparing",
            after_generation: prismaInsightsSafeInteger(last.source_generation),
            ...(job.phase === "membership"
              ? {
                  total: prismaInsightsSafeInteger(job.total) + newMemberships,
                }
              : {}),
          },
          searchJobFence(job),
        );
        if (changed !== 1) throw new DatabasePluginInputError("invalid-result");
        return { processed: accepted.length, jobId: job.id };
      }
      if (job.phase === "membership") {
        const changed = await updatePrismaInsightsRows(
          transaction,
          provider,
          PRISMA_INSIGHTS_SEARCH_JOBS,
          {
            state: "preparing",
            phase: "latest",
            after_generation: 0,
            total: prismaInsightsSafeInteger(job.total) + newMemberships,
          },
          searchJobFence(job),
        );
        if (changed !== 1) throw new DatabasePluginInputError("invalid-result");
        return { processed: accepted.length, jobId: job.id };
      }
      const total = prismaInsightsSafeInteger(job.total);
      const completedAtMs = await readPrismaInsightsDatabaseTime(
        transaction,
        provider,
      );
      const changed = await updatePrismaInsightsRows(
        transaction,
        provider,
        PRISMA_INSIGHTS_SEARCH_JOBS,
        { state: "ready", completed_at_ms: completedAtMs, total },
        { ...searchJobFence(job), state: "preparing" },
      );
      if (changed !== 1) throw new DatabasePluginInputError("invalid-result");
      const headChanged = await updatePrismaInsightsRows(
        transaction,
        provider,
        PRISMA_INSIGHTS_SEARCH_HEADS,
        { active_job_id: null, publication_job_id: job.id },
        { query_key: Buffer.from(job.query_key), active_job_id: job.id },
      );
      if (headChanged !== 1)
        throw new DatabasePluginInputError("invalid-result");
      return { processed: accepted.length, jobId: job.id };
    } catch (error) {
      if (!(error instanceof DatabasePluginInputError)) throw error;
      const failed = await updatePrismaInsightsRows(
        transaction,
        provider,
        PRISMA_INSIGHTS_SEARCH_JOBS,
        {
          state: "failed",
          failure_json: canonicalInsightsJson({ code: "invalid-source" }),
        },
        searchJobFence(job),
      );
      if (failed !== 1) throw error;
      return { processed: 0, jobId: job.id };
    }
  });
};
