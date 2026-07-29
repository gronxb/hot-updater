import { describe, expect, it } from "vitest";

import { createStorageUriWithRelativePath } from "./assetStorageLayout";
import { createStorageKeyBuilder } from "./createStorageKeyBuilder";
import { parseStorageUri } from "./parseStorageUri";
import {
  historicalStorageLayout,
  storageUriProtocols,
} from "./storageUriCompatibility.fixtures";

describe.each(storageUriProtocols)(
  "$protocol historical storage URI compatibility",
  ({ origin, protocol }) => {
    it("reads historical bundle, manifest, asset-base, asset, and patch locations", () => {
      const locations = Object.values(historicalStorageLayout);

      for (const key of locations) {
        expect(parseStorageUri(`${origin}/${key}`, protocol)).toEqual({
          protocol,
          bucket: new URL(origin).hostname,
          key,
        });
      }
    });

    it("keeps historical writes and content-addressed keys interoperable", () => {
      const createHistoricalKey = createStorageKeyBuilder("updates");
      const oldWriteKey = createHistoricalKey("bundle-id", "bundle.zip");

      expect(oldWriteKey).toBe(historicalStorageLayout.bundle);
      expect(
        createStorageUriWithRelativePath({
          baseStorageUri: `${origin}/updates/bundle-id/files`,
          relativePath: "assets/logo.png",
        }),
      ).toBe(`${origin}/${historicalStorageLayout.asset}`);
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
