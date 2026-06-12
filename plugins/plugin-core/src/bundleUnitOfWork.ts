import { bundleMatchesQueryWhere, sortBundles } from "./queryBundles";
import type {
  Bundle,
  DatabaseBundleQueryOrder,
  DatabaseBundleQueryWhere,
} from "./types";

export type BundleChangeOperation = "insert" | "update" | "delete";

export interface BundleChange {
  readonly operation: BundleChangeOperation;
  readonly data: Bundle;
}

interface TrackedBundleChange extends BundleChange {
  readonly before: Bundle | null;
}

type BundleEntry =
  | {
      readonly kind: "present";
      readonly bundle: Bundle;
    }
  | {
      readonly kind: "deleted";
      readonly bundle: Bundle;
    }
  | {
      readonly kind: "missing";
    };

const resolveEntryValue = (entry: BundleEntry): Bundle | null =>
  entry.kind === "present" ? entry.bundle : null;

export type TrackedBundleValue =
  | {
      readonly found: true;
      readonly value: Bundle | null;
    }
  | {
      readonly found: false;
    };

export class BundleUnitOfWork {
  private readonly entries = new Map<string, BundleEntry>();
  private readonly pendingLoads = new Map<string, Promise<Bundle | null>>();
  private readonly changes = new Map<string, TrackedBundleChange>();
  private readonly seededIds = new Set<string>();

  seed(seeds: readonly (Bundle | null | undefined)[]): void {
    for (const seed of seeds) {
      if (!seed) {
        continue;
      }
      this.seededIds.add(seed.id);
      if (!this.changes.has(seed.id)) {
        this.entries.set(seed.id, { kind: "present", bundle: seed });
      }
    }
  }

  hasSeeds(): boolean {
    return this.seededIds.size > 0;
  }

  seededBundles(): readonly Bundle[] {
    const bundles: Bundle[] = [];
    for (const bundleId of this.seededIds) {
      const entry = this.entries.get(bundleId);
      if (entry?.kind === "present") {
        bundles.push(entry.bundle);
      }
    }
    return bundles;
  }

  peek(bundleId: string): Bundle | null {
    const entry = this.entries.get(bundleId);
    if (entry?.kind === "present") {
      return entry.bundle;
    }
    return null;
  }

  peekChanged(bundleId: string): TrackedBundleValue {
    if (!this.changes.has(bundleId)) {
      return { found: false };
    }

    const entry = this.entries.get(bundleId);
    return {
      found: true,
      value: entry ? resolveEntryValue(entry) : null,
    };
  }

  async getById(
    bundleId: string,
    loadBundleById: () => Promise<Bundle | null>,
  ): Promise<Bundle | null> {
    const entry = this.entries.get(bundleId);
    if (entry) {
      return resolveEntryValue(entry);
    }

    const pendingLoad = this.pendingLoads.get(bundleId);
    if (pendingLoad) {
      return pendingLoad;
    }

    const load = loadBundleById().then(
      (bundle) => {
        this.pendingLoads.delete(bundleId);
        const currentEntry = this.entries.get(bundleId);
        if (currentEntry) {
          return resolveEntryValue(currentEntry);
        }

        this.entries.set(
          bundleId,
          bundle ? { kind: "present", bundle } : { kind: "missing" },
        );
        return bundle;
      },
      (error: unknown) => {
        this.pendingLoads.delete(bundleId);
        throw error;
      },
    );
    this.pendingLoads.set(bundleId, load);
    return load;
  }

  overlayList(
    bundles: readonly Bundle[],
    options: {
      readonly limit: number;
      readonly orderBy: DatabaseBundleQueryOrder | undefined;
      readonly where: DatabaseBundleQueryWhere | undefined;
    },
  ): Bundle[] {
    const dataById = new Map<string, Bundle>();
    for (const bundle of bundles) {
      const entry = this.entries.get(bundle.id);
      if (entry?.kind === "deleted") {
        continue;
      }
      if (entry?.kind === "present") {
        if (bundleMatchesQueryWhere(entry.bundle, options.where)) {
          dataById.set(entry.bundle.id, entry.bundle);
        }
        continue;
      }
      this.entries.set(bundle.id, { kind: "present", bundle });
      dataById.set(bundle.id, bundle);
    }

    for (const change of this.changes.values()) {
      if (change.operation === "delete" || change.operation === "insert") {
        dataById.delete(change.data.id);
        continue;
      }

      if (bundleMatchesQueryWhere(change.data, options.where)) {
        dataById.set(change.data.id, change.data);
      } else {
        dataById.delete(change.data.id);
      }
    }

    return sortBundles(Array.from(dataById.values()), options.orderBy).slice(
      0,
      options.limit,
    );
  }

  markInsert(bundle: Bundle): void {
    this.entries.set(bundle.id, { kind: "present", bundle });
    this.changes.set(bundle.id, {
      operation: "insert",
      data: bundle,
      before: null,
    });
  }

  markUpdate(bundle: Bundle): void {
    const previousChange = this.changes.get(bundle.id);
    const previousEntry = this.entries.get(bundle.id);
    const operation = previousChange?.operation ?? "update";
    this.entries.set(bundle.id, { kind: "present", bundle });
    this.changes.set(bundle.id, {
      operation,
      data: bundle,
      before:
        previousChange?.before ??
        (previousEntry ? resolveEntryValue(previousEntry) : null),
    });
  }

  markDelete(bundle: Bundle): void {
    const previousChange = this.changes.get(bundle.id);
    const previousEntry = this.entries.get(bundle.id);
    this.entries.set(bundle.id, { kind: "deleted", bundle });
    this.changes.set(bundle.id, {
      operation: "delete",
      data: bundle,
      before:
        previousChange?.before ??
        (previousEntry ? resolveEntryValue(previousEntry) : bundle),
    });
  }

  changedSets(): BundleChange[] {
    return Array.from(this.changes.values(), ({ data, operation }) => ({
      operation,
      data,
    }));
  }

  hasChanges(): boolean {
    return this.changes.size > 0;
  }

  listFetchExtraCount(): number {
    return Array.from(this.changes.values()).filter(
      (change) =>
        change.operation === "update" || change.operation === "delete",
    ).length;
  }

  totalDelta(where: DatabaseBundleQueryWhere | undefined): number {
    let total = 0;
    for (const change of this.changes.values()) {
      if (change.operation === "insert") {
        continue;
      }

      const matchedBefore =
        change.before !== null && bundleMatchesQueryWhere(change.before, where);
      const matchesAfter =
        change.operation === "update" &&
        bundleMatchesQueryWhere(change.data, where);

      if (matchedBefore && !matchesAfter) {
        total -= 1;
      } else if (!matchedBefore && matchesAfter) {
        total += 1;
      }
    }
    return total;
  }

  clear(): void {
    this.entries.clear();
    this.pendingLoads.clear();
    this.changes.clear();
    this.seededIds.clear();
  }
}
