import { createHash } from "node:crypto";

import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type InsightsInstallationRow,
} from "@hot-updater/plugin-core";
import { INSIGHTS_PAGE_MAX_ROWS } from "@hot-updater/plugin-core/internal";
import type { Kysely } from "kysely";

import { fitPostgresInsightsInternalPage } from "./postgresInsightsContract";
import type {
  PostgresInsightsInstallationPage,
  PostgresInsightsInstallationPageInput,
} from "./postgresInsightsInternalTypes";
import {
  createPostgresInsightsJobs,
  normalizePostgresInsightsSearchQuery,
  readPostgresInsightsSearchPublication,
} from "./postgresInsightsJobs";
import { readPostgresInsightsLatestByKey } from "./postgresInsightsReportData";
import {
  getPostgresInsightsReportOrderReady,
  readPostgresInsightsReportOrderRange,
} from "./postgresInsightsReportOrder";

type Input = Extract<
  PostgresInsightsInstallationPageInput,
  { kind: "contains" | "userId" }
>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const decimal = /^(0|[1-9][0-9]{0,18})$/;
const maximum = 9_223_372_036_854_775_807n;
const section = { section: "installationIds" } as const;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const invalid = (): never => {
  throw new DatabasePluginInputError("invalid-query");
};
const invalidResult = (): never => {
  throw new DatabasePluginInputError("invalid-result");
};
const sourceIdentity = (generation: string): string => {
  let value: unknown;
  try {
    value = JSON.parse(generation);
  } catch {
    return invalidResult();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value[0] !== 1 ||
    typeof value[1] !== "string" ||
    !uuid.test(value[1])
  )
    return invalidResult();
  return value[1];
};
const parse = (input: Input) => {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) =>
        ![
          "kind",
          "query",
          "userId",
          "limit",
          "cursor",
          "publicationId",
          "minAsOfMs",
        ].includes(key),
    ) ||
    !["contains", "userId"].includes(input.kind) ||
    (input.kind === "contains"
      ? typeof input.query !== "string" || input.query.length === 0
      : typeof input.userId !== "string") ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > INSIGHTS_PAGE_MAX_ROWS ||
    (input.publicationId !== undefined &&
      (typeof input.publicationId !== "string" ||
        !uuid.test(input.publicationId))) ||
    (input.minAsOfMs !== undefined &&
      (!Number.isSafeInteger(input.minAsOfMs) || input.minAsOfMs < 0))
  )
    return invalid();
  const query =
    input.kind === "contains"
      ? normalizePostgresInsightsSearchQuery(input.query)
      : input.userId;
  const queryKey = hash(JSON.stringify([2, input.kind, query]));
  let publicationId = input.publicationId;
  let ordinal = 0n;
  let cursorSourceId: string | undefined;
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string" || input.cursor.length > 512)
      return invalid();
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
      value[1] !== "snapshot" ||
      typeof value[2] !== "string" ||
      !uuid.test(value[2]) ||
      typeof value[3] !== "string" ||
      !uuid.test(value[3]) ||
      value[4] !== queryKey ||
      typeof value[5] !== "string" ||
      !decimal.test(value[5]) ||
      BigInt(value[5]) > maximum ||
      (publicationId !== undefined && publicationId !== value[3])
    )
      return invalid();
    cursorSourceId = value[2];
    publicationId = value[3];
    ordinal = BigInt(value[5]);
  }
  return { query, queryKey, publicationId, ordinal, cursorSourceId };
};

export const createPostgresInsightsSearchPageCursor = (
  input: Input,
  publicationId: string | undefined,
  emittedRows: number,
  sourceId: string,
): string => {
  const parsed = parse({
    ...input,
    ...(publicationId === undefined ? {} : { publicationId }),
  });
  const pinnedId = publicationId ?? parsed.publicationId;
  if (pinnedId === undefined) return invalid();
  if (!uuid.test(sourceId)) return invalidResult();
  return JSON.stringify([
    1,
    "snapshot",
    sourceId,
    pinnedId,
    parsed.queryKey,
    (parsed.ordinal + BigInt(emittedRows)).toString(),
  ]);
};

