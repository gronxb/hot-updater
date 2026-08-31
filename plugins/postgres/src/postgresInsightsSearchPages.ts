import { createHash } from "node:crypto";

import {
  DatabasePluginInputError,
  type InsightsInstallationPage,
  type InsightsInstallationPageInput,
  type InsightsInstallationRow,
} from "@hot-updater/plugin-core";
import type { Kysely } from "kysely";

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

type Input = Extract<InsightsInstallationPageInput, { kind: "contains" }>;
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
          "limit",
          "cursor",
          "publicationId",
          "minAsOfMs",
        ].includes(key),
    ) ||
    input.kind !== "contains" ||
    typeof input.query !== "string" ||
    input.query.length === 0 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.publicationId !== undefined &&
      (typeof input.publicationId !== "string" ||
        !uuid.test(input.publicationId))) ||
    (input.minAsOfMs !== undefined &&
      (!Number.isSafeInteger(input.minAsOfMs) || input.minAsOfMs < 0))
  )
    return invalid();
  const normalizedQuery = normalizePostgresInsightsSearchQuery(input.query);
  const queryKey = hash(JSON.stringify([1, normalizedQuery]));
  let publicationId = input.publicationId;
  let ordinal = 0n;
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
      value.length !== 5 ||
      value[0] !== 1 ||
      value[1] !== "snapshot" ||
      typeof value[2] !== "string" ||
      !uuid.test(value[2]) ||
      value[3] !== queryKey ||
      typeof value[4] !== "string" ||
      !decimal.test(value[4]) ||
      BigInt(value[4]) > maximum ||
      (publicationId !== undefined && publicationId !== value[2])
    )
      return invalid();
    publicationId = value[2];
    ordinal = BigInt(value[4]);
  }
  return { normalizedQuery, queryKey, publicationId, ordinal };
};

/** Contains only; live all/exact installation pages use a separate projection. */
export const createPostgresInsightsSearchPages = <TDatabase extends object>(
  db: Kysely<TDatabase>,
) => {
  const jobs = createPostgresInsightsJobs(db);
  return {
    async pageContains(input: Input): Promise<InsightsInstallationPage> {
      const parsed = parse(input);
      let publicationId = parsed.publicationId;
      if (publicationId === undefined) {
        const result = await jobs.getSearch({
          query: parsed.normalizedQuery,
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
        .execute(async (transaction): Promise<InsightsInstallationPage> => {
          const result = await readPostgresInsightsSearchPublication(
            transaction,
            pinnedId,
            parsed.normalizedQuery,
          );
          if (result === null)
            return { state: "expired", publicationId: pinnedId };
          const { job, publication } = result;
          if (
            (input.minAsOfMs !== undefined &&
              publication.asOfMs < input.minAsOfMs) ||
            parsed.ordinal > BigInt(publication.total)
          )
            return invalid();
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
          const next = parsed.ordinal + BigInt(rows.length);
          return {
            state: "ready",
            consistency: "snapshot",
            publication,
            rows,
            nextCursor:
              next === BigInt(publication.total)
                ? null
                : JSON.stringify([
                    1,
                    "snapshot",
                    pinnedId,
                    parsed.queryKey,
                    next.toString(),
                  ]),
          };
        });
    },
  };
};
