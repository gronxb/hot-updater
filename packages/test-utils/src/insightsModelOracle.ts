import type {
  BundleEventRow,
  InsightsInstallationPage,
  InsightsInstallationPageInput,
  InsightsInstallationRow,
  InsightsPageEventsInput,
  InsightsPageEventsResult,
  InsightsPublication,
  InsightsReportInput,
  InsightsReportPage,
  InsightsReportPageInput,
  InsightsReportPublication,
  InsightsReportResult,
  InsightsModel,
} from "@hot-updater/plugin-core";
import {
  assertInsightsCursorContract,
  assertInsightsEventContract,
  assertInsightsMaintenanceInputContract,
  getInsightsInstallationOrderKey,
  assertInsightsPageContract,
  assertInsightsQueryContract,
  assertInsightsReportPageResultContract,
  assertInsightsReportResultContract,
  compareInsightsInstallationOrderKeys,
  compareInsightsStrings,
  createInsightsReportPageCursor,
  getCanonicalInsightsJsonByteLength,
  isCanonicalInsightsDatabaseNamespace,
  readInsightsInstallationPageInput,
  readInsightsPageEventsInput,
  readInsightsReportPageQuery,
} from "@hot-updater/plugin-core/internal";

type JobKind = "installation" | "report";

type OracleJob = {
  readonly id: string;
  readonly kind: JobKind;
  readonly key: string;
  readonly input: InsightsInstallationPageInput | InsightsReportInput;
  /** Committed source prefix frozen when the durable job is reserved. */
  readonly sourceGeneration: number;
  /** Exclusive report/snapshot cutoff frozen with the source generation. */
  readonly asOfMs: number;
  processedItems: number;
  status: "active" | "failed" | "complete";
  publicationId?: string;
};

type InstallationPublication = InsightsPublication & {
  readonly kind: "installation";
  readonly queryKey: string;
  readonly projectionGeneration: string;
  readonly rows: readonly InsightsInstallationRow[];
};

type ReportPublication = InsightsReportPublication & {
  readonly queryKey: string;
  readonly projectionGeneration: string;
  readonly sections: Readonly<
    Record<string, readonly Readonly<Record<string, string | number>>[]>
  >;
};

type OraclePublication = InstallationPublication | ReportPublication;

type StoredEvent = {
  readonly row: BundleEventRow;
  readonly generation: number;
};

type OracleStore = {
  generation: number;
  events: StoredEvent[];
  jobs: Map<string, OracleJob>;
  publications: Map<string, OraclePublication>;
  expiredPublications: Set<string>;
  poisonGenerations: number[];
  nowMs?: number;
  nextJob: number;
  nextPublication: number;
  lastStorageReads: number;
};

export interface InsightsMaintenanceStepUsage {
  /** Source records examined by this step. */
  readonly items: number;
  /** Provider storage requests issued by this step. */
  readonly requests: number;
  /** Provider-native bytes examined, when that measurement is available. */
  readonly bytes?: number;
}

export type InsightsMaintenanceStepResult =
  | {
      readonly state: "complete";
      readonly publicationId: string;
      readonly usage: InsightsMaintenanceStepUsage;
    }
  | {
      readonly state: "running";
      readonly jobId: string;
      readonly usage: InsightsMaintenanceStepUsage;
    }
  | {
      readonly state: "idle";
      readonly jobId: string;
      readonly usage: InsightsMaintenanceStepUsage;
    }
  | {
      readonly state: "failed";
      readonly jobId: string;
      readonly usage: InsightsMaintenanceStepUsage;
    };

export interface InsightsModelOracle {
  readonly model: InsightsModel;
  readonly otherNamespaceModel: InsightsModel;
  runJobStep(
    jobId: string,
    input: { readonly maxItems: number; readonly maxRequests: number },
  ): Promise<InsightsMaintenanceStepResult>;
  /** Advances a job reserved through `otherNamespaceModel`. */
  runOtherNamespaceJobStep(
    jobId: string,
    input: { readonly maxItems: number; readonly maxRequests: number },
  ): Promise<InsightsMaintenanceStepResult>;
  /** Creates fresh model/control facades over the same durable namespace pair. */
  reopen(): InsightsModelOracle | Promise<InsightsModelOracle>;
  /** Inserts a malformed retained row through provider-native test controls. */
  insertMigrationPoisonRow(): void | Promise<void>;
  /** Sets the clock from which subsequently reserved jobs freeze `asOfMs`. */
  setCurrentTimeMs(nowMs: number): void;
  expirePublication(publicationId: string): void | Promise<void>;
  /** Reports only atomically visible, complete publications. */
  publicationStateForJob(jobId: string): "absent" | "complete";
  /** Native records/documents read before application-side filtering. */
  getLastStorageReadCount(namespace?: "primary" | "other"): number;
  /** Finite provider-native candidate ceiling for this exact event request. */
  getPageEventsCandidateReadBudget(input: InsightsPageEventsInput): number;
  /** Finite provider-native candidate ceiling for this installation request. */
  getPageInstallationsCandidateReadBudget(
    input: InsightsInstallationPageInput,
  ): number;
  /** Finite provider-native candidate ceiling for this report-page request. */
  getPageReportCandidateReadBudget(input: InsightsReportPageInput): number;
}

