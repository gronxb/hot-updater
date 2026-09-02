import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type InsightsReportPageInput,
} from "@hot-updater/plugin-core";
import {
  createInsightsReportPageCursor,
  createInsightsReportProjection,
  readInsightsReportPageQuery,
} from "@hot-updater/plugin-core/internal";
import type { Kysely } from "kysely";

import { fitPostgresInsightsInternalPage } from "./postgresInsightsContract";
import type { PostgresInsightsReportPage } from "./postgresInsightsInternalTypes";
import { readPostgresInsightsReportPublication } from "./postgresInsightsJobs";
import {
  assertPostgresInsightsReportDataIndexes,
  readPostgresInsightsFirstMovementBucket,
  readPostgresInsightsReportCounts,
} from "./postgresInsightsReportData";
import {
  getPostgresInsightsReportOrderReady,
  readPostgresInsightsReportOrderRange,
} from "./postgresInsightsReportOrder";

const invalid = (): never => {
  throw new DatabasePluginInputError("invalid-result");
};
const maxOrdinal = 9_223_372_036_854_775_807n;

/** Reads only immutable derived rows in one snapshot, including page metadata. */
export const createPostgresInsightsReportPages = <TDatabase extends object>(
  db: Kysely<TDatabase>,
  databaseNamespace: string,
) => {
  if (db.isTransaction) throw new DatabasePluginInputError("invalid-query");
  return {
    async pageReport(
      input: InsightsReportPageInput,
    ): Promise<PostgresInsightsReportPage> {
      const parsed = readInsightsReportPageQuery(input, databaseNamespace);
      const request = parsed.input;
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          request.publicationId,
        )
      )
        throw new DatabasePluginInputError("invalid-query");
      const start = BigInt(parsed.nextOrdinal);
      const result = await db
        .transaction()
        .setIsolationLevel("repeatable read")
        .setAccessMode("read only")
        .execute(async (transaction) => {
          const stored = await readPostgresInsightsReportPublication(
            transaction,
            request.publicationId,
            databaseNamespace,
          );
          if (stored === null)
            return {
              state: "expired" as const,
              publicationId: request.publicationId,
            };
          const { job } = stored;
          const base = { state: "ready" as const, publicationId: job.id };
          const window = createInsightsReportProjection(job.query, job.asOfMs);
          const page = (total: bigint) => {
            if (
              total < 0n ||
              total > maxOrdinal ||
              total > BigInt(Number.MAX_SAFE_INTEGER)
            )
              invalid();
            if (start > total)
              throw new DatabasePluginInputError("invalid-query");
            const size = Number(
              total - start < BigInt(request.limit)
                ? total - start
                : BigInt(request.limit),
            );
            const end = start + BigInt(size);
            return {
              size,
              total: Number(total),
              nextCursor:
                end < total
                  ? createInsightsReportPageCursor(
                      request,
                      end.toString(),
                      databaseNamespace,
                    )
                  : null,
            };
          };
          const requireKind = (
            ...kinds: readonly (typeof job.query.kind)[]
          ) => {
            if (!kinds.includes(job.query.kind))
              throw new DatabasePluginInputError("invalid-query");
          };
          switch (request.section) {
            case "movementCohorts":
            case "bundleDistribution": {
              if (request.section === "movementCohorts")
                requireKind("bundleDetail");
              else requireKind("installationOverview", "activeOverview");
              const section =
                request.section === "movementCohorts"
                  ? { section: request.section, metric: request.metric }
                  : { section: request.section };
              const ready = await getPostgresInsightsReportOrderReady(
                transaction,
                job.id,
                section,
              );
              if (ready === null) throw new InsightsQueryNotReadyError();
              const { size, total, nextCursor } = page(BigInt(ready.totalRows));
              const rows =
                size === 0
                  ? []
                  : await readPostgresInsightsReportOrderRange(
                      transaction,
                      job.id,
                      section,
                      ready.pass,
                      start.toString(),
                      size,
                    );
              return request.section === "movementCohorts"
                ? {
                    ...base,
                    section: request.section,
                    metric: request.metric,
                    total,
                    nextCursor,
                    rows: rows.map((row) => ({
                      cohort: row.label,
                      value: row.value,
                    })),
                  }
                : {
                    ...base,
                    section: request.section,
                    total,
                    nextCursor,
                    rows: rows.map((row) => ({
                      bundleId: row.label,
                      installations: row.value,
                    })),
                  };
            }
            case "movementSeries":
            case "activeSeries": {
              requireKind(
                request.section === "movementSeries"
                  ? "bundleDetail"
                  : "activeOverview",
              );
              await assertPostgresInsightsReportDataIndexes(transaction);
              const first =
                window.firstBucketMs ??
                (await readPostgresInsightsFirstMovementBucket(
                  transaction,
                  job.id,
                  request.section === "movementSeries"
                    ? request.metric
                    : invalid(),
                )) ??
                window.lastBucketMs;
              if (
                first > window.lastBucketMs ||
                (window.lastBucketMs - first) % window.bucketSizeMs !== 0
              )
                invalid();
              const total =
                (BigInt(window.lastBucketMs) - BigInt(first)) /
                  BigInt(window.bucketSizeMs) +
                1n;
              const { size, total: totalRows, nextCursor } = page(total);
              const buckets = Array.from({ length: size }, (_, i) =>
                Number(
                  BigInt(first) +
                    (start + BigInt(i)) * BigInt(window.bucketSizeMs),
                ),
              );
              const values = await readPostgresInsightsReportCounts(
                transaction,
                job.id,
                buckets.map((bucket) =>
                  request.section === "movementSeries"
                    ? ["movementSeries", request.metric, "", bucket]
                    : ["activeSeries", "", "", bucket],
                ),
              );
              const rows = buckets.map((bucketStartMs, i) => ({
                bucketStartMs,
                value: values[i]!,
              }));
              return request.section === "movementSeries"
                ? {
                    ...base,
                    section: request.section,
                    metric: request.metric,
                    total: totalRows,
                    rows,
                    nextCursor,
                  }
                : {
                    ...base,
                    section: request.section,
                    total: totalRows,
                    rows,
                    nextCursor,
                  };
            }
            case "activeBundleSeries": {
              requireKind("activeOverview");
              await assertPostgresInsightsReportDataIndexes(transaction);
              const first = window.firstBucketMs!;
              const bucketCount = BigInt(
                (window.lastBucketMs - first) / window.bucketSizeMs + 1,
              );
              const section = { section: "activeBundleTotals" as const };
              const ready = await getPostgresInsightsReportOrderReady(
                transaction,
                job.id,
                section,
              );
              if (ready === null) throw new InsightsQueryNotReadyError();
              let total: bigint;
              if (request.bundleId !== undefined) {
                const [observations] = await readPostgresInsightsReportCounts(
                  transaction,
                  job.id,
                  [["activeBundleTotals", "", request.bundleId, -1]],
                );
                total = observations === 0 ? 0n : bucketCount;
              } else total = BigInt(ready.totalRows) * bucketCount;
              const { size, total: totalRows, nextCursor } = page(total);
              const firstRank = start / bucketCount;
              const ranks =
                size === 0 || request.bundleId !== undefined
                  ? []
                  : await readPostgresInsightsReportOrderRange(
                      transaction,
                      job.id,
                      section,
                      ready.pass,
                      firstRank.toString(),
                      Number(
                        (start + BigInt(size) - 1n) / bucketCount -
                          firstRank +
                          1n,
                      ),
                    );
              const positions = Array.from({ length: size }, (_, i) => {
                const ordinal = start + BigInt(i);
                return {
                  bundleId:
                    request.bundleId ??
                    ranks[Number(ordinal / bucketCount - firstRank)]!.label,
                  bucketStartMs:
                    first + Number(ordinal % bucketCount) * window.bucketSizeMs,
                };
              });
              const values = await readPostgresInsightsReportCounts(
                transaction,
                job.id,
                positions.map((row) => [
                  "activeBundleSeries",
                  "",
                  row.bundleId,
                  row.bucketStartMs,
                ]),
              );
              return {
                ...base,
                section: request.section,
                total: totalRows,
                nextCursor,
                rows: positions.map((row, i) => ({
                  ...row,
                  value: values[i]!,
                })),
              };
            }
          }
        });
      if (result.state === "expired") return result;
      return fitPostgresInsightsInternalPage(
        result.rows as readonly unknown[],
        (rows, shortened) =>
          ({
            ...result,
            rows,
            nextCursor: shortened
              ? createInsightsReportPageCursor(
                  request,
                  (start + BigInt(rows.length)).toString(),
                  databaseNamespace,
                )
              : result.nextCursor,
          }) as PostgresInsightsReportPage,
      );
    },
  };
};
