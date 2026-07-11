import type { DatabasePluginCore } from "./databaseCoreTypes";
import {
  getCoreBundlePatchById,
  getPatchId,
  materializePatch,
} from "./databaseRuntimePatches";
import type {
  DatabaseBundleEvent,
  DatabaseBundlePatch,
  DatabaseBundlePatchUpdate,
  DatabaseBundleRecord,
  DatabaseMutation,
} from "./types";

export type BundleEntry =
  | {
      readonly kind: "present";
      readonly bundle: DatabaseBundleRecord;
    }
  | {
      readonly kind: "deleted";
    };

export type BundlePatchEntry =
  | {
      readonly kind: "present";
      readonly patch: DatabaseBundlePatch;
    }
  | {
      readonly kind: "deleted";
    };

export interface RuntimeStageOverlayState {
  readonly bundleEntries: ReadonlyMap<string, BundleEntry>;
  readonly bundleUpdates: ReadonlyMap<string, Partial<DatabaseBundleRecord>>;
  readonly bundlePatchEntries: ReadonlyMap<string, BundlePatchEntry>;
  readonly bundlePatchUpdates: ReadonlyMap<string, DatabaseBundlePatchUpdate>;
  readonly eventAppends: readonly DatabaseBundleEvent[];
}

export interface RuntimeStageSnapshot {
  readonly mutations: readonly DatabaseMutation[];
  readonly prefixSize: number;
}

const resolveBundleEntry = (
  entry: BundleEntry | undefined,
): DatabaseBundleRecord | null | undefined => {
  if (!entry) {
    return undefined;
  }
  return entry.kind === "present" ? entry.bundle : null;
};

export const applyBundleUpdate = (
  updates: ReadonlyMap<string, Partial<DatabaseBundleRecord>>,
  bundle: DatabaseBundleRecord,
): DatabaseBundleRecord => {
  const patch = updates.get(bundle.id);
  return patch ? { ...bundle, ...patch } : bundle;
};

export const applyBundlePatchUpdate = (
  updates: ReadonlyMap<string, DatabaseBundlePatchUpdate>,
  patch: DatabaseBundlePatch,
): DatabaseBundlePatch => {
  const update = updates.get(getPatchId(patch));
  return update ? materializePatch({ ...patch, ...update }) : patch;
};

export class RuntimeStage {
  private readonly bundleEntries = new Map<string, BundleEntry>();
  private readonly bundleUpdates = new Map<
    string,
    Partial<DatabaseBundleRecord>
  >();
  private readonly bundlePatchEntries = new Map<string, BundlePatchEntry>();
  private readonly bundlePatchUpdates = new Map<
    string,
    DatabaseBundlePatchUpdate
  >();
  private readonly eventAppends: DatabaseBundleEvent[] = [];
  private readonly mutations: DatabaseMutation[] = [];

  stage(mutation: DatabaseMutation): void {
    switch (mutation.kind) {
      case "bundle.insert":
        this.bundleEntries.set(mutation.bundle.id, {
          kind: "present",
          bundle: mutation.bundle,
        });
        this.bundleUpdates.delete(mutation.bundle.id);
        this.mutations.push(mutation);
        return;
      case "bundle.update": {
        const entry = this.bundleEntries.get(mutation.bundleId);
        if (entry?.kind === "present") {
          this.bundleEntries.set(mutation.bundleId, {
            kind: "present",
            bundle: {
              ...entry.bundle,
              ...mutation.patch,
            },
          });
        } else if (entry?.kind !== "deleted") {
          this.bundleUpdates.set(mutation.bundleId, {
            ...this.bundleUpdates.get(mutation.bundleId),
            ...mutation.patch,
          });
        }
        this.mutations.push(mutation);
        return;
      }
      case "bundle.delete":
        this.bundleEntries.set(mutation.bundleId, { kind: "deleted" });
        this.bundleUpdates.delete(mutation.bundleId);
        this.mutations.push(mutation);
        return;
      case "bundlePatch.insert": {
        const patch = materializePatch(mutation.patch);
        const patchId = getPatchId(patch);
        this.bundlePatchEntries.set(patchId, {
          kind: "present",
          patch,
        });
        this.bundlePatchUpdates.delete(patchId);
        this.mutations.push({ ...mutation, patch });
        return;
      }
      case "bundlePatch.update": {
        const entry = this.bundlePatchEntries.get(mutation.patchId);
        if (entry?.kind === "present") {
          this.bundlePatchEntries.set(mutation.patchId, {
            kind: "present",
            patch: materializePatch({
              ...entry.patch,
              ...mutation.patch,
            }),
          });
        } else if (entry?.kind !== "deleted") {
          this.bundlePatchUpdates.set(mutation.patchId, {
            ...this.bundlePatchUpdates.get(mutation.patchId),
            ...mutation.patch,
          });
        }
        this.mutations.push(mutation);
        return;
      }
      case "bundlePatch.delete":
        this.bundlePatchEntries.set(mutation.patchId, { kind: "deleted" });
        this.bundlePatchUpdates.delete(mutation.patchId);
        this.mutations.push(mutation);
        return;
      case "bundleEvent.append":
        this.eventAppends.push(mutation.event);
        this.mutations.push(mutation);
        return;
    }
  }

  async resolveBundle(
    core: DatabasePluginCore,
    bundleId: string,
  ): Promise<DatabaseBundleRecord | null | undefined> {
    const entry = this.bundleEntries.get(bundleId);
    const staged = resolveBundleEntry(entry);
    if (staged !== undefined) {
      return staged;
    }
    if (!this.bundleUpdates.has(bundleId)) {
      return undefined;
    }
    const current = await core.bundles.getById({ bundleId });
    return current ? applyBundleUpdate(this.bundleUpdates, current) : null;
  }

  async resolvePatch(
    core: DatabasePluginCore,
    patchId: string,
  ): Promise<DatabaseBundlePatch | null | undefined> {
    const entry = this.bundlePatchEntries.get(patchId);
    if (entry) {
      return entry.kind === "present" ? entry.patch : null;
    }
    if (!this.bundlePatchUpdates.has(patchId)) {
      return undefined;
    }
    const current = await getCoreBundlePatchById(core.bundlePatches, patchId);
    return current
      ? applyBundlePatchUpdate(this.bundlePatchUpdates, current)
      : null;
  }

  overlayState(): RuntimeStageOverlayState {
    return {
      bundleEntries: this.bundleEntries,
      bundleUpdates: this.bundleUpdates,
      bundlePatchEntries: this.bundlePatchEntries,
      bundlePatchUpdates: this.bundlePatchUpdates,
      eventAppends: this.eventAppends,
    };
  }

  snapshot(): RuntimeStageSnapshot {
    return {
      mutations: this.mutations.slice(),
      prefixSize: this.mutations.length,
    };
  }

  acknowledge(snapshot: RuntimeStageSnapshot): void {
    const remaining = this.mutations.slice(snapshot.prefixSize);
    this.clear();
    for (const mutation of remaining) {
      this.stage(mutation);
    }
  }

  clear(): void {
    this.bundleEntries.clear();
    this.bundleUpdates.clear();
    this.bundlePatchEntries.clear();
    this.bundlePatchUpdates.clear();
    this.eventAppends.splice(0);
    this.mutations.splice(0);
  }
}