export interface InsightsModelConformanceNamespaces {
  readonly insightsDatabaseNamespace: string;
  readonly otherInsightsDatabaseNamespace: string;
}

const createStore = (): OracleStore => ({
  generation: 0,
  events: [],
  jobs: new Map(),
  publications: new Map(),
  expiredPublications: new Set(),
  poisonGenerations: [],
  nextJob: 1,
  nextPublication: 1,
  lastStorageReads: 0,
});

const sourceGeneration = (generation: number): string => `source-${generation}`;

function versions(
  generation: number,
  projected: false,
): {
  schemaVersion: string;
  storageVersion: string;
  projectionGeneration: null;
  sourceGeneration: string;
};
function versions(
  generation: number,
  projected?: true,
): {
  schemaVersion: string;
  storageVersion: string;
  projectionGeneration: string;
  sourceGeneration: string;
};
function versions(generation: number, projected = true) {
  return {
    schemaVersion: "oracle-schema-1",
    storageVersion: "oracle-storage-1",
    projectionGeneration: projected ? `projection-${generation}` : null,
    sourceGeneration: sourceGeneration(generation),
  };
}

const compareEvents = (left: BundleEventRow, right: BundleEventRow): number =>
  right.received_at_ms - left.received_at_ms ||
  (left.id < right.id ? 1 : left.id > right.id ? -1 : 0);

const isMovement = (row: BundleEventRow): boolean =>
  row.type === "UPDATE_APPLIED" || row.type === "RECOVERED";

const invalidQuery = (): never => {
  throw new Error("invalid-query");
};

const encodeCursor = (value: readonly unknown[]): string => {
  const cursor = JSON.stringify(value);
  assertInsightsCursorContract(cursor);
  return cursor;
};

const decodeCursor = (
  cursor: string | undefined,
  expected: readonly unknown[],
): number => {
  if (cursor === undefined) return 0;
  assertInsightsCursorContract(cursor);
  let value: unknown;
  try {
    value = JSON.parse(cursor);
  } catch {
    return invalidQuery();
  }
  if (
    !Array.isArray(value) ||
    value.length !== expected.length + 1 ||
    expected.some((part, index) => value[index] !== part) ||
    !Number.isSafeInteger(value.at(-1)) ||
    (value.at(-1) as number) < 0
  ) {
    return invalidQuery();
  }
  return value.at(-1) as number;
};

const publishedInstallationCursorPublication = (
  cursor: string | undefined,
  namespace: string,
  key: string,
): string | undefined => {
  if (cursor === undefined) return undefined;
  assertInsightsCursorContract(cursor);
  let value: unknown;
  try {
    value = JSON.parse(cursor);
  } catch {
    return invalidQuery();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 6 ||
    value[0] !== 1 ||
    value[1] !== namespace ||
    value[2] !== "installations-published" ||
    value[3] !== key ||
    typeof value[4] !== "string" ||
    value[4].length === 0 ||
    !Number.isSafeInteger(value[5]) ||
    (value[5] as number) < 0
  ) {
    return invalidQuery();
  }
  return value[4];
};

const pageRows = <TRow>(
  rows: readonly TRow[],
  offset: number,
  limit: number,
): { data: readonly TRow[]; nextOffset: number | null } => {
  const data = rows.slice(offset, offset + limit);
  const nextOffset =
    offset + data.length < rows.length ? offset + data.length : null;
  return { data, nextOffset };
};

const installationRow = (row: BundleEventRow): InsightsInstallationRow => ({
  id: row.id,
  install_id: row.install_id,
  user_id: row.user_id,
  username: row.username,
  to_bundle_id: row.to_bundle_id,
  type: row.type,
  platform: row.platform,
  app_version: row.app_version,
  channel: row.channel,
  cohort: row.cohort,
  received_at_ms: row.received_at_ms,
});

const latestEventsByInstallation = (
  events: readonly StoredEvent[],
  generation: number,
): BundleEventRow[] => {
  const latest = new Map<string, BundleEventRow>();
  for (const { row, generation: rowGeneration } of events) {
    if (rowGeneration > generation) continue;
    const current = latest.get(row.install_id);
    if (current === undefined || compareEvents(row, current) < 0) {
      latest.set(row.install_id, row);
    }
  }
  return [...latest.values()];
};

const latestInstallations = (
  events: readonly StoredEvent[],
  generation: number,
): InsightsInstallationRow[] =>
  latestEventsByInstallation(events, generation).map(installationRow);

const orderInstallations = async (
  rows: readonly InsightsInstallationRow[],
): Promise<InsightsInstallationRow[]> => {
  const keyed = await Promise.all(
    rows.map(async (row) => ({
      row,
      order: await getInsightsInstallationOrderKey(row.install_id),
    })),
  );
  keyed.sort((left, right) => {
    const order = compareInsightsInstallationOrderKeys(left.order, right.order);
    if (order === 0 && left.row.install_id !== right.row.install_id) {
      throw new Error("installation-identity-collision");
    }
    return order;
  });
  return keyed.map(({ row }) => row);
};

