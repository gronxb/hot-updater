import type { AnalyticsBlobMigrationOperations } from "./blobMigration";
import {
  ANALYTICS_BLOB_KEY,
  ANALYTICS_BLOB_PENDING_KEY,
  AnalyticsBlobFormatError,
} from "./blobPersistence";
import type { BundleEventPersistenceRow } from "./persistence";

type ActiveCoreHandle = {
  readonly rawRoot: { readonly revision: string };
  readonly snapshot: unknown;
};

type MigrationTestState = {
  readonly archives: unknown[];
  readonly calls: string[];
  readonly objects: Map<string, unknown>;
  readonly operations: AnalyticsBlobMigrationOperations;
  readonly activeCore: unknown;
  readonly activeCoreHandle: ActiveCoreHandle;
  readonly conflictNextCoreWrites: (count: number) => void;
  readonly setManifestFailure: (value: boolean) => void;
  readonly rejectCoreCompatibility: (error: Error) => void;
};

export class InjectedManifestFailure extends Error {}

export function createEvent(
  id: string,
  toBundleId: string = "bundle-1",
): BundleEventPersistenceRow {
  return {
    id,
    type: "UNCHANGED",
    install_id: `install-${id}`,
    user_id: null,
    username: null,
    from_bundle_id: null,
    to_bundle_id: toBundleId,
    platform: "ios",
    app_version: "1.0.0",
    channel: "production",
    cohort: "default",
    update_strategy: null,
    fingerprint_hash: null,
    sdk_version: null,
    received_at_ms: 1,
  };
}

export function createCoreSnapshot(events?: readonly unknown[]): {
  readonly version: number;
  readonly bundles: readonly unknown[];
  readonly bundle_patches: readonly unknown[];
  readonly bundle_events?: readonly unknown[];
} {
  return {
    version: 2,
    bundles: [],
    bundle_patches: [],
    ...(events === undefined ? {} : { bundle_events: events }),
  };
}

function areEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createMigrationTestState(
  initialCore: unknown = createCoreSnapshot([createEvent("legacy")]),
): MigrationTestState {
  const objects = new Map<string, unknown>();
  const archives: unknown[] = [];
  const calls: string[] = [];
  let activeCore: ActiveCoreHandle = {
    rawRoot: { revision: "revision-1" },
    snapshot: initialCore,
  };
  let coreConflicts = 0;
  let failManifest = false;
  let coreCompatibilityError: Error | null = null;
  const operations: AnalyticsBlobMigrationOperations = {
    loadObject: async (key) => objects.get(key) ?? null,
    compareAndSwapObject: async (key, expected, value) => {
      let call = "data";
      if (key === ANALYTICS_BLOB_KEY) {
        call = "manifest";
      } else if (key === ANALYTICS_BLOB_PENDING_KEY) {
        call = "pending";
      }
      calls.push(call);
      if (key === ANALYTICS_BLOB_KEY && failManifest) {
        throw new InjectedManifestFailure();
      }
      const current = objects.get(key) ?? null;
      if (!areEqual(current, expected)) return false;
      objects.set(key, value);
      return true;
    },
    loadActiveCoreBlob: async () => activeCore,
    assertCoreBlobCompatible: async (value) => {
      if (coreCompatibilityError !== null) throw coreCompatibilityError;
      const keys =
        typeof value === "object" && value !== null
          ? Object.keys(value).sort()
          : [];
      if (!areEqual(keys, ["bundle_patches", "bundles", "version"])) {
        throw new AnalyticsBlobFormatError("Core snapshot is incompatible.");
      }
    },
    archiveCoreBlob: async (value) => {
      calls.push("archive");
      archives.push(value);
    },
    publishCoreBlob: async (expected, value) => {
      calls.push("core");
      if (coreConflicts > 0) {
        coreConflicts -= 1;
        activeCore = {
          rawRoot: { revision: "revision-concurrent" },
          snapshot: {
            version: 2,
            bundles: [{ id: "concurrent-core-row" }],
            bundle_patches: [],
            bundle_events: [createEvent("legacy")],
          },
        };
        return false;
      }
      if (!areEqual(activeCore, expected)) return false;
      activeCore = {
        rawRoot: { revision: "revision-published" },
        snapshot: value,
      };
      return true;
    },
  };

  return {
    archives,
    calls,
    objects,
    operations,
    get activeCore() {
      return activeCore.snapshot;
    },
    get activeCoreHandle() {
      return activeCore;
    },
    conflictNextCoreWrites(count: number) {
      coreConflicts = count;
    },
    setManifestFailure(value: boolean) {
      failManifest = value;
    },
    rejectCoreCompatibility(error: Error) {
      coreCompatibilityError = error;
    },
  };
}
