import { BundleUnitOfWork } from "./bundleUnitOfWork";
import type {
  DatabaseAnalyticsEventChange,
  DatabaseBundlePatch,
  DatabaseBundlePatchChange,
  DatabaseChangeOperation,
  DatabaseChanges,
  DatabaseIngestKeyChange,
  DatabaseUpdateInput,
  TelemetryKeyCredential,
  TelemetryLifecyclePayload,
} from "./types";

class DatabaseTableUnitOfWork<TData> {
  private readonly changes: Array<{
    readonly operation: DatabaseChangeOperation;
    readonly data: TData;
  }> = [];

  markInsert(data: TData): void {
    this.changes.push({ operation: "insert", data });
  }

  markUpdate(data: TData): void {
    this.changes.push({ operation: "update", data });
  }

  markDelete(data: TData): void {
    this.changes.push({ operation: "delete", data });
  }

  changedSets(): ReadonlyArray<{
    readonly operation: DatabaseChangeOperation;
    readonly data: TData;
  }> {
    return [...this.changes];
  }

  clear(): void {
    this.changes.length = 0;
  }
}

type IngestKeyChangeData =
  | TelemetryKeyCredential
  | DatabaseUpdateInput<string, Partial<TelemetryKeyCredential>>;

export class DatabaseUnitOfWork {
  readonly analyticsEvents =
    new DatabaseTableUnitOfWork<TelemetryLifecyclePayload>();
  readonly bundlePatches = new DatabaseTableUnitOfWork<DatabaseBundlePatch>();
  readonly bundles = new BundleUnitOfWork();
  readonly ingestKeys = new DatabaseTableUnitOfWork<IngestKeyChangeData>();

  changedSets(): DatabaseChanges {
    return {
      analyticsEvents:
        this.analyticsEvents.changedSets() as readonly DatabaseAnalyticsEventChange[],
      bundlePatches:
        this.bundlePatches.changedSets() as readonly DatabaseBundlePatchChange[],
      bundles: this.bundles.changedSets(),
      ingestKeys:
        this.ingestKeys.changedSets() as readonly DatabaseIngestKeyChange[],
    };
  }

  clear(): void {
    this.analyticsEvents.clear();
    this.bundlePatches.clear();
    this.bundles.clear();
    this.ingestKeys.clear();
  }
}
