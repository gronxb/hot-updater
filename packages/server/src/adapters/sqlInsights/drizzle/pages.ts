import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
  type InsightsEventPageData,
  type InsightsInstallationRow,
  type InsightsLiveInstallationPage,
  type InsightsLiveInstallationPageInput,
  type InsightsPageEventsInput,
  type InsightsPageEventsResult,
  type InsightsProjectedReadVersions,
  type InsightsReadVersions,
  type InsightsSourceReadVersions,
} from "@hot-updater/plugin-core";
import {
  assertInsightsCursorContract,
  assertInsightsPageContract,
  assertInsightsQueryContract,
  getCanonicalInsightsJsonByteLength,
  INSIGHTS_PAGE_MAX_BYTES,
} from "@hot-updater/plugin-core/internal";
import { sql } from "drizzle-orm";

import type { DrizzleProvider } from "../../drizzle";
import { queryDrizzleInsights, type DrizzleDB } from "../../drizzleLazyDB";
import { DRIZZLE_INSIGHTS_EVENTS, DRIZZLE_INSIGHTS_LIVE } from "./schema";
import type { DrizzleInsightsSourceState } from "./source";
import { createDrizzleInsightsSource } from "./source";
import {
  drizzleInsightsEventOrderKey,
  drizzleInsightsInstallKey,
  drizzleInsightsSemanticKey,
  assertDrizzleInsightsStoredInstallation,
  readDrizzleInsightsStoredEvent,
} from "./storage";

const EVENT_CURSOR_REVISION = "drizzle-events-v1";
const INSTALL_CURSOR_REVISION = "drizzle-installations-v1";
const PAGE_ENVELOPE_RESERVE = 4 * 1024;
const hex = /^[0-9a-f]{64}$/;

const invalid = (): never => {
  throw new DatabasePluginInputError("invalid-query");
};

const validLimit = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 100;

const validTime = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const validText = (value: unknown, empty = false): value is string =>
  typeof value === "string" &&
  (empty || value.length > 0) &&
  value.length <= 1024;

const sourceGeneration = (
  state: DrizzleInsightsSourceState,
  maximum: number,
): string => JSON.stringify([1, state.sourceId, maximum]);

const sourceVersions = (
  provider: DrizzleProvider,
  state: DrizzleInsightsSourceState,
  maximum: number,
): InsightsSourceReadVersions => ({
  schemaVersion: "insights-v1",
  storageVersion: `drizzle-${provider}-v1`,
  projectionGeneration: null,
  sourceGeneration: sourceGeneration(state, maximum),
});

const corruptVersions = (provider: DrizzleProvider): InsightsReadVersions => ({
  schemaVersion: "insights-v1",
  storageVersion: `drizzle-${provider}-v1`,
  projectionGeneration: null,
  sourceGeneration: null,
});

const projectedVersions = (
  provider: DrizzleProvider,
  state: DrizzleInsightsSourceState,
  maximum: number,
  projectionGeneration: string,
): InsightsProjectedReadVersions => ({
  ...sourceVersions(provider, state, maximum),
  projectionGeneration,
});

const unavailable = (
  provider: DrizzleProvider,
  state: DrizzleInsightsSourceState,
) =>
  state.status === "failed"
    ? ({
        state: "failed",
        versions: sourceVersions(provider, state, 0),
        error: { code: "migration-poison", jobId: state.sourceId },
      } as const)
    : ({
        state: "preparing",
        versions: sourceVersions(provider, state, 0),
        job: { id: state.sourceId },
      } as const);

const selectorKey = (input: InsightsPageEventsInput): string => {
  const selector = input.selector;
  if (typeof selector !== "object" || selector === null) return invalid();
  switch (selector.kind) {
    case "all":
      return JSON.stringify(["all"]);
    case "installationId":
      if (!validText(selector.installId, true)) return invalid();
      return JSON.stringify([selector.kind, selector.installId]);
    case "bundleId":
      if (!validText(selector.bundleId)) return invalid();
      return JSON.stringify([selector.kind, selector.bundleId]);
    default:
      return invalid();
  }
};

type EventCursor = {
  readonly sourceId: string;
  readonly receivedAtMs: number;
  readonly id: string;
};

