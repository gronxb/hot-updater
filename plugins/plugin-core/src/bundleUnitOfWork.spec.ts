import { describe, expect, it } from "vitest";

import { BundleUnitOfWork } from "./bundleUnitOfWork";
import type { Bundle } from "./types";

const baseBundle: Bundle = {
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  channel: "production",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "hash",
  storageUri: "s3://bucket/bundle.zip",
  gitCommitHash: "deadbeef",
  message: "Initial message",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
};

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveValue: (value: T) => void = () => {};

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolveValue = resolve;
    });
  }

  resolve(value: T): void {
    this.resolveValue(value);
  }
}

describe("BundleUnitOfWork", () => {
  it("preserves an insert written while a provider read is in flight", async () => {
    const unitOfWork = new BundleUnitOfWork();
    const providerRead = new Deferred<Bundle | null>();
    const read = unitOfWork.getById(baseBundle.id, () => providerRead.promise);
    const insertedBundle = {
      ...baseBundle,
      message: "Inserted while loading",
    };

    unitOfWork.markInsert(insertedBundle);
    providerRead.resolve(null);

    await expect(read).resolves.toBe(insertedBundle);
    await expect(
      unitOfWork.getById(baseBundle.id, async () => null),
    ).resolves.toBe(insertedBundle);
    expect(unitOfWork.changedSets()).toEqual([
      {
        operation: "insert",
        data: insertedBundle,
      },
    ]);
  });

  it("preserves an update written while a provider read is in flight", async () => {
    const unitOfWork = new BundleUnitOfWork();
    const providerRead = new Deferred<Bundle | null>();
    const read = unitOfWork.getById(baseBundle.id, () => providerRead.promise);
    const updatedBundle = {
      ...baseBundle,
      enabled: false,
    };

    unitOfWork.markUpdate(updatedBundle);
    providerRead.resolve(baseBundle);

    await expect(read).resolves.toBe(updatedBundle);
    await expect(
      unitOfWork.getById(baseBundle.id, async () => null),
    ).resolves.toBe(updatedBundle);
    expect(unitOfWork.changedSets()).toEqual([
      {
        operation: "update",
        data: updatedBundle,
      },
    ]);
  });

  it("preserves a delete written while a provider read is in flight", async () => {
    const unitOfWork = new BundleUnitOfWork();
    const providerRead = new Deferred<Bundle | null>();
    const read = unitOfWork.getById(baseBundle.id, () => providerRead.promise);

    unitOfWork.markDelete(baseBundle);
    providerRead.resolve(baseBundle);

    await expect(read).resolves.toBeNull();
    await expect(
      unitOfWork.getById(baseBundle.id, async () => baseBundle),
    ).resolves.toBeNull();
    expect(unitOfWork.changedSets()).toEqual([
      {
        operation: "delete",
        data: baseBundle,
      },
    ]);
  });
});
