import { describe, expect, it, vi } from "vitest";

import { createLazyDB } from "./drizzleLazyDB";

describe("createLazyDB transaction capabilities", () => {
  it("does not advertise a transaction for a lazy database before support is known", () => {
    // Given
    const openDatabase = vi.fn(async () => ({
      _: { fullSchema: { bundle_patches: {}, bundles: {} } },
    }));

    // When
    const database = createLazyDB({
      db: openDatabase,
      provider: "postgresql",
      schema: { bundle_patches: {}, bundles: {} },
    });

    // Then
    expect(database.transaction).toBeUndefined();
    expect(openDatabase).not.toHaveBeenCalled();
  });
});