const readEventCursor = (
  input: InsightsPageEventsInput,
  key: string,
): EventCursor | null => {
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
    value.length !== 8 ||
    value[0] !== 1 ||
    value[1] !== EVENT_CURSOR_REVISION ||
    typeof value[2] !== "string" ||
    value[3] !== key ||
    value[4] !== input.beforeReceivedAtMs ||
    value[5] !== (input.sinceReceivedAtMs ?? 0) ||
    !validTime(value[6]) ||
    !validText(value[7])
  ) {
    return invalid();
  }
  return {
    sourceId: value[2],
    receivedAtMs: value[6],
    id: value[7],
  };
};

const eventCursor = (
  input: InsightsPageEventsInput,
  key: string,
  sourceId: string,
  row: BundleEventRow,
): string => {
  const value = JSON.stringify([
    1,
    EVENT_CURSOR_REVISION,
    sourceId,
    key,
    input.beforeReceivedAtMs,
    input.sinceReceivedAtMs ?? 0,
    row.received_at_ms,
    row.id,
  ]);
  assertInsightsCursorContract(value);
  return value;
};

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

type InstallationCursor = {
  readonly sourceId: string;
  readonly installKey: string;
};

const readInstallationCursor = (
  input: InsightsLiveInstallationPageInput,
): InstallationCursor | null => {
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
    value.length !== 4 ||
    value[0] !== 1 ||
    value[1] !== INSTALL_CURSOR_REVISION ||
    typeof value[2] !== "string" ||
    typeof value[3] !== "string" ||
    !hex.test(value[3])
  ) {
    return invalid();
  }
  return { sourceId: value[2], installKey: value[3] };
};

