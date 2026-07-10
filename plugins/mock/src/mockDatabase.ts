import { NIL_UUID } from "@hot-updater/core";
import {
  type Bundle,
  type DatabaseBundlePatch,
  type DatabaseBundleRecord,
  type DatabasePluginDeclaration,
  filterCompatibleAppVersions,
  resolveUpdateInfoFromBundles,
  toBundleReadModel,
  toDatabaseBundlePatches,
  toDatabaseBundleRecord,
} from "@hot-updater/plugin-core";
import { createLegacyDatabasePlugin } from "@hot-updater/plugin-core/internal";

import { minMax, sleep } from "./util/utils";

export interface MockDatabaseConfig {
  latency: { min: number; max: number };
  initialBundles?: Bundle[];
}

export const mockDatabase = createLegacyDatabasePlugin({
  name: "mockDatabase",
  connect: (config: MockDatabaseConfig): DatabasePluginDeclaration => {
    const bundleRecords = new Map<string, DatabaseBundleRecord>();
    const bundlePatches = new Map<string, DatabaseBundlePatch[]>();

    for (const bundle of config.initialBundles ?? []) {
      bundleRecords.set(bundle.id, toDatabaseBundleRecord(bundle));
      bundlePatches.set(bundle.id, toDatabaseBundlePatches(bundle));
    }

    const getBundles = (): Bundle[] =>
      Array.from(bundleRecords.values()).map((bundle) =>
        toBundleReadModel(bundle, bundlePatches.get(bundle.id) ?? []),
      );

    return {
      bundles: {
        async getById({ bundleId }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          return bundleRecords.get(bundleId) ?? null;
        },
        async findRecords() {
          await sleep(minMax(config.latency.min, config.latency.max));
          return Array.from(bundleRecords.values());
        },
        async insert({ bundle }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          bundleRecords.set(bundle.id, bundle);
        },
        async update({ bundleId, patch }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          const current = bundleRecords.get(bundleId);
          if (!current) {
            throw new Error("targetBundleId not found");
          }
          bundleRecords.set(bundleId, { ...current, ...patch, id: bundleId });
        },
        async delete({ bundleId }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          if (!bundleRecords.delete(bundleId)) {
            throw new Error(`Bundle with id ${bundleId} not found`);
          }
        },
      },
      patches: {
        storage: "embedded",
        async findPatches() {
          await sleep(minMax(config.latency.min, config.latency.max));
          return Array.from(bundlePatches.values()).flat();
        },
        async getBundlePatches({ bundleId }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          if (!bundleRecords.has(bundleId)) return null;
          return bundlePatches.get(bundleId) ?? [];
        },
        async replaceBundlePatches({ bundleId, patches }) {
          await sleep(minMax(config.latency.min, config.latency.max));
          bundlePatches.set(bundleId, [...patches]);
        },
      },
      updateInfo: {
        async get(args) {
          const bundles = getBundles();
          const channel = args.channel ?? "production";
          const minBundleId = args.minBundleId ?? NIL_UUID;

          if (args._updateStrategy === "appVersion") {
            const targetAppVersions = Array.from(
              new Set(
                bundles
                  .filter(
                    (bundle) =>
                      bundle.enabled &&
                      bundle.platform === args.platform &&
                      bundle.channel === channel &&
                      bundle.id.localeCompare(minBundleId) >= 0 &&
                      bundle.targetAppVersion,
                  )
                  .map((bundle) => bundle.targetAppVersion)
                  .filter((version): version is string => Boolean(version)),
              ),
            );
            const compatibleAppVersions = filterCompatibleAppVersions(
              targetAppVersions,
              args.appVersion,
            );
            const updateBundles = bundles.filter(
              (bundle) =>
                bundle.enabled &&
                bundle.platform === args.platform &&
                bundle.channel === channel &&
                bundle.id.localeCompare(minBundleId) >= 0 &&
                compatibleAppVersions.includes(bundle.targetAppVersion ?? ""),
            );

            return resolveUpdateInfoFromBundles({
              args: { ...args, channel, minBundleId },
              bundles: updateBundles,
            });
          }

          const updateBundles = bundles.filter(
            (bundle) =>
              bundle.enabled &&
              bundle.platform === args.platform &&
              bundle.channel === channel &&
              bundle.id.localeCompare(minBundleId) >= 0 &&
              bundle.fingerprintHash === args.fingerprintHash,
          );

          return resolveUpdateInfoFromBundles({
            args: { ...args, channel, minBundleId },
            bundles: updateBundles,
          });
        },
      },
    };
  },
});
