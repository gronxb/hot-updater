import { expect, it } from "vitest";

import { hasCanonicalManifestAssetPaths } from "./manifestAssetPath";

it("rejects a manifest whose files and parent directories exceed the archive-entry limit", () => {
  const assetPaths = Array.from(
    { length: 5_000 },
    (_, index) => `dir-${index}/entry`,
  );

  expect(
    hasCanonicalManifestAssetPaths({
      assetPaths,
      patchAssetPath: assetPaths[0],
    }),
  ).toBe(false);
});