const semanticInstallationKey = (
  input: InsightsInstallationPageInput,
): string => {
  if (input.kind === "userId") {
    return JSON.stringify([input.kind, input.userId]);
  }
  if (input.kind === "contains") {
    return JSON.stringify([input.kind, input.query.toLowerCase()]);
  }
  return invalidQuery();
};

const semanticReportKey = (input: InsightsReportInput): string => {
  const query =
    input.query.kind === "bundleSummaries"
      ? {
          ...input.query,
          bundleIds: [...new Set(input.query.bundleIds)].sort(),
        }
      : input.query;
  return JSON.stringify(query);
};

const reserveJob = (
  store: OracleStore,
  kind: JobKind,
  key: string,
  input: InsightsInstallationPageInput | InsightsReportInput,
): OracleJob => {
  const current = [...store.jobs.values()].find(
    (job) =>
      job.kind === kind &&
      job.key === key &&
      (job.status === "active" || job.status === "failed"),
  );
  if (current !== undefined) return current;
  const job: OracleJob = {
    id: `job-${store.nextJob++}`,
    kind,
    key,
    input: structuredClone(input),
    sourceGeneration: store.generation,
    asOfMs:
      store.nowMs ??
      store.events.reduce(
        (maximum, event) => Math.max(maximum, event.row.received_at_ms),
        0,
      ) + 1,
    processedItems: 0,
    status: "active",
  };
  store.jobs.set(job.id, job);
  return job;
};

const latestPublication = (
  store: OracleStore,
  kind: JobKind,
  key: string,
): OraclePublication | undefined =>
  [...store.jobs.values()]
    .filter(
      (job) =>
        job.kind === kind &&
        job.key === key &&
        job.status === "complete" &&
        job.publicationId !== undefined,
    )
    .map((job) => store.publications.get(job.publicationId!))
    .filter((value): value is OraclePublication => value !== undefined)
    .sort((left, right) => right.asOfMs - left.asOfMs)[0];

