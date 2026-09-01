import {
  DatabasePluginInputError,
  type BundleEventRow,
  type InsightsInstallationRow,
} from "@hot-updater/plugin-core";
import {
  assertInsightsEventContract,
  assertInsightsMaintenanceInputContract,
  canonicalInsightsJson,
  getCanonicalInsightsJsonByteLength,
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
} from "@hot-updater/plugin-core/internal";
import {
  FieldPath,
  type CollectionReference,
  type DocumentData,
  type Firestore,
} from "firebase-admin/firestore";

import { parseFirebaseBundleEventRow } from "./firebaseDatabaseParser";
import {
  FIREBASE_INSIGHTS_INDEX_REVISION,
  FIREBASE_INSIGHTS_LAYOUT_VERSION,
  FIREBASE_INSIGHTS_SOURCE_IDS,
  FIREBASE_INSIGHTS_SOURCE_SHARDS,
  assertFirebaseInstallationIdentity,
  assertFirebaseEventInput,
  firebaseEventDocumentId,
  firebaseEventScopeKey,
  firebaseEventSourceShard,
  firebaseInstallationKey,
  firebaseInstallationSourceHeadId,
  firebaseInstallationSourceVersionId,
  isFirebaseEventId,
  toFirebaseEventDocument,
} from "./firebaseEventIndex";
import { type FirebaseInsightsCollections } from "./firebaseInsights";

const MAX_STEP_EVENTS = 100;
const MAX_RAW_AUDIT_EVENTS = 2;
const MAX_PROJECT_EVENTS = 45;

export type FirebaseInsightsSourceShard = number | "legacy";

const invalidQuery = (): never => {
  throw new DatabasePluginInputError("invalid-query");
};

const validateLimit = (limit: number): void => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_STEP_EVENTS) {
    invalidQuery();
  }
};

const assertMaintenanceBytes = (value: unknown): void => {
  if (
    getCanonicalInsightsJsonByteLength(value) >
    INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES
  ) {
    throw new DatabasePluginInputError("invalid-result");
  }
};

const liveClockId = (shard: number): string =>
  `live_${shard.toString(16).padStart(2, "0")}`;

const isSourceId = (value: string): boolean =>
  FIREBASE_INSIGHTS_SOURCE_IDS.some((sourceId) => sourceId === value);

export const firebaseInsightsSourceClockId = (
  sourceShard: FirebaseInsightsSourceShard,
): string => (sourceShard === "legacy" ? "legacy" : liveClockId(sourceShard));

const readSequence = (value: unknown): number => {
  const sequence =
    typeof value === "object" && value !== null
      ? Reflect.get(value, "sequence")
      : undefined;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return sequence as number;
};

const readSourceClock = (
  value: unknown,
  sourceShard: FirebaseInsightsSourceShard,
): { readonly sequence: number; readonly observedAtMs: number } => {
  if (
    typeof value !== "object" ||
    value === null ||
    Reflect.get(value, "version") !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
    Reflect.get(value, "shard") !== sourceShard
  ) {
    throw new DatabasePluginInputError("invalid-result");
  }
  const sequence = readSequence(value);
  const observedAtMs = Reflect.get(value, "observedAtMs");
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return { sequence, observedAtMs };
};

