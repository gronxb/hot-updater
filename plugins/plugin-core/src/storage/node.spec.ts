import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StoragePluginError } from "../storage";
import type { StoragePlugin } from "../types/storage";
import {
  createNodeStorageContext,
  createNodeStoragePluginFacade,
} from "./node";
import { registerFacadeCases } from "./node.facade-cases";

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "hot-updater-storage-node-")),
  );
});

afterEach(async () => {
  await rm(temporaryDirectory, { force: true, recursive: true });
});

registerFacadeCases(() => temporaryDirectory);

describe("Node storage file bridge", () => {
  it("preserves a file read failure from upload", async () => {
    // Given
    const sourcePath = join(temporaryDirectory, "source-directory");
    await mkdir(sourcePath);
    const plugin: StoragePlugin = {
      ...createDownloadPlugin(new ReadableStream()),
      async put(input) {
        await new Response(input.body).arrayBuffer();
        return { kind: "stored", storageUri: "memory://bucket/unreachable" };
      },
    };
    const facade = createNodeStoragePluginFacade(
      plugin,
      createNodeStorageContext({ environment: {} }),
    );

    // When
    const operation = facade.profiles.node.upload("key", sourcePath);

    // Then
    await expect(operation).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("removes partial output when the download stream fails", async () => {
    // Given
    const primaryError = new Error("stream failed");
    const plugin = createDownloadPlugin(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.error(primaryError);
        },
      }),
    );
    const outputPath = join(temporaryDirectory, "failed.bin");
    const facade = createNodeStoragePluginFacade(
      plugin,
      createNodeStorageContext({ environment: {} }),
    );

    // When
    const operation = facade.profiles.node.downloadFile(
      "memory://bucket/failed",
      outputPath,
    );

    // Then
    await expect(operation).rejects.toBe(primaryError);
    expect(await readdir(temporaryDirectory)).toEqual([]);
  });

  it("removes partial output and cancels the source on write failure", async () => {
    // Given
    let cancelled = false;
    const plugin = createDownloadPlugin(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array([7]));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const outputPath = join(temporaryDirectory, "missing", "output.bin");
    const facade = createNodeStoragePluginFacade(
      plugin,
      createNodeStorageContext({ environment: {} }),
    );

    // When
    const operation = facade.profiles.node.downloadFile(
      "memory://bucket/write-failure",
      outputPath,
    );

    // Then
    await expect(operation).rejects.toBeInstanceOf(Error);
    expect(cancelled).toBe(true);
    expect(await readdir(temporaryDirectory)).toEqual([]);
  });

  it("removes partial output when the source aborts", async () => {
    // Given
    const abortError = new DOMException("cancelled", "AbortError");
    const plugin = createDownloadPlugin(
      new ReadableStream({
        start(controller) {
          controller.error(abortError);
        },
      }),
    );
    const outputPath = join(temporaryDirectory, "aborted.bin");
    const facade = createNodeStoragePluginFacade(
      plugin,
      createNodeStorageContext({ environment: {} }),
    );

    // When
    const operation = facade.profiles.node.downloadFile(
      "memory://bucket/aborted",
      outputPath,
    );

    // Then
    await expect(operation).rejects.toBe(abortError);
    expect(await readdir(temporaryDirectory)).toEqual([]);
  });

  it("leaves an existing destination unchanged when download fails", async () => {
    // Given
    const outputPath = join(temporaryDirectory, "existing.bin");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(outputPath, "original"),
    );
    const plugin = createDownloadPlugin(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("download failed"));
        },
      }),
    );
    const facade = createNodeStoragePluginFacade(
      plugin,
      createNodeStorageContext({ environment: {} }),
    );

    // When
    const operation = facade.profiles.node.downloadFile(
      "memory://bucket/existing",
      outputPath,
    );

    // Then
    await expect(operation).rejects.toThrow("download failed");
    expect(await readFile(outputPath, "utf8")).toBe("original");
    expect(await readdir(temporaryDirectory)).toEqual(["existing.bin"]);
  });
});

describe("createNodeStorageContext", () => {
  it("copies and freezes host maps while preserving no global state", () => {
    // Given
    const environment: Record<string, string | undefined> = { TOKEN: "first" };

    // When
    const context = createNodeStorageContext({ environment });
    environment["TOKEN"] = "changed";

    // Then
    expect(context).toEqual({
      target: "node",
      environment: { TOKEN: "first" },
      bindings: {},
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.environment)).toBe(true);
    expect(Object.isFrozen(context.bindings)).toBe(true);
  });

  it("rejects non-empty bindings before creating a Node context", () => {
    // Given
    const input = { environment: {}, bindings: { BUCKET: {} } };

    // When
    const operation = () => createNodeStorageContext(input);

    // Then
    expect(operation).toThrowError(
      new StoragePluginError(
        "invalid-input",
        "Node storage context bindings must be empty.",
      ),
    );
  });
});

const createDownloadPlugin = (
  body: ReadableStream<Uint8Array>,
): StoragePlugin => ({
  name: "download",
  protocol: "memory",
  async put() {
    return { kind: "stored", storageUri: "memory://bucket/unused" };
  },
  async head() {
    return { kind: "not-found" };
  },
  async get(input) {
    return {
      kind: "found",
      storageUri: input.storageUri,
      body,
      metadata: { contentLength: 0 },
    };
  },
  async delete() {
    return { kind: "not-found" };
  },
});
