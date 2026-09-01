import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
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
  createInsightsEventPageCursor,
  createInsightsReportPageCursor,
  InsightsContractError,
  isCanonicalInsightsEventId,
  readInsightsInstallationPageInput,
  readInsightsPageEventsInput,
  readInsightsReportPageInput,
  readInsightsReportPageQuery,
  type DatabasePluginImplementation,
  type RequiredInsightsModel,
} from "@hot-updater/plugin-core/internal";
import type { Kysely } from "kysely";

import { createPostgresInsightsEventQueries } from "./postgresInsights";
import { fitPostgresInsightsPage } from "./postgresInsightsContract";
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
import {
  createPostgresInsightsSearchPageCursor,
  createPostgresInsightsSearchPages,
} from "./postgresInsightsSearchPages";
import { readPostgresInsightsSourceGeneration } from "./postgresInsightsSource";
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

const sourceIdentity = (sourceGeneration: string): string => {
  let value: unknown;
  try {
    value = JSON.parse(sourceGeneration);
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value[0] !== 1 ||
    typeof value[1] !== "string" ||
    !uuid.test(value[1])
  )
    throw new DatabasePluginInputError("invalid-result");
  return value[1];
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

const legacyEventInput = (
  input: InsightsPageEventsInput,
  cursor?: Pick<RequiredEventCursor, "receivedAtMs" | "id">,
) => {
  const base = {
    scope:
      input.selector.kind === "all"
        ? ({ kind: "all" } as const)
        : input.selector.kind === "installationId"
          ? ({
              kind: "installation" as const,
              installId: input.selector.installId,
            } as const)
          : ({
              kind: "bundle" as const,
              bundleId: input.selector.bundleId,
            } as const),
    ...(input.sinceReceivedAtMs === undefined
      ? {}
      : { sinceReceivedAtMs: input.sinceReceivedAtMs }),
    beforeReceivedAtMs: input.beforeReceivedAtMs,
    limit: input.limit,
  };
  return cursor === undefined
    ? base
    : {
        ...base,
        cursor: createInsightsEventPageCursor(base, cursor),
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
): InsightsReportResult => {
  if (result.state === "ready") {
    const generation = result.publication.sourceGeneration;
    return {
      state: "ready",
      versions: projectedVersions(generation, generation),
      data: result.publication,
    };
  }
  if (result.state === "failed") {
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
    return {
      state: "stale",
      versions: projectedVersions(generation, generation),
      data: result.previous,
      refresh: { id: result.jobId },
    };
  }
  return {
    state: "preparing",
    versions: reservedVersions(result.sourceGeneration),
    job: { id: result.jobId },
  };
};

/** PostgreSQL's sole internal implementation of the required Insights port. */
export const createPostgresInsightsQueries = (
  db: Kysely<Database>,
  implementation: DatabasePluginImplementation,
  databaseNamespace: string,
): RequiredInsightsModel => {
  if (!uuid.test(databaseNamespace))
    throw new DatabasePluginInputError("invalid-query");
  const search = createPostgresInsightsSearchPages(db, databaseNamespace);
  const jobs = createPostgresInsightsJobs(db);
  const reports = createPostgresInsightsReportPages(db, databaseNamespace);

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
        const sourceId = sourceIdentity(generation);
        if (sourceId !== databaseNamespace)
          throw new DatabasePluginInputError("invalid-result");
        const legacy = legacyEventInput(input, cursor);
        let page: Awaited<
          ReturnType<
            ReturnType<typeof createPostgresInsightsEventQueries>["page"]
          >
        >;
        try {
          page = await createPostgresInsightsEventQueries(
            transaction,
            implementation,
          ).page(legacy);
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
              last !== undefined && (shortened || page.nextCursor !== null)
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
                  sourceIdentity(publication.sourceGeneration),
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
                sourceIdentity(generation!),
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
          const sourceId = sourceIdentity(generation);
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
      return mapReportResult(await jobs.getReport(input));
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
      if (sourceIdentity(generation) !== databaseNamespace)
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
    append: implementation.appendBundleEvent,
    pageEvents,
    pageInstallations,
    getReport,
    pageReport,
  };
};