const installationProjection = (
  row: BundleEventRow,
): InsightsInstallationRow => ({
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

const readInstallationProjection = (
  value: unknown,
  installKey: string,
): InsightsInstallationRow => {
  if (typeof value !== "object" || value === null) {
    throw new DatabasePluginInputError("invalid-result");
  }
  const row = value as InsightsInstallationRow;
  if (
    !isFirebaseEventId(row.id) ||
    typeof row.install_id !== "string" ||
    firebaseInstallationKey(row.install_id) !== installKey ||
    !Number.isSafeInteger(row.received_at_ms) ||
    row.received_at_ms < 0
  ) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return row;
};

const isLaterProjection = (
  left: InsightsInstallationRow,
  right: InsightsInstallationRow,
): boolean =>
  left.received_at_ms > right.received_at_ms ||
  (left.received_at_ms === right.received_at_ms && left.id > right.id);

const storedEventRow = (data: DocumentData, source: string): BundleEventRow => {
  const row = parseFirebaseBundleEventRow(data, source);
  assertFirebaseEventInput(row);
  return row;
};

const legacyEventRow = (data: DocumentData, source: string): BundleEventRow => {
  // Legacy extensions are untrusted and remain inside this full raw audit.
  assertInsightsEventContract(data);
  return storedEventRow(data, source);
};

export const appendFirebaseInsightsEvent = async (
  db: Firestore,
  collections: FirebaseInsightsCollections,
  row: BundleEventRow,
): Promise<void> => {
  assertFirebaseEventInput(row);
  const sourceShard = firebaseEventSourceShard(row.id);
  const sourceId = liveClockId(sourceShard);
  const clock = collections.sourceClocks.doc(sourceId);
  const destination = collections.events.doc(firebaseEventDocumentId(row.id));
  const installationKey = firebaseInstallationKey(row.install_id);
  const installation = collections.installations.doc(installationKey);
  const sourceHead = collections.installationVersions.doc(
    firebaseInstallationSourceHeadId(installationKey, sourceId),
  );
  const observedAtMs = Date.now();
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    return invalidQuery();
  }
  await db.runTransaction(async (transaction) => {
    const documents = await transaction.getAll(clock, installation, sourceHead);
    const [clockDocument, installationDocument, sourceHeadDocument] = documents;
    if (!clockDocument.exists) {
      throw new DatabasePluginInputError("invalid-result");
    }
    const savedClock = readSourceClock(clockDocument.data(), sourceShard);
    if (savedClock.sequence === Number.MAX_SAFE_INTEGER) {
      throw new DatabasePluginInputError("invalid-result");
    }
    const sequence = savedClock.sequence + 1;
    let current: BundleEventRow | undefined;
    let firstSourceId = sourceId;
    let firstSourceSequence = sequence;
    let sourceIds = [sourceId];
    let hadSource = false;
    if (installationDocument.exists) {
      const data = installationDocument.data()!;
      current = storedEventRow(data, installationDocument.ref.path);
      assertFirebaseInstallationIdentity(
        row.install_id,
        installationDocument.id,
        current.install_id,
      );
      firstSourceId = data._insights_first_source_id;
      firstSourceSequence = data._insights_first_source_seq;
      sourceIds = data._insights_source_ids;
      if (
        typeof firstSourceId !== "string" ||
        !isSourceId(firstSourceId) ||
        !Number.isSafeInteger(firstSourceSequence) ||
        firstSourceSequence < 1 ||
        !Array.isArray(sourceIds) ||
        sourceIds.some((id) => typeof id !== "string" || !isSourceId(id)) ||
        new Set(sourceIds).size !== sourceIds.length
      ) {
        throw new DatabasePluginInputError("invalid-result");
      }
      hadSource = sourceIds.includes(sourceId);
      if (!hadSource) sourceIds = [...sourceIds, sourceId];
    }
    let sourceWinner = installationProjection(row);
    if (sourceHeadDocument.exists) {
      const data = sourceHeadDocument.data()!;
      if (
        data.version !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
        data.recordKind !== "sourceHead" ||
        data.installKey !== installationKey ||
        data.sourceId !== sourceId ||
        !Number.isSafeInteger(data.sourceSequence) ||
        data.sourceSequence < 1 ||
        data.sourceSequence > savedClock.sequence
      ) {
        throw new DatabasePluginInputError("invalid-result");
      }
      const savedWinner = readInstallationProjection(data.row, installationKey);
      if (isLaterProjection(savedWinner, sourceWinner)) {
        sourceWinner = savedWinner;
      }
    } else if (installationDocument.exists && hadSource) {
      throw new DatabasePluginInputError("invalid-result");
    }
    transaction.create(
      destination,
      toFirebaseEventDocument(row, sequence, sourceShard),
    );
    transaction.set(clock, {
      version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
      shard: sourceShard,
      sequence,
      observedAtMs,
    });
    transaction.create(
      collections.installationVersions.doc(
        firebaseInstallationSourceVersionId(
          installationKey,
          sourceId,
          sequence,
        ),
      ),
      {
        version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
        recordKind: "prefix",
        installKey: installationKey,
        sourceId,
        sourceSequence: sequence,
        row: sourceWinner,
      },
    );
    transaction.set(sourceHead, {
      version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
      recordKind: "sourceHead",
      installKey: installationKey,
      sourceId,
      sourceSequence: sequence,
      row: sourceWinner,
    });
    const winner =
      current === undefined ||
      row.received_at_ms > current.received_at_ms ||
      (row.received_at_ms === current.received_at_ms && row.id > current.id)
        ? row
        : current;
    transaction.set(installation, {
      ...winner,
      _insights_first_source_id: firstSourceId,
      _insights_first_source_seq: firstSourceSequence,
      _insights_source_ids: [...sourceIds].sort(),
    });
  });
};

export interface PrepareFirebaseInsightsInput {
  /** The old v1 writer must be stopped before the first step. */
  readonly writersDrained: true;
  /** Explicit production acknowledgement for the shipped index revision. */
  readonly indexesReady: true;
  readonly maxItems: number;
  readonly maxRequests: number;
}

export type PrepareFirebaseInsightsResult =
  | { readonly state: "building" | "ready"; readonly processed: number }
  | {
      readonly state: "failed";
      readonly processed: number;
      readonly poisonId: string;
    };

export interface RepairFirebaseInsightsPoisonInput {
  readonly maxItems: number;
  readonly maxRequests: number;
}

export type RepairFirebaseInsightsPoisonResult =
  | { readonly state: "building"; readonly repairedDocumentId: string }
  | { readonly state: "failed"; readonly poisonId: string };

export const prepareFirebaseInsightsStep = async (
  db: Firestore,
  legacyEvents: CollectionReference<DocumentData>,
  collections: FirebaseInsightsCollections,
  input: PrepareFirebaseInsightsInput,
): Promise<PrepareFirebaseInsightsResult> => {
  if (input.writersDrained !== true || input.indexesReady !== true) {
    return invalidQuery();
  }
  validateLimit(input.maxItems);
  assertInsightsMaintenanceInputContract(input);
  if (input.maxRequests < 4) return invalidQuery();
  const layout = collections.control.doc("layout");
  const legacyClock = collections.sourceClocks.doc("legacy");
  return db.runTransaction(
    async (transaction): Promise<PrepareFirebaseInsightsResult> => {
      const saved = await transaction.get(layout);
      const state = saved.data();
      if (state?.state === "failed") {
        return {
          state: "failed",
          processed: 0,
          poisonId: String(state.poisonId),
        };
      }
      if (state?.state === "ready") {
        if (
          state.version !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
          state.indexRevision !== FIREBASE_INSIGHTS_INDEX_REVISION
        ) {
          throw new DatabasePluginInputError("invalid-result");
        }
        const readyDocuments = await transaction.getAll(
          collections.control.doc("projection"),
          ...FIREBASE_INSIGHTS_SOURCE_IDS.flatMap((sourceId) => [
            collections.sourceClocks.doc(sourceId),
            collections.control.doc(`projection_checkpoint_${sourceId}`),
          ]),
        );
        const projection = readyDocuments[0]!;
        const checkpointVector = FIREBASE_INSIGHTS_SOURCE_IDS.map(
          (sourceId, index) => {
            const sourceShard: FirebaseInsightsSourceShard =
              sourceId === "legacy"
                ? "legacy"
                : Number.parseInt(sourceId.slice("live_".length), 16);
            const clock = readyDocuments[index * 2 + 1]!;
            const checkpoint = readyDocuments[index * 2 + 2]!;
            if (
              !clock.exists ||
              !checkpoint.exists ||
              checkpoint.data()?.version !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
              checkpoint.data()?.shard !== sourceShard
            ) {
              throw new DatabasePluginInputError("invalid-result");
            }
            const sourceSequence = readSourceClock(
              clock.data(),
              sourceShard,
            ).sequence;
            const projectedSequence = readSequence(checkpoint.data());
            if (projectedSequence > sourceSequence) {
              throw new DatabasePluginInputError("invalid-result");
            }
            return [sourceId, projectedSequence] as const;
          },
        );
        const projectionData = projection.data();
        if (
          !projection.exists ||
          projectionData?.version !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
          projectionData.state !== "ready" ||
          projectionData.generation !==
            firebaseEventScopeKey(JSON.stringify(checkpointVector)) ||
          !Number.isSafeInteger(projectionData.observedAtMs) ||
          projectionData.observedAtMs < 0
        ) {
          throw new DatabasePluginInputError("invalid-result");
        }
        return { state: "ready", processed: 0 };
      }
      if (state === undefined) {
        const first = await transaction.get(
          legacyEvents.orderBy(FieldPath.documentId(), "asc").limit(1),
        );
        const nextState = first.empty ? "ready" : "building";
        transaction.create(layout, {
          version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
          state: nextState,
          indexRevision: FIREBASE_INSIGHTS_INDEX_REVISION,
          afterId: null,
          revision: 1,
        });
        for (const sourceId of FIREBASE_INSIGHTS_SOURCE_IDS) {
          const sourceShard =
            sourceId === "legacy"
              ? "legacy"
              : Number.parseInt(sourceId.slice("live_".length), 16);
          transaction.create(collections.sourceClocks.doc(sourceId), {
            version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
            shard: sourceShard,
            sequence: 0,
            observedAtMs: 0,
          });
          transaction.create(
            collections.control.doc(`projection_checkpoint_${sourceId}`),
            {
              version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
              shard: sourceShard,
              sequence: 0,
            },
          );
        }
        if (first.empty) {
          const vector = FIREBASE_INSIGHTS_SOURCE_IDS.map(
            (sourceId) => [sourceId, 0] as const,
          );
          transaction.create(collections.control.doc("projection"), {
            version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
            state: "ready",
            generation: firebaseEventScopeKey(JSON.stringify(vector)),
            observedAtMs: 0,
          });
        }
        return { state: nextState, processed: 0 };
      }
      if (
        state.version !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
        state.state !== "building" ||
        state.indexRevision !== FIREBASE_INSIGHTS_INDEX_REVISION ||
        (state.afterId !== null && typeof state.afterId !== "string") ||
        !Number.isSafeInteger(state.revision)
      ) {
        throw new DatabasePluginInputError("invalid-result");
      }
      let query = legacyEvents.orderBy(FieldPath.documentId(), "asc");
      if (state.afterId !== null) query = query.startAfter(state.afterId);
      const maxItems = Math.min(input.maxItems, MAX_RAW_AUDIT_EVENTS);
      const candidates = await transaction.get(query.limit(maxItems + 1));
      assertMaintenanceBytes(
        candidates.docs.map((document) => document.data()),
      );
      const documents = candidates.docs.slice(0, maxItems);
      const clockDocument = await transaction.get(legacyClock);
      if (!clockDocument.exists) {
        throw new DatabasePluginInputError("invalid-result");
      }
      const legacyClockData = readSourceClock(clockDocument.data(), "legacy");
      let sequence = legacyClockData.sequence;
      let inputBytes = 0;
      const rows: { id: string; row: BundleEventRow; sequence: number }[] = [];
      for (const document of documents) {
        try {
          inputBytes += getCanonicalInsightsJsonByteLength(document.data());
          assertMaintenanceBytes(documents.map((item) => item.data()));
          const row = legacyEventRow(document.data(), document.ref.path);
          if (document.id !== row.id) {
            throw new DatabasePluginInputError("invalid-result");
          }
          if (sequence === Number.MAX_SAFE_INTEGER) {
            throw new DatabasePluginInputError("invalid-result");
          }
          sequence += 1;
          rows.push({ id: document.id, row, sequence });
        } catch (error) {
          const poisonId = firebaseEventScopeKey(document.id);
          transaction.set(collections.poison.doc(poisonId), {
            version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
            source: "legacy",
            documentId: document.id,
            reason:
              error instanceof Error ? error.name : "UnknownMigrationError",
          });
          transaction.update(layout, {
            state: "failed",
            poisonId,
            revision: state.revision + 1,
          });
          return { state: "failed", processed: 0, poisonId };
        }
      }
      if (inputBytes > 4 * 1024 * 1024) {
        throw new DatabasePluginInputError("invalid-result");
      }
      for (const item of rows) {
        transaction.create(
          collections.events.doc(firebaseEventDocumentId(item.row.id)),
          toFirebaseEventDocument(item.row, item.sequence, "legacy"),
        );
      }
      transaction.set(legacyClock, {
        version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
        shard: "legacy",
        sequence,
        observedAtMs: legacyClockData.observedAtMs,
      });
      transaction.delete(collections.control.doc("projection"));
      const afterId = documents.at(-1)?.id ?? state.afterId;
      const nextState = candidates.size <= maxItems ? "ready" : "building";
      transaction.update(layout, {
        state: nextState,
        afterId,
        revision: state.revision + 1,
      });
      return { state: nextState, processed: documents.length };
    },
    { maxAttempts: 1 },
  );
};

export const repairFirebaseInsightsPoisonStep = async (
  db: Firestore,
  legacyEvents: CollectionReference<DocumentData>,
  collections: FirebaseInsightsCollections,
  input: RepairFirebaseInsightsPoisonInput,
): Promise<RepairFirebaseInsightsPoisonResult> => {
  assertInsightsMaintenanceInputContract(input);
  if (input.maxItems < 1 || input.maxRequests < 4) return invalidQuery();
  return db.runTransaction(
    async (transaction): Promise<RepairFirebaseInsightsPoisonResult> => {
      const layoutRef = collections.control.doc("layout");
      const layout = await transaction.get(layoutRef);
      const state = layout.data();
      if (
        state?.version !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
        state.state !== "failed" ||
        typeof state.poisonId !== "string" ||
        (state.afterId !== null && typeof state.afterId !== "string") ||
        !Number.isSafeInteger(state.revision)
      ) {
        return invalidQuery();
      }
      const poisonRef = collections.poison.doc(state.poisonId);
      const poison = await transaction.get(poisonRef);
      const poisonData = poison.data();
      if (
        poisonData?.version !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
        poisonData.source !== "legacy" ||
        typeof poisonData.documentId !== "string"
      ) {
        throw new DatabasePluginInputError("invalid-result");
      }
      const raw = await transaction.get(
        legacyEvents.doc(poisonData.documentId),
      );
      if (raw.exists) {
        try {
          assertMaintenanceBytes(raw.data());
          const row = legacyEventRow(raw.data()!, raw.ref.path);
          if (row.id !== raw.id) {
            throw new DatabasePluginInputError("invalid-result");
          }
        } catch {
          return { state: "failed", poisonId: state.poisonId };
        }
      }
      transaction.delete(poisonRef);
      transaction.update(layoutRef, {
        state: "building",
        poisonId: null,
        revision: state.revision + 1,
      });
      return {
        state: "building",
        repairedDocumentId: poisonData.documentId,
      };
    },
    { maxAttempts: 1 },
  );
};

export interface ProjectFirebaseInsightsInput {
  readonly sourceShard: FirebaseInsightsSourceShard;
  readonly maxItems: number;
  readonly maxRequests: number;
}

export interface ProjectFirebaseInsightsResult {
  readonly state: "building" | "caught-up";
  readonly processed: number;
  readonly afterSequence: number;
  readonly upperSequence: number;
}

export const projectFirebaseInsightsStep = async (
  db: Firestore,
  collections: FirebaseInsightsCollections,
  input: ProjectFirebaseInsightsInput,
): Promise<ProjectFirebaseInsightsResult> => {
  validateLimit(input.maxItems);
  if (
    input.sourceShard !== "legacy" &&
    (!Number.isSafeInteger(input.sourceShard) ||
      input.sourceShard < 0 ||
      input.sourceShard >= FIREBASE_INSIGHTS_SOURCE_SHARDS)
  ) {
    return invalidQuery();
  }
  assertInsightsMaintenanceInputContract(input);
  if (input.maxRequests < 4) return invalidQuery();
  const clockId = firebaseInsightsSourceClockId(input.sourceShard);
  const checkpoint = collections.control.doc(
    `projection_checkpoint_${clockId}`,
  );
  return db.runTransaction(
    async (transaction): Promise<ProjectFirebaseInsightsResult> => {
      const [layout, clock, saved] = await transaction.getAll(
        collections.control.doc("layout"),
        collections.sourceClocks.doc(clockId),
        checkpoint,
      );
      if (layout.data()?.state !== "ready") {
        throw new DatabasePluginInputError("invalid-operation");
      }
      if (!clock.exists || !saved.exists) {
        throw new DatabasePluginInputError("invalid-result");
      }
      const upperSequence = readSourceClock(
        clock.data(),
        input.sourceShard,
      ).sequence;
      if (
        saved.data()?.version !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
        saved.data()?.shard !== input.sourceShard
      ) {
        throw new DatabasePluginInputError("invalid-result");
      }
      const afterSequence = readSequence(saved.data());
      if (afterSequence > upperSequence) {
        throw new DatabasePluginInputError("invalid-result");
      }
      const documents = await transaction.get(
        collections.events
          .where("_insights_source_shard", "==", input.sourceShard)
          .where("_insights_source_seq", ">", afterSequence)
          .where("_insights_source_seq", "<=", upperSequence)
          .orderBy("_insights_source_seq", "asc")
          .limit(Math.min(input.maxItems, MAX_PROJECT_EVENTS)),
      );
      const events = documents.docs.map((document, index) => {
        const row = storedEventRow(document.data(), document.ref.path);
        const sequence = document.data()._insights_source_seq;
        if (
          document.id !== firebaseEventDocumentId(row.id) ||
          document.data()._insights_source_shard !== input.sourceShard ||
          sequence !== afterSequence + index + 1
        ) {
          throw new DatabasePluginInputError("invalid-result");
        }
        return { row, sequence: sequence as number };
      });
      if (
        events.length < Math.min(input.maxItems, MAX_PROJECT_EVENTS) &&
        (events.at(-1)?.sequence ?? afterSequence) !== upperSequence
      ) {
        throw new DatabasePluginInputError("invalid-result");
      }
      const installKeys = [
        ...new Set(
          events.map(({ row }) => firebaseInstallationKey(row.install_id)),
        ),
      ];
      const sourceHeads = installKeys.map((key) =>
        collections.installationVersions.doc(
          firebaseInstallationSourceHeadId(key, clockId),
        ),
      );
      const versionRefs = events.map(({ row, sequence }) =>
        collections.installationVersions.doc(
          firebaseInstallationSourceVersionId(
            firebaseInstallationKey(row.install_id),
            clockId,
            sequence,
          ),
        ),
      );
      const sidecars =
        installKeys.length || versionRefs.length
          ? await transaction.getAll(
              ...installKeys.map((key) => collections.installations.doc(key)),
              ...sourceHeads,
              ...versionRefs,
            )
          : [];
      const current = sidecars.slice(0, installKeys.length);
      const savedHeads = sidecars.slice(
        installKeys.length,
        installKeys.length + sourceHeads.length,
      );
      const savedVersions = sidecars.slice(
        installKeys.length + sourceHeads.length,
      );
      const latest = new Map<string, BundleEventRow>();
      const metadata = new Map<
        string,
        {
          firstSourceId: string;
          firstSourceSequence: number;
          sourceIds: string[];
        }
      >();
      current.forEach((document, index) => {
        const key = installKeys[index]!;
        if (document.exists) {
          const data = document.data()!;
          const row = storedEventRow(data, document.ref.path);
          assertFirebaseInstallationIdentity(
            row.install_id,
            key,
            row.install_id,
          );
          if (
            typeof data._insights_first_source_id !== "string" ||
            !isSourceId(data._insights_first_source_id) ||
            !Number.isSafeInteger(data._insights_first_source_seq) ||
            data._insights_first_source_seq < 1 ||
            !Array.isArray(data._insights_source_ids) ||
            data._insights_source_ids.some(
              (sourceId: unknown) =>
                typeof sourceId !== "string" || !isSourceId(sourceId),
            ) ||
            new Set(data._insights_source_ids).size !==
              data._insights_source_ids.length
          ) {
            throw new DatabasePluginInputError("invalid-result");
          }
          latest.set(key, row);
          metadata.set(key, {
            firstSourceId: data._insights_first_source_id,
            firstSourceSequence: data._insights_first_source_seq,
            sourceIds: data._insights_source_ids,
          });
        }
      });
      const sourceWinners = new Map<
        string,
        { row: InsightsInstallationRow; sequence: number }
      >();
      savedHeads.forEach((document, index) => {
        if (!document.exists) return;
        const key = installKeys[index]!;
        const data = document.data()!;
        if (
          data.version !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
          data.recordKind !== "sourceHead" ||
          data.installKey !== key ||
          data.sourceId !== clockId ||
          !Number.isSafeInteger(data.sourceSequence) ||
          data.sourceSequence < 1 ||
          data.sourceSequence > upperSequence
        ) {
          throw new DatabasePluginInputError("invalid-result");
        }
        sourceWinners.set(key, {
          row: readInstallationProjection(data.row, key),
          sequence: data.sourceSequence,
        });
      });
      installKeys.forEach((key, index) => {
        if (
          metadata.get(key)?.sourceIds.includes(clockId) &&
          !savedHeads[index]!.exists
        ) {
          throw new DatabasePluginInputError("invalid-result");
        }
      });
      assertMaintenanceBytes([
        ...events.map(({ row }) => row),
        ...latest.values(),
        ...savedHeads
          .filter((document) => document.exists)
          .map((document) => document.data()),
        ...savedVersions
          .filter((document) => document.exists)
          .map((document) => document.data()),
      ]);
      for (const [eventIndex, { row, sequence }] of events.entries()) {
        const key = firebaseInstallationKey(row.install_id);
        const prior = latest.get(key);
        if (prior !== undefined) {
          assertFirebaseInstallationIdentity(
            prior.install_id,
            key,
            row.install_id,
          );
        }
        if (
          prior === undefined ||
          row.received_at_ms > prior.received_at_ms ||
          (row.received_at_ms === prior.received_at_ms && row.id > prior.id)
        ) {
          latest.set(key, row);
        }
        const savedMetadata = metadata.get(key);
        if (savedMetadata === undefined) {
          metadata.set(key, {
            firstSourceId: clockId,
            firstSourceSequence: sequence,
            sourceIds: [clockId],
          });
        } else if (!savedMetadata.sourceIds.includes(clockId)) {
          savedMetadata.sourceIds.push(clockId);
        }
        const projected = installationProjection(row);
        const sourceWinner = sourceWinners.get(key);
        const savedVersion = savedVersions[eventIndex]!;
        if (sourceWinner !== undefined && sourceWinner.sequence > sequence) {
          if (!savedVersion.exists) {
            throw new DatabasePluginInputError("invalid-result");
          }
          const saved = savedVersion.data()!;
          if (
            saved.version !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
            saved.recordKind !== "prefix" ||
            saved.installKey !== key ||
            saved.sourceId !== clockId ||
            saved.sourceSequence !== sequence
          ) {
            throw new DatabasePluginInputError("invalid-result");
          }
          readInstallationProjection(saved.row, key);
          continue;
        }
        const winner =
          sourceWinner === undefined ||
          isLaterProjection(projected, sourceWinner.row)
            ? projected
            : sourceWinner.row;
        sourceWinners.set(key, { row: winner, sequence });
        const versionData = {
          version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
          recordKind: "prefix",
          installKey: key,
          sourceId: clockId,
          sourceSequence: sequence,
          row: winner,
        };
        if (savedVersion.exists) {
          if (
            canonicalInsightsJson(savedVersion.data()) !==
            canonicalInsightsJson(versionData)
          ) {
            throw new DatabasePluginInputError("invalid-result");
          }
        } else {
          transaction.create(versionRefs[eventIndex]!, versionData);
        }
      }
      for (const [key, row] of latest) {
        const identity = metadata.get(key)!;
        transaction.set(collections.installations.doc(key), {
          ...row,
          _insights_first_source_id: identity.firstSourceId,
          _insights_first_source_seq: identity.firstSourceSequence,
          _insights_source_ids: [...identity.sourceIds].sort(),
        });
      }
      for (const [key, value] of sourceWinners) {
        transaction.set(
          collections.installationVersions.doc(
            firebaseInstallationSourceHeadId(key, clockId),
          ),
          {
            version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
            recordKind: "sourceHead",
            installKey: key,
            sourceId: clockId,
            sourceSequence: value.sequence,
            row: value.row,
          },
        );
      }
      const nextSequence = events.at(-1)?.sequence ?? afterSequence;
      transaction.set(checkpoint, {
        version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
        shard: input.sourceShard,
        sequence: nextSequence,
      });
      return {
        state: nextSequence === upperSequence ? "caught-up" : "building",
        processed: events.length,
        afterSequence: nextSequence,
        upperSequence,
      };
    },
    { maxAttempts: 1 },
  );
};

export const publishFirebaseInsightsProjection = async (
  db: Firestore,
  collections: FirebaseInsightsCollections,
  observedAtMs: number,
): Promise<{ readonly published: boolean; readonly generation?: string }> => {
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    return invalidQuery();
  }
  return db.runTransaction(async (transaction) => {
    const clockIds = FIREBASE_INSIGHTS_SOURCE_IDS;
    const documents = await transaction.getAll(
      ...clockIds.flatMap((clockId) => [
        collections.sourceClocks.doc(clockId),
        collections.control.doc(`projection_checkpoint_${clockId}`),
      ]),
    );
    const vector: readonly (readonly [string, number])[] = clockIds.map(
      (clockId, index) => {
        const clock = documents[index * 2]!;
        const checkpoint = documents[index * 2 + 1]!;
        const sourceShard: FirebaseInsightsSourceShard =
          clockId === "legacy"
            ? "legacy"
            : Number.parseInt(clockId.slice("live_".length), 16);
        if (
          !clock.exists ||
          !checkpoint.exists ||
          checkpoint.data()?.version !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
          checkpoint.data()?.shard !== sourceShard
        ) {
          throw new DatabasePluginInputError("invalid-result");
        }
        const sequence = readSourceClock(clock.data(), sourceShard).sequence;
        const projected = readSequence(checkpoint.data());
        if (sequence !== projected) return [clockId, -1] as const;
        return [clockId, sequence] as const;
      },
    );
    if (vector.some(([, sequence]) => sequence < 0)) {
      return { published: false };
    }
    const generation = firebaseEventScopeKey(JSON.stringify(vector));
    transaction.set(collections.control.doc("projection"), {
      version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
      state: "ready",
      generation,
      observedAtMs,
    });
    return { published: true, generation };
  });
};
