import { expect, it } from "vitest";

it("resolves the direct Storage v2 package entry", async () => {
  // Given
  const storageEntry = "@hot-updater/mock/storage";

  // When
  const imported = import(storageEntry);

  // Then
  await expect(imported).resolves.toHaveProperty("mockStorage");
});
