import {
  assertFirstOtaRuns,
  installFirstOtaOfNativeBuild,
} from "./store-install-patches-from-built-in.ts";
import type { ScenarioDefinition } from "./types.ts";

export const storeInstallBuiltInMismatchDownloadsScenario: ScenarioDefinition =
  {
    name: "store-install-built-in-mismatch-downloads",
    run: async (app) => {
      const marker = "store-install-mismatch-detox";
      await installFirstOtaOfNativeBuild(app, {
        marker,
        // As when store processing rewrote the built-in bundle: the bytes
        // the device has are not the ones the patch was made from.
        beforeInstall: () =>
          app.control(
            "mismatch the patch's base file hash",
            "/e2e/mismatch-patch-base-file-hash",
            {
              baseBundleId: "$nativeBuildMinBundleId",
              bundleId: "$firstOtaBundleId",
            },
          ),
      });
      await app.control(
        "assert the file was downloaded instead of patched",
        "/e2e/assert-manifest-diff-applied",
        {
          bundleId: "$firstOtaBundleId",
          previousBundleId: "$nativeBuildMinBundleId",
        },
      );
      // The device checks the base before it fetches the patch.
      await app.control(
        "assert the patch was never downloaded",
        "/e2e/assert-bundle-artifact-transfers",
        {
          archiveRequests: 0,
          currentBundleId: "$nativeBuildMinBundleId",
          patchRequests: 0,
          targetBundleId: "$firstOtaBundleId",
        },
      );
      await assertFirstOtaRuns(app, marker);
    },
  };
