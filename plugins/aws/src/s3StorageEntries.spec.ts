import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { StoragePluginError } from "@hot-updater/plugin-core/storage";
import { describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };
import { s3Storage as legacyRootStorage } from "./index";
import { s3Storage as legacyLambdaStorage } from "./lambda";
import { s3Storage as unsupportedS3Storage } from "./storage";
import { s3Storage as nodeS3Storage } from "./storage/node";

describe("AWS S3 Storage v2 entries", () => {
  it("preserves the root and Lambda v1 factories", () => {
    // Given / When
    const root = legacyRootStorage({
      bucketName: "legacy-root",
      region: "us-east-1",
    });
    const lambda = legacyLambdaStorage({
      bucketName: "legacy-lambda",
      region: "us-east-1",
      publicBaseUrl: "https://cdn.example.test",
      keyPairId: "K123",
      getPrivateKey: async () => "private-key",
    });

    // Then
    expect(root).toEqual(expect.any(Function));
    expect(lambda).toEqual(expect.any(Function));
  });

  it("keeps the v2 node entry direct and the default unsupported", () => {
    // Given / When
    const node = nodeS3Storage({
      bucketName: "storage-v2",
      region: "us-east-1",
    });
    const unsupported = (): unknown =>
      unsupportedS3Storage({ bucketName: "storage-v2" });

    // Then
    expect(node).not.toEqual(expect.any(Function));
    expect(unsupported).toThrow(
      expect.objectContaining<Partial<StoragePluginError>>({
        name: "StoragePluginError",
        code: "unsupported",
      }),
    );
  });

  it("declares explicit node and Lambda storage exports", () => {
    // Given / When
    const exports = packageJson.exports;

    // Then
    expect(exports["./storage"]).toMatchObject({
      node: {
        import: { default: "./dist/storage/node.mjs" },
        require: { default: "./dist/storage/node.cjs" },
      },
      import: { default: "./dist/storage/index.mjs" },
      require: { default: "./dist/storage/index.cjs" },
    });
    expect(exports["./storage/node"]).toBeDefined();
    expect(exports["./storage/lambda"]).toBeDefined();
  });

  it("keeps storage source imports out of AWS administration and server code", async () => {
    // Given
    const storageDirectory = path.join(import.meta.dirname, "storage");
    const files = (await readdir(storageDirectory)).filter((file) =>
      file.endsWith(".ts"),
    );

    // When
    const source = (
      await Promise.all(
        files.map((file) =>
          readFile(path.join(storageDirectory, file), "utf8"),
        ),
      )
    ).join("\n");

    // Then
    expect(source).not.toMatch(
      /@aws-sdk\/client-(?:cloudformation|iam|lambda|ssm|sts)|@hot-updater\/(?:cli-tools|server)|\/iac(?:\/|")/,
    );
  });
});
