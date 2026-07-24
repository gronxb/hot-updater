import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const managedHandlerPath = path.resolve(
  import.meta.dirname,
  "../dist/lambda/index.cjs",
);

describe("AWS Lambda managed handler bundle", () => {
  it("contains no unresolved first-party internal runtime imports", async () => {
    // Given
    const source = await readFile(managedHandlerPath, "utf8");

    // When
    const unresolvedInternalImport =
      /require\(["']@hot-updater\/(?:plugin-core|server)\/internal\//;

    // Then
    expect(source).not.toMatch(unresolvedInternalImport);
  });
});