const reportPublication = (
  store: OracleStore,
  id: string,
  input: InsightsReportInput,
  generation: number,
  asOfMs: number,
  queryKey: string,
): ReportPublication => {
  const hourMs = 3_600_000;
  const dayMs = 86_400_000;
  const sourceEvents = store.events.filter(
    (event) =>
      event.generation <= generation && event.row.received_at_ms < asOfMs,
  );
  const movement = sourceEvents.map(({ row }) => row).filter(isMovement);
  const latest = latestInstallations(sourceEvents, generation);
  const windowMs = (window: "24h" | "7d" | "30d"): number =>
    ({ "24h": dayMs, "7d": 7 * dayMs, "30d": 30 * dayMs })[window];
  const reportWindow =
    "window" in input.query ? input.query.window : ("all" as const);
  const movementBucketSizeMs = reportWindow === "24h" ? hourMs : dayMs;
  const movementBucketCount =
    reportWindow === "24h" ? 24 : reportWindow === "7d" ? 7 : 30;
  const movementFirstBucketMs =
    reportWindow === "all"
      ? null
      : Math.floor(asOfMs / movementBucketSizeMs) * movementBucketSizeMs -
        (movementBucketCount - 1) * movementBucketSizeMs;
  const movementLastBucketMs =
    Math.floor(asOfMs / movementBucketSizeMs) * movementBucketSizeMs;
  const windowedMovement = movement.filter(
    (row) =>
      movementFirstBucketMs === null ||
      row.received_at_ms >= movementFirstBucketMs,
  );
  const activeQuery =
    input.query.kind === "activeOverview" ? input.query : undefined;
  const activeWindowStartMs =
    activeQuery === undefined ? null : asOfMs - windowMs(activeQuery.window);
  const activeEvents =
    activeWindowStartMs === null
      ? []
      : sourceEvents.filter(
          ({ row }) => row.received_at_ms >= activeWindowStartMs,
        );
  const activeLatest = latestEventsByInstallation(
    activeEvents,
    generation,
  ).filter(
    (row) =>
      activeQuery?.userId === undefined || row.user_id === activeQuery.userId,
  );
  const activeInstallIds = new Set(activeLatest.map((row) => row.install_id));
  const activeBucketSizeMs = activeQuery?.window === "24h" ? hourMs : dayMs;
  const activeBucketCount =
    activeQuery === undefined
      ? 0
      : activeQuery.window === "24h"
        ? 24
        : activeQuery.window === "7d"
          ? 7
          : 30;
  const activeBuckets = new Map<number, StoredEvent[]>();
  for (const event of activeEvents) {
    if (!activeInstallIds.has(event.row.install_id)) continue;
    const bucketStartMs =
      activeWindowStartMs! +
      Math.floor(
        (event.row.received_at_ms - activeWindowStartMs!) / activeBucketSizeMs,
      ) *
        activeBucketSizeMs;
    const bucket = activeBuckets.get(bucketStartMs) ?? [];
    bucket.push(event);
    activeBuckets.set(bucketStartMs, bucket);
  }
  const activeBucketLatest = Array.from(
    { length: activeBucketCount },
    (_, index) => activeWindowStartMs! + index * activeBucketSizeMs,
  ).map((bucketStartMs) => ({
    bucketStartMs,
    rows: latestEventsByInstallation(
      activeBuckets.get(bucketStartMs) ?? [],
      generation,
    ),
  }));
  const activeSeries = activeBucketLatest.map(({ bucketStartMs, rows }) => ({
    bucketStartMs,
    value: rows.length,
  }));
  const activeBundleBuckets = activeBucketLatest.map(
    ({ bucketStartMs, rows }) => {
      const counts = new Map<string, number>();
      for (const row of rows) {
        counts.set(row.to_bundle_id, (counts.get(row.to_bundle_id) ?? 0) + 1);
      }
      return { bucketStartMs, counts };
    },
  );
  const activeBundleTotals = new Map<string, number>();
  for (const { counts } of activeBundleBuckets) {
    for (const [bundleId, value] of counts) {
      activeBundleTotals.set(
        bundleId,
        (activeBundleTotals.get(bundleId) ?? 0) + value,
      );
    }
  }
  const activeBundleSeries = [...activeBundleTotals]
    .sort(
      ([leftLabel, leftValue], [rightLabel, rightValue]) =>
        rightValue - leftValue || compareInsightsStrings(leftLabel, rightLabel),
    )
    .flatMap(([bundleId]) =>
      activeBundleBuckets.map(({ bucketStartMs, counts }) => ({
        bundleId,
        bucketStartMs,
        value: counts.get(bundleId) ?? 0,
      })),
    );
  const installed = (bundleId?: string) =>
    new Set(
      windowedMovement
        .filter(
          (row) =>
            row.type === "UPDATE_APPLIED" &&
            (bundleId === undefined || row.to_bundle_id === bundleId),
        )
        .map((row) => row.install_id),
    ).size;
  const recovered = (bundleId?: string) =>
    new Set(
      windowedMovement
        .filter(
          (row) =>
            row.type === "RECOVERED" &&
            (bundleId === undefined || row.from_bundle_id === bundleId),
        )
        .map((row) => row.install_id),
    ).size;
  let report: InsightsReportPublication;
  switch (input.query.kind) {
    case "bundleSummaries":
      report = {
        id,
        asOfMs,
        completedAtMs: asOfMs,
        sourceGeneration: sourceGeneration(generation),
        accuracy: "exact",
        kind: input.query.kind,
        summary: [...new Set(input.query.bundleIds)].sort().map((bundleId) => ({
          bundleId,
          installed: installed(bundleId),
          recovered: recovered(bundleId),
        })),
      };
      break;
    case "bundleDetail":
      report = {
        id,
        asOfMs,
        completedAtMs: asOfMs,
        sourceGeneration: sourceGeneration(generation),
        accuracy: "exact",
        kind: input.query.kind,
        summary: {
          installed: installed(input.query.bundleId),
          recovered: recovered(input.query.bundleId),
        },
      };
      break;
    case "installationOverview":
      report = {
        id,
        asOfMs,
        completedAtMs: asOfMs,
        sourceGeneration: sourceGeneration(generation),
        accuracy: "exact",
        kind: input.query.kind,
        summary: { trackedInstallations: latest.length },
      };
      break;
    case "activeOverview": {
      const activeQuery = input.query;
      report = {
        id,
        asOfMs,
        completedAtMs: asOfMs,
        sourceGeneration: sourceGeneration(generation),
        accuracy: "exact",
        kind: activeQuery.kind,
        summary: {
          activeInstallations: activeLatest.length,
        },
      };
      break;
    }
  }
  const bundleCounts = new Map<string, number>();
  for (const row of latest) {
    bundleCounts.set(
      row.to_bundle_id,
      (bundleCounts.get(row.to_bundle_id) ?? 0) + 1,
    );
  }
  const detailBundleId =
    input.query.kind === "bundleDetail" ? input.query.bundleId : undefined;
  const detailMovement = windowedMovement.filter(
    (row) =>
      detailBundleId === undefined ||
      (row.type === "UPDATE_APPLIED"
        ? row.to_bundle_id === detailBundleId
        : row.type === "RECOVERED" && row.from_bundle_id === detailBundleId),
  );
  const movementSeries = (type: "UPDATE_APPLIED" | "RECOVERED") => {
    const buckets = new Map<number, Set<string>>();
    for (const row of detailMovement.filter((event) => event.type === type)) {
      const bucketStartMs =
        Math.floor(row.received_at_ms / movementBucketSizeMs) *
        movementBucketSizeMs;
      const installs = buckets.get(bucketStartMs) ?? new Set<string>();
      installs.add(row.install_id);
      buckets.set(bucketStartMs, installs);
    }
    let firstBucketMs = movementFirstBucketMs ?? movementLastBucketMs;
    if (movementFirstBucketMs === null) {
      for (const bucketStartMs of buckets.keys()) {
        firstBucketMs = Math.min(firstBucketMs, bucketStartMs);
      }
    }
    return Array.from(
      {
        length:
          (movementLastBucketMs - firstBucketMs) / movementBucketSizeMs + 1,
      },
      (_, index) => {
        const bucketStartMs = firstBucketMs + index * movementBucketSizeMs;
        return {
          bucketStartMs,
          value: buckets.get(bucketStartMs)?.size ?? 0,
        };
      },
    );
  };
  const movementCohorts = (type: "UPDATE_APPLIED" | "RECOVERED") => {
    const cohorts = new Map<string, Set<string>>();
    for (const row of detailMovement.filter((event) => event.type === type)) {
      const installs = cohorts.get(row.cohort) ?? new Set<string>();
      installs.add(row.install_id);
      cohorts.set(row.cohort, installs);
    }
    return [...cohorts]
      .sort(([left], [right]) => compareInsightsStrings(left, right))
      .map(([cohort, installs]) => ({ cohort, value: installs.size }));
  };
  const sectionBundleCounts = new Map<string, number>();
  for (const row of activeLatest) {
    sectionBundleCounts.set(
      row.to_bundle_id,
      (sectionBundleCounts.get(row.to_bundle_id) ?? 0) + 1,
    );
  }
  return {
    ...report,
    queryKey,
    projectionGeneration: `projection-${generation}`,
    sections: {
      "movementSeries:installed": movementSeries("UPDATE_APPLIED"),
      "movementSeries:recovered": movementSeries("RECOVERED"),
      "movementCohorts:installed": movementCohorts("UPDATE_APPLIED"),
      "movementCohorts:recovered": movementCohorts("RECOVERED"),
      bundleDistribution: [
        ...(input.query.kind === "activeOverview"
          ? sectionBundleCounts
          : bundleCounts),
      ]
        .sort(
          ([leftLabel, leftValue], [rightLabel, rightValue]) =>
            rightValue - leftValue ||
            compareInsightsStrings(leftLabel, rightLabel),
        )
        .map(([bundleId, installations]) => ({ bundleId, installations })),
      activeSeries,
      activeBundleSeries,
    },
  };
};

