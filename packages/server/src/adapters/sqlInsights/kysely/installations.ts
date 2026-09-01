import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type InsightsInstallationPage,
  type InsightsInstallationPageInput,
  type InsightsInstallationRow,
  type InsightsProjectedReadVersions,
  type InsightsPublication,
} from "@hot-updater/plugin-core";
import {
  assertInsightsCursorContract,
  assertInsightsPageContract,
  getCanonicalInsightsJsonByteLength,
  INSIGHTS_PAGE_MAX_BYTES,
  readInsightsInstallationPageInput,
} from "@hot-updater/plugin-core/internal";
import { sql, type Kysely, type QueryExecutorProvider } from "kysely";

import type { SQLProvider as KyselySQLProvider } from "../../kysely";
import { KYSELY_INSIGHTS_ALIAS_WORK_ROWS, tables } from "./constants";
import { readKyselyInsightsState } from "./source";
import {
  executeSerializable,
  insertIgnore,
  installationKey,
  lockRow,
  newOpaqueId,
  readRawEvent,
  sha256Hex,
  toSafeInteger,
} from "./utils";

type LiveRow = {
  install_key: string;
  install_id: string;
  raw_json: string | null;
  first_source_seq?: unknown;
};

type SearchJob = {
  id: string;
  query_hash: string;
  normalized_json: string;
  state: "queued" | "preparing" | "ready" | "failed";
  source_id: string;
  source_upper: unknown;
  as_of_ms: unknown;
  completed_at_ms: unknown | null;
  after_source_seq: unknown;
  after_install_key: string | null;
  after_alias_kind: string | null;
  after_alias_hash: string | null;
  total: unknown | null;
};

type AliasRow = {
  install_key: string;
  install_id: string;
  alias_kind: string;
  alias_hash: string;
  value_json: string;
  normalized_json: string;
  source_seq: unknown;
};

const sourceGeneration = (sourceId: string, upper: number): string =>
  JSON.stringify(["kysely-insights-1", sourceId, upper]);

const versions = (
  sourceId: string,
  upper: number,
  projectionGeneration: string,
): InsightsProjectedReadVersions => ({
  schemaVersion: "1.0.0",
  storageVersion: "kysely-insights-1",
  projectionGeneration,
  sourceGeneration: sourceGeneration(sourceId, upper),
});

const installationRow = async (
  row: LiveRow,
): Promise<InsightsInstallationRow> => {
  if (row.raw_json === null) {
    throw new DatabasePluginInputError("invalid-result");
  }
  const event = readRawEvent(row.raw_json);
  if (
    event.install_id !== row.install_id ||
    (await installationKey(event.install_id)) !== row.install_key
  ) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return {
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
  };
};

const readCursor = (
  input: InsightsInstallationPageInput,
  identity: string,
): string | null => {
  if (input.cursor === undefined) return null;
  assertInsightsCursorContract(input.cursor);
  let value: unknown;
  try {
    value = JSON.parse(input.cursor);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value[0] !== 1 ||
    value[1] !== identity ||
    typeof value[2] !== "string" ||
    !/^[0-9a-f]{64}$/.test(value[2])
  ) {
    throw new DatabasePluginInputError("invalid-query");
  }
  return value[2];
};

const makeCursor = (identity: string, installKey: string): string =>
  JSON.stringify([1, identity, installKey]);

