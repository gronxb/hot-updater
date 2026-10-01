import {
  bundleToPatchRows,
  bundleToRow,
  createEngine,
  type EngineDatabase,
} from "@hot-updater/plugin-core";
import type { Bundle } from "@hot-updater/protocol";

/**
 * Stores bundles and their patches with no release, as a database holds an
 * artifact that no release uses. `deploy` always adds a release, and
 * deleting a bundle's last release deletes the bundle, so tests store such
 * bundles through the engine. A patch's base comes before it in `bundles`.
 */
export const storeBundles = async (
  database: EngineDatabase,
  bundles: readonly Bundle[],
): Promise<void> => {
  const engine = createEngine(database);
  try {
    await engine.core.transaction(async (tx) => {
      for (const bundle of bundles) {
        tx.create("bundles", bundleToRow(bundle));
        for (const platformKey of [bundle.platform, "*"]) {
          tx.aggregate(
            "bundle_totals",
            { platform_key: platformKey },
            { bundles: 1 },
          );
        }
        for (const row of bundleToPatchRows(bundle)) {
          tx.create("bundle_patches", row);
        }
      }
    });
  } finally {
    await engine.dispose();
  }
};