const publicReport = (value: ReportPublication): InsightsReportPublication => {
  const {
    queryKey: _,
    projectionGeneration: __,
    sections: ___,
    ...publication
  } = value;
  return publication;
};

const createModel = (namespace: string, store: OracleStore): InsightsModel => ({
  async append(row) {
    assertInsightsEventContract(row);
    if (store.events.some((event) => event.row.id === row.id)) {
      throw new Error("duplicate-event");
    }
    store.generation += 1;
    store.events.push({
      row: structuredClone(row),
      generation: store.generation,
    });
  },

  async runMaintenanceStep({ jobId, maxItems, maxRequests }) {
    await runOracleJobStep(store, jobId, { maxItems, maxRequests });
  },

  async pageEvents(input): Promise<InsightsPageEventsResult> {
    input = readInsightsPageEventsInput(input);
    const scope = JSON.stringify(input.selector);
    let cursorBoundary:
      | { readonly receivedAtMs: number; readonly eventId: string }
      | undefined;
    if (input.cursor !== undefined) {
      assertInsightsCursorContract(input.cursor);
      let cursor: unknown;
      try {
        cursor = JSON.parse(input.cursor);
      } catch {
        invalidQuery();
      }
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 8 ||
        cursor[0] !== 1 ||
        cursor[1] !== namespace ||
        cursor[2] !== "events" ||
        cursor[3] !== scope ||
        cursor[4] !== (input.sinceReceivedAtMs ?? 0) ||
        cursor[5] !== input.beforeReceivedAtMs ||
        !Number.isSafeInteger(cursor[6]) ||
        (cursor[6] as number) < 0 ||
        typeof cursor[7] !== "string"
      ) {
        invalidQuery();
      }
      const decodedCursor = cursor as unknown[];
      cursorBoundary = {
        receivedAtMs: decodedCursor[6] as number,
        eventId: decodedCursor[7] as string,
      };
    }
    const rows = store.events
      .map(({ row }) => row)
      .filter(
        (row) =>
          row.received_at_ms >= (input.sinceReceivedAtMs ?? 0) &&
          row.received_at_ms < input.beforeReceivedAtMs &&
          (input.selector.kind === "all" ||
            (input.selector.kind === "installationId" &&
              isMovement(row) &&
              row.install_id === input.selector.installId) ||
            (input.selector.kind === "bundleId" &&
              ((row.type === "UPDATE_APPLIED" &&
                row.to_bundle_id === input.selector.bundleId) ||
                (row.type === "RECOVERED" &&
                  row.from_bundle_id === input.selector.bundleId)))),
      )
      .filter(
        (row) =>
          cursorBoundary === undefined ||
          row.received_at_ms < cursorBoundary.receivedAtMs ||
          (row.received_at_ms === cursorBoundary.receivedAtMs &&
            row.id < cursorBoundary.eventId),
      )
      .sort(compareEvents);
    store.lastStorageReads = Math.min(rows.length, input.limit + 1);
    const data = rows.slice(0, input.limit);
    const hasNext = rows.length > input.limit;
    const last = data.at(-1);
    const nextCursor =
      !hasNext || last === undefined
        ? null
        : encodeCursor([
            1,
            namespace,
            "events",
            scope,
            input.sinceReceivedAtMs ?? 0,
            input.beforeReceivedAtMs,
            last.received_at_ms,
            last.id,
          ]);
    const result: InsightsPageEventsResult = {
      state: "ready",
      versions: versions(store.generation, false),
      data: {
        data,
        nextCursor,
        hasNext,
        consistency: {
          kind: "live",
          cutoff: {
            kind: "event-time",
            beforeReceivedAtMs: input.beforeReceivedAtMs,
          },
        },
        total: { state: "unavailable" },
      },
    };
    assertInsightsPageContract(result, input.limit);
    return result;
  },

  pageInstallations: async function pageInstallations(
    input: InsightsInstallationPageInput,
  ): Promise<InsightsInstallationPage> {
    input = readInsightsInstallationPageInput(input);
    if (input.kind === "all" || input.kind === "installationId") {
      if (
        input.kind === "installationId" &&
        Reflect.get(input, "cursor") !== undefined
      ) {
        invalidQuery();
      }
      const cursorGeneration =
        input.cursor === undefined
          ? store.generation
          : Number(JSON.parse(input.cursor).at(-2));
      const scope =
        input.kind === "all" ? "all" : `installation:${input.installId}`;
      const offset = decodeCursor(input.cursor, [
        1,
        namespace,
        "installations-live",
        scope,
        cursorGeneration,
      ]);
      let rows = await orderInstallations(
        latestInstallations(store.events, cursorGeneration),
      );
      if (input.kind === "installationId") {
        rows = rows.filter((row) => row.install_id === input.installId);
      }
      store.lastStorageReads = Math.min(
        Math.max(0, rows.length - offset),
        input.limit + 1,
      );
      const bounded = pageRows(rows, offset, input.limit);
      const nextCursor =
        bounded.nextOffset === null
          ? null
          : encodeCursor([
              1,
              namespace,
              "installations-live",
              scope,
              cursorGeneration,
              bounded.nextOffset,
            ]);
      const result: InsightsInstallationPage = {
        state: "ready",
        versions: versions(cursorGeneration),
        data: {
          data: bounded.data,
          nextCursor,
          hasNext: nextCursor !== null,
          consistency: {
            kind: "live",
            cutoff: {
              kind: "projection",
              observedAtMs: cursorGeneration,
              projectionGeneration: `projection-${cursorGeneration}`,
            },
          },
          total: { state: "unavailable" },
        },
      };
      assertInsightsPageContract(result, input.limit);
      return result;
    }

    const key = semanticInstallationKey(input);
    const cursorPublicationId = publishedInstallationCursorPublication(
      input.cursor,
      namespace,
      key,
    );
    if (
      input.publicationId !== undefined &&
      cursorPublicationId !== undefined &&
      input.publicationId !== cursorPublicationId
    ) {
      invalidQuery();
    }
    const requestedPublicationId = input.publicationId ?? cursorPublicationId;
    const pinned =
      requestedPublicationId === undefined
        ? undefined
        : store.publications.get(requestedPublicationId);
    if (
      requestedPublicationId !== undefined &&
      (pinned === undefined ||
        pinned.kind !== "installation" ||
        pinned.queryKey !== key ||
        pinned.asOfMs < (input.minAsOfMs ?? 0) ||
        store.expiredPublications.has(requestedPublicationId))
    ) {
      return { state: "expired", publicationId: requestedPublicationId };
    }
    const previous = pinned ?? latestPublication(store, "installation", key);
    const fresh =
      previous !== undefined &&
      previous.kind === "installation" &&
      previous.asOfMs >= (input.minAsOfMs ?? 0);
    if (!fresh) {
      const job = reserveJob(store, "installation", key, input);
      if (job.status === "failed") {
        return {
          state: "failed",
          versions: versions(job.sourceGeneration),
          error: { code: "migration-poison", jobId: job.id },
        };
      }
      if (previous === undefined || previous.kind !== "installation") {
        return {
          state: "preparing",
          versions: versions(job.sourceGeneration),
          job: { id: job.id },
        };
      }
    }
    const publication = previous as InstallationPublication;
    const offset = decodeCursor(input.cursor, [
      1,
      namespace,
      "installations-published",
      key,
      publication.id,
    ]);
    store.lastStorageReads = Math.min(
      Math.max(0, publication.rows.length - offset),
      input.limit + 1,
    );
    const bounded = pageRows(publication.rows, offset, input.limit);
    const nextCursor =
      bounded.nextOffset === null
        ? null
        : encodeCursor([
            1,
            namespace,
            "installations-published",
            key,
            publication.id,
            bounded.nextOffset,
          ]);
    const data = {
      data: bounded.data,
      nextCursor,
      hasNext: nextCursor !== null,
      consistency: {
        kind: "snapshot" as const,
        cutoff: {
          kind: "publication" as const,
          publication: {
            id: publication.id,
            asOfMs: publication.asOfMs,
            completedAtMs: publication.completedAtMs,
            sourceGeneration: publication.sourceGeneration,
            accuracy: publication.accuracy,
          },
        },
      },
      total: {
        state: "exact" as const,
        value: publication.rows.length,
        sourceGeneration: publication.sourceGeneration,
      },
    };
    const activeJob = [...store.jobs.values()].find(
      (job) =>
        job.kind === "installation" &&
        job.key === key &&
        job.status === "active",
    );
    const result: InsightsInstallationPage =
      fresh || activeJob === undefined
        ? {
            state: "ready",
            versions: {
              ...versions(store.generation),
              projectionGeneration: publication.projectionGeneration,
              sourceGeneration: publication.sourceGeneration,
            },
            data,
          }
        : {
            state: "stale",
            versions: {
              ...versions(store.generation),
              projectionGeneration: publication.projectionGeneration,
              sourceGeneration: publication.sourceGeneration,
            },
            data,
            refresh: { id: activeJob.id },
          };
    assertInsightsPageContract(result, input.limit);
    return result;
  } as InsightsModel["pageInstallations"],

  async getReport(input): Promise<InsightsReportResult> {
    assertInsightsQueryContract(input);
    const key = semanticReportKey(input);
    const previous = latestPublication(store, "report", key);
    const fresh =
      previous !== undefined &&
      previous.kind !== "installation" &&
      previous.asOfMs >= (input.minAsOfMs ?? 0);
    if (!fresh) {
      const job = reserveJob(store, "report", key, input);
      if (job.status === "failed") {
        const failed: InsightsReportResult = {
          state: "failed",
          versions: versions(job.sourceGeneration),
          error: { code: "migration-poison", jobId: job.id },
        };
        assertInsightsReportResultContract(failed);
        return failed;
      }
      if (previous === undefined || previous.kind === "installation") {
        const preparing: InsightsReportResult = {
          state: "preparing",
          versions: versions(job.sourceGeneration),
          job: { id: job.id },
        };
        assertInsightsReportResultContract(preparing);
        return preparing;
      }
    }
    const publication = previous as ReportPublication;
    const activeJob = [...store.jobs.values()].find(
      (job) =>
        job.kind === "report" && job.key === key && job.status === "active",
    );
    const result: InsightsReportResult =
      fresh || activeJob === undefined
        ? {
            state: "ready",
            versions: {
              ...versions(store.generation),
              projectionGeneration: publication.projectionGeneration,
              sourceGeneration: publication.sourceGeneration,
            },
            data: publicReport(publication),
          }
        : {
            state: "stale",
            versions: {
              ...versions(store.generation),
              projectionGeneration: publication.projectionGeneration,
              sourceGeneration: publication.sourceGeneration,
            },
            data: publicReport(publication),
            refresh: { id: activeJob.id },
          };
    assertInsightsReportResultContract(result);
    return result;
  },

  async pageReport(
    input: InsightsReportPageInput,
  ): Promise<InsightsReportPage> {
    const parsed = readInsightsReportPageQuery(input, namespace);
    const publication = store.publications.get(input.publicationId);
    if (
      publication === undefined ||
      publication.kind === "installation" ||
      store.expiredPublications.has(input.publicationId)
    ) {
      return { state: "expired", publicationId: input.publicationId };
    }
    const validSection =
      (publication.kind === "bundleDetail" &&
        (input.section === "movementSeries" ||
          input.section === "movementCohorts")) ||
      (publication.kind === "installationOverview" &&
        input.section === "bundleDistribution") ||
      (publication.kind === "activeOverview" &&
        (input.section === "activeSeries" ||
          input.section === "bundleDistribution" ||
          input.section === "activeBundleSeries"));
    if (!validSection) invalidQuery();
    const sectionKey =
      input.section === "movementSeries" || input.section === "movementCohorts"
        ? `${input.section}:${input.metric}`
        : input.section;
    const parsedOrdinal = BigInt(parsed.nextOrdinal);
    const offset =
      parsedOrdinal > BigInt(Number.MAX_SAFE_INTEGER)
        ? Number.MAX_SAFE_INTEGER
        : Number(parsedOrdinal);
    const sectionRows = publication.sections[sectionKey]!.filter((row) =>
      input.section === "activeBundleSeries" && input.bundleId !== undefined
        ? row.bundleId === input.bundleId
        : true,
    );
    store.lastStorageReads = Math.min(
      Math.max(0, sectionRows.length - offset),
      input.limit + 1,
    );
    const bounded = pageRows(sectionRows, offset, input.limit);
    const nextCursor =
      bounded.nextOffset === null
        ? null
        : createInsightsReportPageCursor(
            input,
            String(bounded.nextOffset),
            namespace,
          );
    const data = {
      section: input.section,
      ...("metric" in input ? { metric: input.metric } : {}),
      data: bounded.data,
      nextCursor,
      hasNext: nextCursor !== null,
      consistency: {
        kind: "snapshot" as const,
        cutoff: {
          kind: "publication" as const,
          publication: {
            id: publication.id,
            asOfMs: publication.asOfMs,
            completedAtMs: publication.completedAtMs,
            sourceGeneration: publication.sourceGeneration,
            accuracy: publication.accuracy,
          },
        },
      },
      total: {
        state: "exact" as const,
        value: sectionRows.length,
        sourceGeneration: publication.sourceGeneration,
      },
    };
    const result = {
      state: "ready" as const,
      versions: {
        ...versions(store.generation),
        projectionGeneration: publication.projectionGeneration,
        sourceGeneration: publication.sourceGeneration,
      },
      data,
    } as InsightsReportPage;
    assertInsightsReportPageResultContract(result, input.limit);
    return result;
  },
});

