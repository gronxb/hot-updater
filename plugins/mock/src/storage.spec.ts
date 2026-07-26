import {
  StoragePluginError,
  type StorageOperationContext,
} from "@hot-updater/plugin-core/storage";
import {
  readStorageStream,
  setupStoragePluginTestSuite,
  storageTestContext,
} from "@hot-updater/test-utils/storage";
import { describe, expect, it } from "vitest";

import { createStorageAccess } from "../../../packages/server/src/storageAccess";
import { mockStorage } from "./storage";

setupStoragePluginTestSuite({
  name: "mockStorage Storage v2 conformance",
  context: storageTestContext,
  createPlugin: () => mockStorage(),
});

describe("mockStorage Storage v2 fixture controls", () => {
  it("loads configured initial objects with reference memory semantics", async () => {
    // Given
    const plugin = mockStorage({
      initialObjects: [
        {
          key: "seed/manifest.json",
          body: new Uint8Array([1, 2, 3]),
          contentType: "application/json",
          metadata: { channel: "production" },
        },
      ],
    });

    // When
    const result = await plugin.get({
      context: storageTestContext,
      storageUri: "storage://mock/seed/manifest.json",
    });

    // Then
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      await expect(readStorageStream(result.body)).resolves.toEqual(
        new Uint8Array([1, 2, 3]),
      );
      expect(result.metadata).toEqual({
        contentLength: 3,
        contentType: "application/json",
        custom: { channel: "production" },
      });
    }
  });

  it("returns exact not-found outcomes for missing objects", async () => {
    // Given
    const plugin = mockStorage();

    // When
    const result = await plugin.get({
      context: storageTestContext,
      storageUri: "storage://mock/missing",
    });

    // Then
    expect(result).toEqual({ kind: "not-found" });
  });

  it("maps injected provider failures and preserves their cause", async () => {
    // Given
    const providerFailure = new Error("fixture provider failure");
    const plugin = mockStorage({
      failures: { head: providerFailure },
    });

    // When
    const operation = plugin.head({
      context: storageTestContext,
      storageUri: "storage://mock/object",
    });

    // Then
    await expect(operation).rejects.toMatchObject({
      name: "StoragePluginError",
      code: "provider",
      cause: providerFailure,
    });
  });

  it("maps injected AbortError failures to aborted", async () => {
    // Given
    const plugin = mockStorage({
      failures: { get: new DOMException("stopped", "AbortError") },
    });

    // When
    const operation = plugin.get({
      context: storageTestContext,
      storageUri: "storage://mock/object",
    });

    // Then
    await expect(operation).rejects.toMatchObject({
      name: "StoragePluginError",
      code: "aborted",
    });
  });

  it("reports request-distinct contexts to the assertion hook", async () => {
    // Given
    type RequestContext = StorageOperationContext & {
      readonly requestId: string;
    };
    const first: RequestContext = Object.freeze({
      ...storageTestContext,
      requestId: "request-a",
    });
    const second: RequestContext = Object.freeze({
      ...storageTestContext,
      requestId: "request-b",
    });
    const observed: RequestContext[] = [];
    const plugin = mockStorage<RequestContext>({
      assertContext(context) {
        observed.push(context);
      },
    });

    // When
    await Promise.all([
      plugin.head({
        context: first,
        storageUri: "storage://mock/first",
      }),
      plugin.head({
        context: second,
        storageUri: "storage://mock/second",
      }),
    ]);

    // Then
    expect(observed).toEqual([first, second]);
    expect(observed[0]).toBe(first);
    expect(observed[1]).toBe(second);
  });

  it("rejects duplicate mock protocols before storage operations", () => {
    // Given
    const first = mockStorage();
    const second = mockStorage();

    // When
    const createAccess = () => createStorageAccess([first, second]);

    // Then
    expect(createAccess).toThrow(
      'Duplicate storage protocol "storage" from plugins "mockStorage" and "mockStorage".',
    );
  });

  it("preserves explicitly injected StoragePluginError codes", async () => {
    // Given
    const failure = new StoragePluginError(
      "forbidden",
      "Fixture access denied.",
    );
    const plugin = mockStorage({ failures: { delete: failure } });

    // When
    const operation = plugin.delete({
      context: storageTestContext,
      storageUri: "storage://mock/object",
    });

    // Then
    await expect(operation).rejects.toBe(failure);
  });
});