/** Contains only; live all/exact installation pages use a separate projection. */
export const createPostgresInsightsSearchPages = <TDatabase extends object>(
  db: Kysely<TDatabase>,
  databaseNamespace: string,
) => {
  if (!uuid.test(databaseNamespace))
    throw new DatabasePluginInputError("invalid-query");
  const jobs = createPostgresInsightsJobs(db);
  return {
    async pageContains(
      input: Input,
    ): Promise<PostgresInsightsInstallationPage> {
      const parsed = parse(input);
      if (
        parsed.cursorSourceId !== undefined &&
        parsed.cursorSourceId !== databaseNamespace
      )
        return invalid();
      let publicationId = parsed.publicationId;
      if (publicationId === undefined) {
        const result = await jobs.getSearch({
          kind: input.kind,
          query: parsed.query,
          ...(input.minAsOfMs === undefined
            ? {}
            : { minAsOfMs: input.minAsOfMs }),
        });
        if (result.state !== "ready") return result;
        publicationId = result.publication.id;
      }
      const pinnedId = publicationId;
      return db
        .transaction()
        .setIsolationLevel("repeatable read")
        .setAccessMode("read only")
        .execute(
          async (transaction): Promise<PostgresInsightsInstallationPage> => {
            let result: Awaited<
              ReturnType<typeof readPostgresInsightsSearchPublication>
            >;
            try {
              result = await readPostgresInsightsSearchPublication(
                transaction,
                pinnedId,
                input.kind,
                parsed.query,
              );
            } catch (error) {
              if (error instanceof InsightsQueryNotReadyError)
                return { state: "expired", publicationId: pinnedId };
              throw error;
            }
            if (result === null)
              return { state: "expired", publicationId: pinnedId };
            const { job, publication } = result;
            if (
              sourceIdentity(publication.sourceGeneration) !== databaseNamespace
            )
              return invalidResult();
            if (
              input.minAsOfMs !== undefined &&
              publication.asOfMs < input.minAsOfMs
            )
              return { state: "expired", publicationId: pinnedId };
            if (parsed.ordinal > BigInt(publication.total)) return invalid();
            const ready = await getPostgresInsightsReportOrderReady(
              transaction,
              pinnedId,
              section,
            );
            if (ready === null || ready.totalRows !== String(publication.total))
              return invalidResult();
            const ordered = await readPostgresInsightsReportOrderRange(
              transaction,
              pinnedId,
              section,
              ready.pass,
              parsed.ordinal.toString(),
              input.limit,
            );
            const keys = ordered.map((row) => hash(JSON.stringify(row.label)));
            const latest = await readPostgresInsightsLatestByKey(
              transaction,
              job.baseJobId,
              keys,
            );
            if (latest.length !== ordered.length) return invalidResult();
            const rows = latest.map(
              ({ event }, index): InsightsInstallationRow => {
                if (event.install_id !== ordered[index]!.label)
                  return invalidResult();
                const {
                  id,
                  install_id,
                  user_id,
                  username,
                  to_bundle_id,
                  type,
                  platform,
                  app_version,
                  channel,
                  cohort,
                  received_at_ms,
                } = event;
                return {
                  id,
                  install_id,
                  user_id,
                  username,
                  to_bundle_id,
                  type,
                  platform,
                  app_version,
                  channel,
                  cohort,
                  received_at_ms,
                };
              },
            );
            return fitPostgresInsightsInternalPage(rows, (pageRows) => {
              const next = parsed.ordinal + BigInt(pageRows.length);
              return {
                state: "ready" as const,
                consistency: "snapshot" as const,
                publication,
                rows: pageRows,
                nextCursor:
                  next === BigInt(publication.total)
                    ? null
                    : JSON.stringify([
                        1,
                        "snapshot",
                        databaseNamespace,
                        pinnedId,
                        parsed.queryKey,
                        next.toString(),
                      ]),
              };
            });
          },
        );
    },
  };
};
