import { INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS } from "@hot-updater/plugin-core/internal";
import { describe, expect, it } from "vitest";

import { firebaseInstallationKey } from "./firebaseEventIndex";

describe("firebase Insights digest order", () => {
  it("matches the provider-neutral canonical JSON vectors", () => {
    expect(
      INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS.map(({ installId }) =>
        firebaseInstallationKey(installId),
      ),
    ).toEqual(
      INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS.map(
        ({ sha256Hex }) => sha256Hex,
      ),
    );
  });
});