const runOracleJobStep = async (
  store: OracleStore,
  jobId: string,
  input: { readonly maxItems: number; readonly maxRequests: number },
): Promise<InsightsMaintenanceStepResult> => {
  assertInsightsMaintenanceInputContract(input);
  const job = store.jobs.get(jobId);
  if (job === undefined || job.status !== "active") {
    throw new Error("unknown-active-job");
  }
  if (
    store.poisonGenerations.some(
      (generation) => generation <= job.sourceGeneration,
    )
  ) {
    job.status = "failed";
    return {
      state: "failed",
      jobId: job.id,
      usage: { items: 1, requests: 1 },
    };
  }
  const frozenEvents = store.events.filter(
    (event) => event.generation <= job.sourceGeneration,
  );
  const frozenItemCount = frozenEvents.length;
  const previousProcessedItems = job.processedItems;
  job.processedItems = Math.min(
    frozenItemCount,
    job.processedItems + input.maxItems,
  );
  const usage = {
    items: job.processedItems - previousProcessedItems,
    requests: 1,
    bytes: frozenEvents
      .slice(previousProcessedItems, job.processedItems)
      .reduce(
        (total, event) => total + getCanonicalInsightsJsonByteLength(event.row),
        0,
      ),
  };
  if (job.processedItems < frozenItemCount) {
    return { state: "running", jobId: job.id, usage };
  }
  const publicationId = `publication-${store.nextPublication++}`;
  const asOfMs = job.asOfMs;
  let publication: OraclePublication;
  if (job.kind === "installation") {
    const input = job.input as InsightsInstallationPageInput;
    const latest = latestInstallations(frozenEvents, job.sourceGeneration);
    const query =
      input.kind === "userId"
        ? input.userId
        : input.kind === "contains"
          ? input.query
          : "";
    const lowered = query.toLowerCase();
    const matchingIds = new Set(
      frozenEvents
        .filter(({ row }) =>
          input.kind === "userId"
            ? row.user_id === query
            : [row.install_id, row.user_id, row.username].some(
                (value) =>
                  value !== null && value.toLowerCase().includes(lowered),
              ),
        )
        .map(({ row }) => row.install_id),
    );
    publication = {
      id: publicationId,
      asOfMs,
      completedAtMs: asOfMs,
      sourceGeneration: sourceGeneration(job.sourceGeneration),
      accuracy: "exact",
      kind: "installation",
      queryKey: job.key,
      projectionGeneration: `projection-${job.sourceGeneration}`,
      rows: await orderInstallations(
        latest.filter((row) => matchingIds.has(row.install_id)),
      ),
    };
  } else {
    publication = reportPublication(
      store,
      publicationId,
      job.input as InsightsReportInput,
      job.sourceGeneration,
      job.asOfMs,
      job.key,
    );
  }
  store.publications.set(publicationId, publication);
  job.publicationId = publicationId;
  job.status = "complete";
  return { state: "complete", publicationId, usage };
};

