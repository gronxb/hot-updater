export const ANALYTICS_SCHEMA_KEY = "schema.analytics" as const;
export const ANALYTICS_SCHEMA_VERSION = "2" as const;
export const ANALYTICS_SCHEMA_FINGERPRINT_V1 =
  "bundle_events@1:id,type,install_id,user_id?,username?,from_bundle_id,to_bundle_id,platform,app_version,channel,cohort,update_strategy,fingerprint_hash?,sdk_version?,received_at_ms";
export const ANALYTICS_SCHEMA_FINGERPRINT_V2 =
  "bundle_events@2:id,type,install_id,user_id?,username?,from_bundle_id?,to_bundle_id,platform,app_version,channel,cohort,update_strategy?,fingerprint_hash?,sdk_version?,received_at_ms";

export type AnalyticsSchemaShape = "absent" | "drift" | "v1" | "v2";

export type AnalyticsSchemaInspection = {
  readonly componentVersion: string | null;
  readonly fingerprint: string | null;
  readonly legacyVersion: string | null;
};

export interface AnalyticsSchemaMigrationStore {
  inspect(): Promise<AnalyticsSchemaInspection>;
  createV2(): Promise<void>;
  migrateV1ToV2(): Promise<void>;
  validateV2(): Promise<void>;
  writeComponentVersion(
    version: typeof ANALYTICS_SCHEMA_VERSION,
  ): Promise<void>;
}

export type AnalyticsMigrationResult =
  | { readonly kind: "adopted-v2" }
  | { readonly kind: "created-v2" }
  | { readonly kind: "migrated-v1-v2" }
  | { readonly kind: "ready" };

export class AnalyticsSchemaCompatibilityError extends Error {
  readonly name = "AnalyticsSchemaCompatibilityError";

  constructor(readonly inspection: AnalyticsSchemaInspection) {
    super("Analytics schema state is incompatible with this release.");
  }
}

export class AnalyticsSchemaNotReadyError extends Error {
  readonly name = "AnalyticsSchemaNotReadyError";

  constructor(readonly inspection: AnalyticsSchemaInspection) {
    super("Analytics schema is not ready for runtime operations.");
  }
}

const knownLegacyVersions = new Set([
  null,
  "0.21.0",
  "0.29.0",
  "0.31.0",
  "0.36.0",
  "0.37.0",
  "0.38.0",
]);

function incompatible(inspection: AnalyticsSchemaInspection): never {
  throw new AnalyticsSchemaCompatibilityError(inspection);
}

function getShape(fingerprint: string | null): AnalyticsSchemaShape {
  if (fingerprint === null) return "absent";
  if (fingerprint === ANALYTICS_SCHEMA_FINGERPRINT_V1) return "v1";
  if (fingerprint === ANALYTICS_SCHEMA_FINGERPRINT_V2) return "v2";
  return "drift";
}

async function adoptV2(
  store: AnalyticsSchemaMigrationStore,
): Promise<AnalyticsMigrationResult> {
  await store.validateV2();
  await store.writeComponentVersion(ANALYTICS_SCHEMA_VERSION);
  return { kind: "adopted-v2" };
}

async function migrateV1(
  store: AnalyticsSchemaMigrationStore,
): Promise<AnalyticsMigrationResult> {
  await store.migrateV1ToV2();
  await store.validateV2();
  await store.writeComponentVersion(ANALYTICS_SCHEMA_VERSION);
  return { kind: "migrated-v1-v2" };
}

export async function migrateAnalyticsSchema(
  store: AnalyticsSchemaMigrationStore,
): Promise<AnalyticsMigrationResult> {
  const inspection = await store.inspect();
  if (!knownLegacyVersions.has(inspection.legacyVersion)) {
    return incompatible(inspection);
  }
  const shape = getShape(inspection.fingerprint);

  switch (inspection.componentVersion) {
    case "2":
      if (shape !== "v2") return incompatible(inspection);
      await store.validateV2();
      return { kind: "ready" };
    case "1":
      if (shape === "v1") return migrateV1(store);
      if (shape === "v2") return adoptV2(store);
      return incompatible(inspection);
    case null:
      break;
    default:
      return incompatible(inspection);
  }

  switch (shape) {
    case "absent":
      if (
        inspection.legacyVersion === "0.37.0" ||
        inspection.legacyVersion === "0.38.0"
      ) {
        return incompatible(inspection);
      }
      await store.createV2();
      await store.validateV2();
      await store.writeComponentVersion(ANALYTICS_SCHEMA_VERSION);
      return { kind: "created-v2" };
    case "v1":
      return inspection.legacyVersion === "0.37.0"
        ? migrateV1(store)
        : incompatible(inspection);
    case "v2":
      return adoptV2(store);
    case "drift":
      return incompatible(inspection);
  }
}
