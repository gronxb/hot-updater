import { ReleaseManagementError } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { withPublicBundleMutationErrors } from "./public-bundle-error";

describe("public Bundle mutation errors", () => {
  it("keeps the internal error as the cause while hiding Release terminology", async () => {
    const internal = new ReleaseManagementError(
      "ENABLED_RELEASE",
      'Disable Release "bundle-1" before hard deletion.',
    );

    await expect(
      withPublicBundleMutationErrors(() => Promise.reject(internal)),
    ).rejects.toMatchObject({
      message: 'Disable Bundle "bundle-1" before hard deletion.',
      cause: internal,
    });
  });

  it("does not rewrite unrelated diagnostics", async () => {
    const diagnostic = new Error("Release catalog is corrupt.");

    await expect(
      withPublicBundleMutationErrors(() => Promise.reject(diagnostic)),
    ).rejects.toBe(diagnostic);
  });
});