const readPublishedCursorJobId = (
  input: Extract<
    InsightsInstallationPageInput,
    { kind: "contains" | "userId" }
  >,
  queryHash: string,
): { readonly jobId: string; readonly sourceId: string } | undefined => {
  if (input.cursor === undefined) return undefined;
  assertInsightsCursorContract(input.cursor);
  let outer: unknown;
  let identity: unknown;
  try {
    outer = JSON.parse(input.cursor);
    if (!Array.isArray(outer) || typeof outer[1] !== "string") throw null;
    identity = JSON.parse(outer[1]);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
  if (
    !Array.isArray(outer) ||
    outer.length !== 3 ||
    outer[0] !== 1 ||
    !Array.isArray(identity) ||
    identity.length !== 4 ||
    identity[0] !== "published" ||
    identity[1] !== queryHash ||
    typeof identity[2] !== "string" ||
    typeof identity[3] !== "string" ||
    typeof outer[2] !== "string" ||
    !/^[0-9a-f]{64}$/.test(outer[2])
  ) {
    throw new DatabasePluginInputError("invalid-query");
  }
  return { sourceId: identity[2], jobId: identity[3] };
};

const fitRows = <T>(
  candidates: readonly { readonly key: string; readonly value: T | null }[],
  limit: number,
  cursorFor: (installKey: string) => string,
  buildResult: (rows: readonly T[], nextCursor: string | null) => unknown,
): { rows: readonly T[]; nextCursor: string | null } => {
  const rows: { readonly key: string; readonly value: T }[] = [];
  let lastScannedKey: string | undefined;
  let scannedCount = 0;
  for (const [index, row] of candidates.slice(0, limit).entries()) {
    const candidate =
      row.value === null ? rows : [...rows, { key: row.key, value: row.value }];
    const cursor = index + 1 < candidates.length ? cursorFor(row.key) : null;
    if (
      row.value !== null &&
      getCanonicalInsightsJsonByteLength(
        buildResult(
          candidate.map(({ value }) => value),
          cursor,
        ),
      ) > INSIGHTS_PAGE_MAX_BYTES
    ) {
      break;
    }
    if (row.value !== null) rows.push({ key: row.key, value: row.value });
    lastScannedKey = row.key;
    scannedCount += 1;
  }
  return {
    rows: rows.map(({ value }) => value),
    nextCursor:
      lastScannedKey && scannedCount < candidates.length
        ? cursorFor(lastScannedKey)
        : null,
  };
};

const readLatestAt = async (
  db: QueryExecutorProvider,
  key: string,
  installId: string,
  upper: number,
): Promise<LiveRow> => {
  const result = await sql<LiveRow>`select install_key, install_id, raw_json
    from ${sql.table(tables.liveVersions)} where install_key = ${key}
      and source_seq <= ${upper} order by source_seq desc limit 1`.execute(db);
  const row = result.rows[0];
  if (!row || row.install_id !== installId) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return row;
};

const pageLive = async (
  db: QueryExecutorProvider,
  input: Extract<
    InsightsInstallationPageInput,
    { kind: "all" | "installationId" }
  >,
): Promise<InsightsInstallationPage> => {
  if (input.kind === "installationId" && input.cursor !== undefined) {
    throw new DatabasePluginInputError("invalid-query");
  }
  const requestedInstallId =
    input.kind === "installationId" ? input.installId : null;
  let cursorSource: { sourceId: string; upper: number } | undefined;
  if (input.cursor !== undefined) {
    assertInsightsCursorContract(input.cursor);
    let storedIdentity: unknown;
    try {
      const outer: unknown = JSON.parse(input.cursor);
      if (!Array.isArray(outer) || typeof outer[1] !== "string") throw null;
      storedIdentity = JSON.parse(outer[1]);
    } catch {
      throw new DatabasePluginInputError("invalid-query");
    }
    if (
      !Array.isArray(storedIdentity) ||
      storedIdentity.length !== 6 ||
      storedIdentity[0] !== "live" ||
      storedIdentity[1] !== input.kind ||
      storedIdentity[2] !== requestedInstallId ||
      typeof storedIdentity[3] !== "string" ||
      !Number.isSafeInteger(storedIdentity[4]) ||
      storedIdentity[4] < 0 ||
      storedIdentity[5] !== 1
    ) {
      throw new DatabasePluginInputError("invalid-query");
    }
    cursorSource = {
      sourceId: storedIdentity[3],
      upper: storedIdentity[4],
    };
  }
  const currentSource = await readKyselyInsightsState(db);
  if (
    cursorSource &&
    (cursorSource.sourceId !== currentSource.sourceId ||
      cursorSource.upper > currentSource.upper)
  ) {
    throw new DatabasePluginInputError("invalid-query");
  }
  const source = cursorSource ?? currentSource;
  const identity = JSON.stringify([
    "live",
    input.kind,
    requestedInstallId,
    source.sourceId,
    source.upper,
    1,
  ]);
  const after = readCursor(input, identity);
  let stored: readonly LiveRow[];
  if (input.kind === "installationId") {
    if (after !== null) {
      stored = [];
    } else {
      const key = await installationKey(input.installId);
      const result = await sql<LiveRow>`select install_key, install_id,
        raw_json, first_source_seq
      from ${sql.table(tables.live)} where install_key = ${key}
        and first_source_seq <= ${source.upper}`.execute(db);
      const live = result.rows[0];
      if (live && live.install_id !== input.installId) {
        throw new DatabasePluginInputError("invalid-result");
      }
      stored = live
        ? [await readLatestAt(db, key, input.installId, source.upper)]
        : [];
    }
  } else {
    const result = await sql<LiveRow>`select install_key, install_id,
        first_source_seq,
        (select e.raw_json from ${sql.table(tables.liveVersions)} e
          where e.install_key = l.install_key and e.source_seq <= ${source.upper}
          order by e.source_seq desc limit 1) as raw_json
      from ${sql.table(tables.live)} l
      where ${after ? sql`install_key > ${after}` : sql`1 = 1`}
      order by install_key asc limit ${input.limit + 1}`.execute(db);
    stored = result.rows;
  }
  const candidates = await Promise.all(
    stored.map(async (row) => ({
      key: row.install_key,
      value:
        row.first_source_seq === undefined ||
        toSafeInteger(row.first_source_seq) <= source.upper
          ? await installationRow(row)
          : null,
    })),
  );
  const observedAtMs = Date.now();
  const currentGeneration = sourceGeneration(source.sourceId, source.upper);
  const readVersions = versions(
    source.sourceId,
    source.upper,
    currentGeneration,
  );
  const buildResult = (
    rows: readonly InsightsInstallationRow[],
    nextCursor: string | null,
  ) => ({
    state: "ready" as const,
    versions: readVersions,
    data: {
      data: rows,
      nextCursor,
      hasNext: nextCursor !== null,
      consistency: {
        kind: "live" as const,
        cutoff: {
          kind: "projection" as const,
          observedAtMs,
          projectionGeneration: readVersions.sourceGeneration,
        },
      },
      total: { state: "unavailable" as const },
    },
  });
  const fitted = fitRows(
    candidates,
    input.limit,
    (key) => makeCursor(identity, key),
    buildResult,
  );
  const result = buildResult(fitted.rows, fitted.nextCursor);
  assertInsightsPageContract(result, input.limit);
  return result;
};

type SearchDescriptor =
  | { readonly kind: "contains"; readonly normalized: string }
  | { readonly kind: "userId"; readonly userId: string };

const searchDescriptor = (
  input: Extract<
    InsightsInstallationPageInput,
    { kind: "contains" | "userId" }
  >,
): { descriptor: SearchDescriptor; hash: string } => {
  const descriptor: SearchDescriptor =
    input.kind === "contains"
      ? { kind: "contains", normalized: input.query.toLowerCase() }
      : { kind: "userId", userId: input.userId };
  if (
    (descriptor.kind === "contains" && descriptor.normalized.length === 0) ||
    (descriptor.kind === "userId" && descriptor.userId.length > 1024)
  ) {
    throw new DatabasePluginInputError("invalid-query");
  }
  return {
    descriptor,
    hash: sha256Hex(JSON.stringify([1, descriptor])),
  };
};

const parseSearchJob = (row: SearchJob | undefined): SearchJob => {
  if (!row) throw new DatabasePluginInputError("invalid-result");
  return row;
};

const reserveSearch = async <TDatabase>(
  db: Kysely<TDatabase>,
  provider: KyselySQLProvider,
  descriptor: SearchDescriptor,
  hash: string,
  minAsOfMs: number | undefined,
): Promise<{ job: SearchJob; previous: SearchJob | null }> =>
  executeSerializable(db, provider, async (transaction) => {
    await insertIgnore(transaction, provider, tables.searchHeads, {
      query_hash: hash,
      normalized_json: JSON.stringify(descriptor),
      active_job_id: null,
      publication_job_id: null,
      failed_job_id: null,
    });
    await lockRow(
      transaction,
      provider,
      tables.searchHeads,
      "query_hash",
      hash,
    );
    const head = await sql<{
      active_job_id: string | null;
      publication_job_id: string | null;
      failed_job_id: string | null;
    }>`select active_job_id, publication_job_id, failed_job_id from ${sql.table(
      tables.searchHeads,
    )} where query_hash = ${hash}`.execute(transaction);
    const publicationId = head.rows[0]?.publication_job_id;
    if (publicationId) {
      const published = await sql<SearchJob>`select * from ${sql.table(
        tables.searchJobs,
      )} where id = ${publicationId}`.execute(transaction);
      const job = parseSearchJob(published.rows[0]);
      if (minAsOfMs === undefined || toSafeInteger(job.as_of_ms) >= minAsOfMs) {
        return { job, previous: null };
      }
    }
    let previous: SearchJob | null = null;
    if (publicationId) {
      const published = await sql<SearchJob>`select * from ${sql.table(
        tables.searchJobs,
      )} where id = ${publicationId}`.execute(transaction);
      previous = parseSearchJob(published.rows[0]);
    }
    const activeId = head.rows[0]?.active_job_id;
    if (activeId) {
      const active = await sql<SearchJob>`select * from ${sql.table(
        tables.searchJobs,
      )} where id = ${activeId}`.execute(transaction);
      return { job: parseSearchJob(active.rows[0]), previous };
    }
    const failedId = head.rows[0]?.failed_job_id;
    if (failedId) {
      const failed = await sql<SearchJob>`select * from ${sql.table(
        tables.searchJobs,
      )} where id = ${failedId}`.execute(transaction);
      return { job: parseSearchJob(failed.rows[0]), previous };
    }
    const id = newOpaqueId();
    const asOfMs = Date.now();
    const source = await readKyselyInsightsState(transaction);
    await sql`insert into ${sql.table(tables.searchJobs)}
      (id, query_hash, normalized_json, state, source_id, source_upper,
        as_of_ms, completed_at_ms, after_source_seq, after_install_key,
        after_alias_kind, after_alias_hash, total, failure_json)
      values (${id}, ${hash}, ${JSON.stringify(descriptor)}, 'queued',
        ${source.sourceId}, ${source.upper}, ${asOfMs}, null, 0, null, null,
        null, 0, null)`.execute(transaction);
    await sql`update ${sql.table(tables.searchHeads)} set active_job_id = ${id}
      where query_hash = ${hash} and active_job_id is null`.execute(
      transaction,
    );
    const created = await sql<SearchJob>`select * from ${sql.table(
      tables.searchJobs,
    )} where id = ${id}`.execute(transaction);
    return { job: parseSearchJob(created.rows[0]), previous };
  });

const matchesAlias = (
  descriptor: SearchDescriptor,
  alias: AliasRow,
): boolean => {
  try {
    if (descriptor.kind === "contains") {
      const normalized = JSON.parse(alias.normalized_json);
      return (
        typeof normalized === "string" &&
        normalized.includes(descriptor.normalized)
      );
    }
    if (alias.alias_kind !== "user") return false;
    return JSON.parse(alias.value_json) === descriptor.userId;
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
};

export const stepKyselyInsightsSearch = async <TDatabase>(
  db: Kysely<TDatabase>,
  provider: KyselySQLProvider,
  jobId: string,
  limit = KYSELY_INSIGHTS_ALIAS_WORK_ROWS,
): Promise<{
  readonly job: SearchJob;
  readonly advanced: boolean;
  readonly processed: number;
}> =>
  executeSerializable(db, provider, async (transaction) => {
    await lockRow(transaction, provider, tables.searchJobs, "id", jobId);
    const jobs = await sql<SearchJob>`select * from ${sql.table(
      tables.searchJobs,
    )} where id = ${jobId}`.execute(transaction);
    const job = parseSearchJob(jobs.rows[0]);
    if (job.state === "ready" || job.state === "failed") {
      return { job, advanced: false, processed: 0 };
    }
    const descriptor = JSON.parse(job.normalized_json) as SearchDescriptor;
    const afterSource = toSafeInteger(job.after_source_seq);
    const after = job.after_install_key
      ? sql`and (source_seq > ${afterSource}
          or (source_seq = ${afterSource} and install_key > ${job.after_install_key})
          or (source_seq = ${afterSource} and install_key = ${job.after_install_key}
            and alias_kind > ${job.after_alias_kind!})
          or (source_seq = ${afterSource} and install_key = ${job.after_install_key}
            and alias_kind = ${job.after_alias_kind!}
            and alias_hash > ${job.after_alias_hash!}))`
      : sql``;
    const aliases = await sql<AliasRow>`select install_key, install_id,
        alias_kind, alias_hash, value_json, normalized_json, source_seq
      from ${sql.table(tables.aliases)}
      where source_seq <= ${toSafeInteger(job.source_upper)} ${after}
      order by source_seq, install_key, alias_kind, alias_hash
      limit ${limit}`.execute(transaction);
    for (const alias of aliases.rows) {
      if (toSafeInteger(alias.source_seq) > toSafeInteger(job.source_upper)) {
        continue;
      }
      if (!matchesAlias(descriptor, alias)) continue;
      const latest = await readLatestAt(
        transaction,
        alias.install_key,
        alias.install_id,
        toSafeInteger(job.source_upper),
      );
      const existing = await sql`select install_key from ${sql.table(
        tables.searchRows,
      )} where job_id = ${job.id} and install_key = ${alias.install_key}`.execute(
        transaction,
      );
      if (existing.rows.length === 0) {
        await sql`insert into ${sql.table(tables.searchRows)}
          (job_id, install_key, install_id, raw_json)
          values (${job.id}, ${alias.install_key}, ${alias.install_id},
            ${latest.raw_json})`.execute(transaction);
        await sql`update ${sql.table(tables.searchJobs)} set total = total + 1
          where id = ${job.id}`.execute(transaction);
      }
    }
    const last = aliases.rows.at(-1);
    if (aliases.rows.length === limit && last) {
      await sql`update ${sql.table(tables.searchJobs)} set state = 'preparing',
          after_source_seq = ${toSafeInteger(last.source_seq)},
          after_install_key = ${last.install_key},
          after_alias_kind = ${last.alias_kind}, after_alias_hash = ${last.alias_hash}
        where id = ${job.id}`.execute(transaction);
    } else {
      const completedAtMs = Date.now();
      await sql`update ${sql.table(tables.searchJobs)} set state = 'ready',
          completed_at_ms = ${completedAtMs} where id = ${job.id}`.execute(
        transaction,
      );
      await sql`update ${sql.table(tables.searchHeads)}
        set active_job_id = null, publication_job_id = ${job.id},
          failed_job_id = null
        where query_hash = ${job.query_hash} and active_job_id = ${job.id}`.execute(
        transaction,
      );
    }
    const updated = await sql<SearchJob>`select * from ${sql.table(
      tables.searchJobs,
    )} where id = ${job.id}`.execute(transaction);
    return {
      job: parseSearchJob(updated.rows[0]),
      advanced: true,
      processed: aliases.rows.length,
    };
  });

export const failKyselyInsightsSearch = async <TDatabase>(
  db: Kysely<TDatabase>,
  provider: KyselySQLProvider,
  job: SearchJob,
): Promise<SearchJob> =>
  executeSerializable(db, provider, async (transaction) => {
    await lockRow(transaction, provider, tables.searchJobs, "id", job.id);
    await sql`update ${sql.table(tables.searchJobs)} set state = 'failed',
        failure_json = ${JSON.stringify({ code: "preparation-failed" })}
      where id = ${job.id} and state in ('queued', 'preparing')`.execute(
      transaction,
    );
    await sql`update ${sql.table(tables.searchHeads)} set active_job_id = null,
        failed_job_id = ${job.id}
      where query_hash = ${job.query_hash} and active_job_id = ${job.id}`.execute(
      transaction,
    );
    const result = await sql<SearchJob>`select * from ${sql.table(
      tables.searchJobs,
    )} where id = ${job.id}`.execute(transaction);
    return parseSearchJob(result.rows[0]);
  });

const publication = (job: SearchJob): InsightsPublication => ({
  id: job.id,
  asOfMs: toSafeInteger(job.as_of_ms),
  completedAtMs: toSafeInteger(job.completed_at_ms),
  sourceGeneration: JSON.stringify([
    "kysely-insights-1",
    job.source_id,
    toSafeInteger(job.source_upper),
  ]),
  accuracy: "exact",
});

const pagePublished = async <TDatabase>(
  db: Kysely<TDatabase>,
  provider: KyselySQLProvider,
  input: Extract<
    InsightsInstallationPageInput,
    { kind: "contains" | "userId" }
  >,
): Promise<InsightsInstallationPage> => {
  const query = searchDescriptor(input);
  const cursorPublication = readPublishedCursorJobId(input, query.hash);
  if (
    cursorPublication !== undefined &&
    input.publicationId !== undefined &&
    cursorPublication.jobId !== input.publicationId
  ) {
    throw new DatabasePluginInputError("invalid-query");
  }
  if (cursorPublication !== undefined) {
    const currentSource = await readKyselyInsightsState(db);
    if (cursorPublication.sourceId !== currentSource.sourceId) {
      throw new DatabasePluginInputError("invalid-query");
    }
  }
  const pinnedId = input.publicationId ?? cursorPublication?.jobId;
  let job: SearchJob;
  let previous: SearchJob | null = null;
  if (pinnedId !== undefined) {
    const result = await sql<SearchJob>`select * from ${sql.table(
      tables.searchJobs,
    )} where id = ${pinnedId} and query_hash = ${query.hash}`.execute(db);
    if (!result.rows[0]) {
      return { state: "expired", publicationId: pinnedId };
    }
    job = result.rows[0];
    if (
      (input.minAsOfMs !== undefined &&
        toSafeInteger(job.as_of_ms) < input.minAsOfMs) ||
      (job.state !== "ready" && job.state !== "failed")
    ) {
      return { state: "expired", publicationId: pinnedId };
    }
  } else {
    const reservation = await reserveSearch(
      db,
      provider,
      query.descriptor,
      query.hash,
      input.minAsOfMs,
    );
    job = reservation.job;
    previous = reservation.previous;
  }
  const readVersions = versions(
    job.source_id,
    toSafeInteger(job.source_upper),
    job.id,
  );
  if (job.state === "failed") {
    return {
      state: "failed",
      versions: readVersions,
      error: { code: "preparation-failed", jobId: job.id },
    };
  }
  if (job.state !== "ready" && previous === null) {
    return {
      state: "preparing",
      versions: readVersions,
      job: { id: job.id },
    };
  }
  const displayJob = job.state === "ready" ? job : previous!;
  const stale = job.state !== "ready";
  const displayVersions = versions(
    displayJob.source_id,
    toSafeInteger(displayJob.source_upper),
    displayJob.id,
  );
  const identity = JSON.stringify([
    "published",
    query.hash,
    displayJob.source_id,
    displayJob.id,
  ]);
  const after = readCursor(input, identity);
  const rows = await sql<LiveRow>`select install_key, install_id, raw_json
    from ${sql.table(tables.searchRows)} where job_id = ${displayJob.id}
      ${after ? sql`and install_key > ${after}` : sql``}
    order by install_key limit ${input.limit + 1}`.execute(db);
  const candidates = await Promise.all(
    rows.rows.map(async (row) => ({
      key: row.install_key,
      value: await installationRow(row),
    })),
  );
  const published = publication(displayJob);
  const buildResult = (
    values: readonly InsightsInstallationRow[],
    nextCursor: string | null,
  ) => ({
    state: "ready" as const,
    versions: displayVersions,
    data: {
      data: values,
      nextCursor,
      hasNext: nextCursor !== null,
      consistency: {
        kind: "snapshot" as const,
        cutoff: { kind: "publication" as const, publication: published },
      },
      total: {
        state: "exact" as const,
        value: toSafeInteger(displayJob.total),
        sourceGeneration: published.sourceGeneration,
      },
    },
  });
  const fitted = fitRows(
    candidates,
    input.limit,
    (key) => makeCursor(identity, key),
    buildResult,
  );
  const readyResult = buildResult(fitted.rows, fitted.nextCursor);
  const result = stale
    ? {
        ...readyResult,
        state: "stale" as const,
        refresh: { id: job.id },
      }
    : readyResult;
  assertInsightsPageContract(result, input.limit);
  return result;
};

export const pageKyselyInsightsInstallations = async <TDatabase>(
  db: Kysely<TDatabase>,
  provider: KyselySQLProvider,
  input: InsightsInstallationPageInput,
): Promise<InsightsInstallationPage> => {
  input = readInsightsInstallationPageInput(input);
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    throw new DatabasePluginInputError("invalid-query");
  }
  try {
    return input.kind === "all" || input.kind === "installationId"
      ? await pageLive(db, input)
      : await pagePublished(db, provider, input);
  } catch (error) {
    if (!(error instanceof InsightsQueryNotReadyError)) throw error;
    return {
      state: "failed",
      versions: {
        schemaVersion: "1.0.0",
        storageVersion: "kysely-insights-1",
        projectionGeneration: null,
        sourceGeneration: null,
      },
      error: { code: "source-not-ready" },
    };
  }
};
