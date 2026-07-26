import { describe, expect, it } from "vitest";

import {
  createStorageUriWithRelativePath,
  getAssetStorageLayout,
} from "./assetStorageLayout";
import { createStorageKeyBuilder } from "./createStorageKeyBuilder";
import { parseStorageUri } from "./parseStorageUri";
import { createStoragePlugin } from "./storage";
import {
  historicalStorageLayout,
  storageUriProtocols,
} from "./storageUriCompatibility.fixtures";

describe.each(storageUriProtocols)(
  "$protocol historical storage URI compatibility",
  ({ origin, protocol }) => {
    it("reads legacy bundle, manifest, asset-base, asset, and patch locations", () => {
      const locations = Object.values(historicalStorageLayout);

      for (const key of locations) {
        expect(parseStorageUri(`${origin}/${key}`, protocol)).toEqual({
          protocol,
          bucket: new URL(origin).hostname,
          key,
        });
      }
    });

    it("keeps legacy /files and v2 /assets layouts distinct", () => {
      expect(
        getAssetStorageLayout(`${origin}/${historicalStorageLayout.assetBase}`),
      ).toBe("legacy-files");
      expect(
        getAssetStorageLayout(
          `${origin}/${historicalStorageLayout.contentAddressedAssetBase}`,
        ),
      ).toBe("content-addressed");
    });

    it("keeps old writes readable by v2 and v2 keys readable by legacy code", () => {
      const createLegacyKey = createStorageKeyBuilder("updates");
      const oldWriteKey = createLegacyKey("bundle-id", "bundle.zip");

      expect(oldWriteKey).toBe(historicalStorageLayout.bundle);
      expect(
        createStorageUriWithRelativePath({
          baseStorageUri: `${origin}/updates/bundle-id/files`,
          relativePath: "assets/logo.png",
        }),
      ).toBe(`${origin}/${historicalStorageLayout.asset}`);
    });

    it("keeps put.key provider-relative and storageUri fully qualified", async () => {
      let observedKey: string | undefined;
      const storage = createStoragePlugin({
        name: `${protocol}Storage`,
        protocol,
        plugin: () => ({
          async delete() {
            return { kind: "not-found" };
          },
          async get() {
            return { kind: "not-found" };
          },
          async head() {
            return { kind: "not-found" };
          },
          async put(input) {
            observedKey = input.key;
            return {
              kind: "stored",
              storageUri: `${origin}/${input.key}`,
            };
          },
        }),
      });

      const result = await storage.put({
        body: new Uint8Array(),
        contentLength: 0,
        context: {
          bindings: {},
          environment: {},
          target: "node",
        },
        key: historicalStorageLayout.bundle,
      });

      expect(observedKey).toBe(historicalStorageLayout.bundle);
      expect(result.storageUri).toBe(
        `${origin}/${historicalStorageLayout.bundle}`,
      );
      expect(parseStorageUri(result.storageUri, protocol).key).toBe(
        historicalStorageLayout.bundle,
      );
    });
  },
);

describe("storage URI rejection", () => {
  it("rejects malformed storage URIs", () => {
    expect(() => parseStorageUri("not a storage URI", "s3")).toThrow(
      "Invalid storage URI format: not a storage URI",
    );
  });

  it("rejects a URI owned by another provider protocol", () => {
    expect(() =>
      parseStorageUri("r2://release-bucket/updates/bundle.zip", "s3"),
    ).toThrow("Invalid storage URI protocol. Expected s3, got r2");
  });
});