export const createDrizzleInsightsPages = (
  db: DrizzleDB,
  provider: DrizzleProvider,
) => {
  const source = createDrizzleInsightsSource(db, provider);
  const readySource = async (): Promise<
    | { readonly ready: false; readonly state: DrizzleInsightsSourceState }
    | {
        readonly ready: true;
        readonly state: DrizzleInsightsSourceState;
        readonly maximum: number;
      }
  > => {
    await source.assertReadyLayout();
    const state = await source.readState();
    if (state.status !== "ready") return { ready: false, state };
    return { ready: true, state, maximum: state.committedSeq };
  };

  return {
    append: source.append,
    async pageEvents(
      input: InsightsPageEventsInput,
    ): Promise<InsightsPageEventsResult> {
      assertInsightsQueryContract(input);
      if (
        typeof input !== "object" ||
        input === null ||
        !validLimit(input.limit) ||
        !validTime(input.beforeReceivedAtMs) ||
        (input.sinceReceivedAtMs !== undefined &&
          !validTime(input.sinceReceivedAtMs)) ||
        (input.sinceReceivedAtMs ?? 0) > input.beforeReceivedAtMs
      ) {
        return invalid();
      }
      const key = selectorKey(input);
      const cursor = readEventCursor(input, key);
      let prepared;
      try {
        prepared = await readySource();
      } catch (error) {
        if (
          error instanceof DatabasePluginInputError &&
          error.code === "invalid-result"
        ) {
          return {
            state: "failed",
            versions: corruptVersions(provider),
            error: { code: "storage-corruption" },
          };
        }
        if (!(error instanceof InsightsQueryNotReadyError)) throw error;
        let state;
        try {
          state = await source.readState();
        } catch (storedError) {
          if (
            !(storedError instanceof DatabasePluginInputError) ||
            storedError.code !== "invalid-result"
          ) {
            throw storedError;
          }
          return {
            state: "failed",
            versions: corruptVersions(provider),
            error: { code: "storage-corruption" },
          };
        }
        return {
          state: "failed",
          versions: sourceVersions(provider, state, 0),
          error: { code: "index-not-ready" },
        };
      }
      if (!prepared.ready) return unavailable(provider, prepared.state);
      const maximum = prepared.maximum;
      if (cursor !== null && cursor.sourceId !== prepared.state.sourceId) {
        return invalid();
      }
      const eventWindow = sql`e.seq <= ${maximum}
        and e.received_at_ms >= ${input.sinceReceivedAtMs ?? 0}
        and e.received_at_ms < ${input.beforeReceivedAtMs}
        ${
          cursor === null
            ? sql``
            : sql`and (e.received_at_ms < ${cursor.receivedAtMs} or
              (e.received_at_ms = ${cursor.receivedAtMs} and
                e.event_order_key < ${drizzleInsightsEventOrderKey(cursor.id)}))`
        }`;
      const installKey =
        input.selector.kind === "installationId"
          ? await drizzleInsightsInstallKey(input.selector.installId)
          : null;
      const bundleKey =
        input.selector.kind === "bundleId"
          ? drizzleInsightsSemanticKey(["bundle", input.selector.bundleId])
          : null;
      const candidateQuery =
        input.selector.kind === "bundleId"
          ? sql`select * from (
              select * from (
                select e.* from ${sql.identifier(DRIZZLE_INSIGHTS_EVENTS)} e
                where ${eventWindow} and e.event_type='UPDATE_APPLIED'
                  and e.to_bundle_key=${bundleKey}
                  and e.to_bundle_id=${input.selector.bundleId}
                order by e.received_at_ms desc,e.event_order_key desc
                limit ${input.limit + 1}
              ) drizzle_applied
              union all
              select * from (
                select e.* from ${sql.identifier(DRIZZLE_INSIGHTS_EVENTS)} e
                where ${eventWindow} and e.event_type='RECOVERED'
                  and e.from_bundle_key=${bundleKey}
                  and e.from_bundle_id=${input.selector.bundleId}
                order by e.received_at_ms desc,e.event_order_key desc
                limit ${input.limit + 1}
              ) drizzle_recovered
            ) drizzle_bundle_events
            order by received_at_ms desc,event_order_key desc
            limit ${input.limit + 1}`
          : sql`select e.* from ${sql.identifier(DRIZZLE_INSIGHTS_EVENTS)} e
              where ${eventWindow}
              ${
                input.selector.kind === "installationId"
                  ? sql`and e.install_key=${installKey}
                    and e.install_id=${input.selector.installId}
                    and e.event_type in ('UPDATE_APPLIED','RECOVERED')`
                  : sql``
              }
              order by e.received_at_ms desc,e.event_order_key desc
              limit ${input.limit + 1}`;
      const rows = await queryDrizzleInsights(db, candidateQuery);
      let candidates;
      try {
        candidates = rows.map(readDrizzleInsightsStoredEvent);
        await Promise.all(
          candidates.map(assertDrizzleInsightsStoredInstallation),
        );
      } catch (error) {
        if (
          !(error instanceof DatabasePluginInputError) ||
          error.code !== "invalid-result"
        ) {
          throw error;
        }
        return {
          state: "failed",
          versions: sourceVersions(provider, prepared.state, maximum),
          error: { code: "storage-corruption" },
        };
      }
      const data: BundleEventRow[] = [];
      for (const candidate of candidates.slice(0, input.limit)) {
        if (
          getCanonicalInsightsJsonByteLength([...data, candidate.event]) >
          INSIGHTS_PAGE_MAX_BYTES - PAGE_ENVELOPE_RESERVE
        ) {
          break;
        }
        data.push(candidate.event);
      }
      const hasNext = candidates.length > data.length;
      const nextCursor =
        hasNext && data.length > 0
          ? eventCursor(input, key, prepared.state.sourceId, data.at(-1)!)
          : null;
      const page: InsightsEventPageData = {
        data,
        nextCursor,
        hasNext: nextCursor !== null,
        consistency: {
          kind: "live",
          cutoff: {
            kind: "event-time",
            beforeReceivedAtMs: input.beforeReceivedAtMs,
          },
        },
        total: { state: "unavailable" },
      };
      const result: InsightsPageEventsResult = {
        state: "ready",
        versions: sourceVersions(provider, prepared.state, maximum),
        data: page,
      };
      assertInsightsPageContract(result, input.limit);
      return result;
    },
    async pageLiveInstallations(
      input: InsightsLiveInstallationPageInput,
    ): Promise<InsightsLiveInstallationPage> {
      assertInsightsQueryContract(input);
      if (
        typeof input !== "object" ||
        input === null ||
        !validLimit(input.limit) ||
        (input.kind !== "all" && input.kind !== "installationId") ||
        (input.kind === "installationId" &&
          !validText(input.installId, true)) ||
        (input.kind === "installationId" && input.cursor !== undefined)
      ) {
        return invalid();
      }
      const cursor = readInstallationCursor(input);
      let prepared;
      try {
        prepared = await readySource();
      } catch (error) {
        if (
          error instanceof DatabasePluginInputError &&
          error.code === "invalid-result"
        ) {
          return {
            state: "failed",
            versions: corruptVersions(provider),
            error: { code: "storage-corruption" },
          };
        }
        if (!(error instanceof InsightsQueryNotReadyError)) throw error;
        let state;
        try {
          state = await source.readState();
        } catch (storedError) {
          if (
            !(storedError instanceof DatabasePluginInputError) ||
            storedError.code !== "invalid-result"
          ) {
            throw storedError;
          }
          return {
            state: "failed",
            versions: corruptVersions(provider),
            error: { code: "storage-corruption" },
          };
        }
        return {
          state: "failed",
          versions: sourceVersions(provider, state, 0),
          error: { code: "index-not-ready" },
        };
      }
      if (!prepared.ready) return unavailable(provider, prepared.state);
      const maximum = prepared.maximum;
      const generation = sourceGeneration(prepared.state, maximum);
      if (cursor !== null && cursor.sourceId !== prepared.state.sourceId) {
        return invalid();
      }
      const exactKey =
        input.kind === "installationId"
          ? await drizzleInsightsInstallKey(input.installId)
          : null;
      const rows = await queryDrizzleInsights(
        db,
        sql`select e.* from ${sql.identifier(DRIZZLE_INSIGHTS_LIVE)} l
          join ${sql.identifier(DRIZZLE_INSIGHTS_EVENTS)} e
            on e.event_id=l.event_id
          where 1=1
          ${exactKey === null ? sql`` : sql`and l.install_key=${exactKey}`}
          ${input.kind === "installationId" ? sql`and l.install_id=${input.installId}` : sql``}
          ${cursor === null ? sql`` : sql`and l.install_key > ${cursor.installKey}`}
          order by l.install_key asc limit ${input.limit + 1}`,
      );
      let candidates;
      try {
        candidates = rows.map(readDrizzleInsightsStoredEvent);
        await Promise.all(
          candidates.map(assertDrizzleInsightsStoredInstallation),
        );
      } catch (error) {
        if (
          !(error instanceof DatabasePluginInputError) ||
          error.code !== "invalid-result"
        ) {
          throw error;
        }
        return {
          state: "failed",
          versions: projectedVersions(
            provider,
            prepared.state,
            maximum,
            generation,
          ),
          error: { code: "storage-corruption" },
        };
      }
      for (const row of candidates) {
        if (
          input.kind === "installationId" &&
          row.install_id !== input.installId
        ) {
          return {
            state: "failed",
            versions: projectedVersions(
              provider,
              prepared.state,
              maximum,
              generation,
            ),
            error: { code: "storage-corruption" },
          };
        }
      }
      const emitted: {
        readonly row: InsightsInstallationRow;
        readonly installKey: string;
      }[] = [];
      for (const candidate of candidates.slice(0, input.limit)) {
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
        emitted.push({ row, installKey: candidate.install_key });
      }
      const hasNext = candidates.length > emitted.length;
      const nextCursor =
        hasNext && emitted.length > 0
          ? JSON.stringify([
              1,
              INSTALL_CURSOR_REVISION,
              prepared.state.sourceId,
              emitted.at(-1)!.installKey,
            ])
          : null;
      if (nextCursor !== null) assertInsightsCursorContract(nextCursor);
      const result: InsightsLiveInstallationPage = {
        state: "ready",
        versions: projectedVersions(
          provider,
          prepared.state,
          maximum,
          generation,
        ),
        data: {
          data: emitted.map(({ row }) => row),
          nextCursor,
          hasNext: nextCursor !== null,
          consistency: {
            kind: "live",
            cutoff: {
              kind: "projection",
              observedAtMs: Date.now(),
              projectionGeneration: generation,
            },
          },
          total: { state: "unavailable" },
        },
      };
      assertInsightsPageContract(result, input.limit);
      return result;
    },
    source,
  };
};