const createOracleFacade = (
  namespaces: InsightsModelConformanceNamespaces,
  primary: OracleStore,
  secondary: OracleStore,
): InsightsModelOracle => {
  const model = createModel(namespaces.insightsDatabaseNamespace, primary);
  const otherNamespaceModel = createModel(
    namespaces.otherInsightsDatabaseNamespace,
    secondary,
  );

  return {
    model,
    otherNamespaceModel,
    runJobStep: (jobId, input) => runOracleJobStep(primary, jobId, input),
    runOtherNamespaceJobStep: (jobId, input) =>
      runOracleJobStep(secondary, jobId, input),
    reopen: () => createOracleFacade(namespaces, primary, secondary),
    insertMigrationPoisonRow() {
      primary.generation += 1;
      primary.poisonGenerations.push(primary.generation);
    },
    setCurrentTimeMs(nowMs) {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new Error("invalid-time");
      }
      primary.nowMs = nowMs;
      secondary.nowMs = nowMs;
    },
    expirePublication(publicationId) {
      primary.expiredPublications.add(publicationId);
      primary.publications.delete(publicationId);
    },
    publicationStateForJob(jobId) {
      const publicationId = primary.jobs.get(jobId)?.publicationId;
      return publicationId !== undefined &&
        primary.publications.has(publicationId)
        ? "complete"
        : "absent";
    },
    getLastStorageReadCount: (namespace = "primary") =>
      namespace === "primary"
        ? primary.lastStorageReads
        : secondary.lastStorageReads,
    getPageEventsCandidateReadBudget: (input) => input.limit + 1,
    getPageInstallationsCandidateReadBudget: (input) => input.limit + 1,
    getPageReportCandidateReadBudget: (input) => input.limit + 1,
  };
};

export const createInsightsModelOracle = (
  namespaces: InsightsModelConformanceNamespaces,
): InsightsModelOracle => {
  if (
    !isCanonicalInsightsDatabaseNamespace(
      namespaces.insightsDatabaseNamespace,
    ) ||
    !isCanonicalInsightsDatabaseNamespace(
      namespaces.otherInsightsDatabaseNamespace,
    ) ||
    namespaces.insightsDatabaseNamespace ===
      namespaces.otherInsightsDatabaseNamespace
  ) {
    throw new Error("Insights database namespaces must be distinct UUIDs");
  }
  return createOracleFacade(namespaces, createStore(), createStore());
};
