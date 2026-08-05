import {
  ANALYTICS_SCHEMA_FINGERPRINT_V1,
  ANALYTICS_SCHEMA_FINGERPRINT_V2,
  ANALYTICS_SCHEMA_KEY,
  ANALYTICS_SCHEMA_VERSION,
  AnalyticsSchemaNotReadyError,
  migrateAnalyticsSchema,
  type AnalyticsMigrationResult,
  type AnalyticsSchemaInspection,
  type AnalyticsSchemaMigrationStore,
} from "@hot-updater/analytics/provider";
import {
  type DocumentData,
  type DocumentSnapshot,
  FieldPath,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";

import { parseFirebaseAnalyticsDocument } from "./firebaseAnalyticsDocument";

const EVENTS_COLLECTION = "bundle_events";
const SETTINGS_COLLECTION = "private_hot_updater_settings";
const VALIDATION_PAGE_SIZE = 500;

export class FirebaseAnalyticsSchemaStateError extends Error {
  readonly name = "FirebaseAnalyticsSchemaStateError";

  constructor(readonly setting: string) {
    super(`Invalid Firebase Analytics schema setting: ${setting}`);
  }
}

type ValidatedDocuments = {
  readonly count: number;
  readonly hasUnchanged: boolean;
};

const settingValue = (
  setting: string,
  snapshot: DocumentSnapshot,
): string | null => {
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  if (
    typeof data !== "object" ||
    data === null ||
    Reflect.ownKeys(data).length !== 1 ||
    !Object.hasOwn(data, "value")
  ) {
    throw new FirebaseAnalyticsSchemaStateError(setting);
  }
  const value = Reflect.get(data, "value");
  if (typeof value !== "string") {
    throw new FirebaseAnalyticsSchemaStateError(setting);
  }
  return value;
};

const validateDocuments = async (
  db: Firestore,
): Promise<ValidatedDocuments> => {
  const collection = db.collection(EVENTS_COLLECTION);
  let cursor: QueryDocumentSnapshot<DocumentData> | undefined;
  let count = 0;
  let hasUnchanged = false;

  while (true) {
    const ordered = collection
      .orderBy(FieldPath.documentId(), "asc")
      .limit(VALIDATION_PAGE_SIZE);
    const snapshot = await (
      cursor === undefined ? ordered : ordered.startAfter(cursor)
    ).get();
    for (const document of snapshot.docs) {
      const row = parseFirebaseAnalyticsDocument(document.id, document.data());
      count += 1;
      hasUnchanged ||= row.type === "UNCHANGED";
    }
    if (snapshot.size < VALIDATION_PAGE_SIZE) {
      return { count, hasUnchanged };
    }
    const nextCursor = snapshot.docs.at(-1);
    if (nextCursor === undefined) {
      throw new FirebaseAnalyticsSchemaStateError(EVENTS_COLLECTION);
    }
    cursor = nextCursor;
  }
};

const validateV2Artifacts = async (db: Firestore): Promise<void> => {
  await validateDocuments(db);
  await db
    .collection(EVENTS_COLLECTION)
    .where("received_at_ms", "<", Number.MAX_SAFE_INTEGER)
    .orderBy("received_at_ms", "asc")
    .orderBy("id", "asc")
    .limit(1)
    .get();
};

export const validateFirebaseAnalyticsReadiness = async (
  db: Firestore,
): Promise<void> => {
  const marker = await db
    .collection(SETTINGS_COLLECTION)
    .doc(ANALYTICS_SCHEMA_KEY)
    .get();
  const componentVersion = settingValue(ANALYTICS_SCHEMA_KEY, marker);
  if (componentVersion !== ANALYTICS_SCHEMA_VERSION) {
    throw new AnalyticsSchemaNotReadyError({
      componentVersion,
      fingerprint: null,
      legacyVersion: null,
    });
  }
  await validateV2Artifacts(db);
};

const fingerprint = (
  componentVersion: string | null,
  documents: ValidatedDocuments,
): string | null => {
  if (componentVersion === ANALYTICS_SCHEMA_VERSION) {
    return ANALYTICS_SCHEMA_FINGERPRINT_V2;
  }
  if (componentVersion === "1") {
    return documents.hasUnchanged
      ? ANALYTICS_SCHEMA_FINGERPRINT_V2
      : ANALYTICS_SCHEMA_FINGERPRINT_V1;
  }
  return documents.count === 0 ? null : ANALYTICS_SCHEMA_FINGERPRINT_V2;
};

const createMigrationStore = (
  db: Firestore,
): AnalyticsSchemaMigrationStore => ({
  async inspect(): Promise<AnalyticsSchemaInspection> {
    const settings = db.collection(SETTINGS_COLLECTION);
    const componentSnapshot = await settings.doc(ANALYTICS_SCHEMA_KEY).get();
    const componentVersion = settingValue(
      ANALYTICS_SCHEMA_KEY,
      componentSnapshot,
    );
    if (
      componentVersion !== null &&
      componentVersion !== "1" &&
      componentVersion !== ANALYTICS_SCHEMA_VERSION
    ) {
      return {
        componentVersion,
        fingerprint: null,
        legacyVersion: null,
      };
    }
    const documents = await validateDocuments(db);
    return {
      componentVersion,
      fingerprint: fingerprint(componentVersion, documents),
      legacyVersion: null,
    };
  },
  createV2: async () => undefined,
  migrateV1ToV2: async () => undefined,
  validateV2: () => validateV2Artifacts(db),
  async writeComponentVersion(version) {
    const batch = db.batch();
    batch.set(db.collection(SETTINGS_COLLECTION).doc(ANALYTICS_SCHEMA_KEY), {
      value: version,
    });
    await batch.commit();
  },
});

export const migrateFirebaseAnalytics = (
  db: Firestore,
): Promise<AnalyticsMigrationResult> =>
  migrateAnalyticsSchema(createMigrationStore(db));
