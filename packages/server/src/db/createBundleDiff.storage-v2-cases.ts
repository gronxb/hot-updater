import fs from "node:fs/promises";

import type { StorageOperationContext } from "@hot-updater/plugin-core";
import { StoragePluginError } from "@hot-updater/plugin-core/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBundleDiff } from "./createBundleDiff";
import {
  baseId,
  createBundle,
  createDatabasePlugin,
  createFacade,
  createObjects,
  runDiff,
  targetId,
} from "./createBundleDiff.storage-v2-fixture";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createBundleDiff Storage V2 bridge", () => {
  it("streams through one bound context and preserves patch URI bytes", async () => {
    // Given
    const context: StorageOperationContext = Object.freeze({
      bindings: Object.freeze({ request: "diff" }),
      environment: Object.freeze({ REQUEST_ID: "diff" }),
      target: "node",
    });
    const previousUri = `s3://test-bucket/releases/${targetId}/patches/${baseId}/old.bsdiff`;
    const fixture = createFacade(context, createObjects());

    // When
    const { result } = await runDiff(fixture.facade, {
      patchBaseBundleId: baseId,
      patchBaseFileHash: "old",
      patchFileHash: "previous",
      patchStorageUri: previousUri,
      patches: [
        {
          baseBundleId: baseId,
          baseFileHash: "old",
          patchFileHash: "previous",
          patchStorageUri: previousUri,
        },
      ],
    });

    // Then
    expect(fixture.contexts).not.toHaveLength(0);
    expect(fixture.contexts.every((value) => value === context)).toBe(true);
    expect(fixture.putBodies[0]).toBeInstanceOf(ReadableStream);
    expect(fixture.putKeys).toEqual([
      `${targetId}/patches/${baseId}/index.ios.bundle.bsdiff`,
    ]);
    expect(result.patchStorageUri).toBe(
      `s3://test-bucket/${targetId}/patches/${baseId}/index.ios.bundle.bsdiff`,
    );
    expect(fixture.deletedUris).toEqual([previousUri]);
  });

  it("reports not-found from the bound facade without a fetch fallback", async () => {
    // Given
    const fetchFallback = vi.fn();
    vi.stubGlobal("fetch", fetchFallback);
    const context: StorageOperationContext = {
      bindings: {},
      environment: {},
      target: "node",
    };
    const fixture = createFacade(context, new Map());
    const databasePlugin = await createDatabasePlugin([
      createBundle(baseId),
      createBundle(targetId),
    ]);

    // When
    const operation = createBundleDiff(
      { baseBundleId: baseId, bundleId: targetId },
      { databasePlugin, storagePlugin: fixture.facade },
    );

    // Then
    await expect(operation).rejects.toMatchObject({
      code: "provider",
      name: "StoragePluginError",
    });
    expect(fetchFallback).not.toHaveBeenCalled();
  });

  it.each([
    [
      "unsupported",
      new StoragePluginError("unsupported", "Read is unsupported."),
    ],
    ["abort", new DOMException("cancelled", "AbortError")],
  ] as const)(
    "preserves an explicit %s read failure",
    async (_name, failure) => {
      // Given
      const context: StorageOperationContext = {
        bindings: {},
        environment: {},
        target: "node",
      };
      const fixture = createFacade(context, createObjects(), {
        get: async () => {
          throw failure;
        },
      });
      const databasePlugin = await createDatabasePlugin([
        createBundle(baseId),
        createBundle(targetId),
      ]);

      // When
      const operation = createBundleDiff(
        { baseBundleId: baseId, bundleId: targetId },
        { databasePlugin, storagePlugin: fixture.facade },
      );

      // Then
      await expect(operation).rejects.toMatchObject({
        code: _name === "abort" ? "aborted" : "unsupported",
      });
    },
  );

  it("preserves upload failure and removes every workflow temp directory", async () => {
    // Given
    const primaryError = new StoragePluginError("provider", "upload failed");
    const context: StorageOperationContext = {
      bindings: {},
      environment: {},
      target: "node",
    };
    const fixture = createFacade(context, createObjects(), {
      put: async () => {
        throw primaryError;
      },
    });
    const createdDirectories: string[] = [];
    const originalMkdtemp = fs.mkdtemp.bind(fs);
    vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
      const directory = await originalMkdtemp(...args);
      createdDirectories.push(directory);
      return directory;
    });

    // When
    const operation = runDiff(fixture.facade);

    // Then
    await expect(operation).rejects.toBe(primaryError);
    for (const directory of createdDirectories) {
      await expect(fs.stat(directory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });
});
