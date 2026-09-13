import type { Bundle } from "@hot-updater/core";
import { type ChannelRow, MAX_BUNDLE_PATCHES } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabasePluginTestLifecycle } from "./databasePluginTestRunner";
import { setupDatabasePluginTestRunner } from "./databasePluginTestRunner";
import { createBundleFixture } from "./databaseTestFixtures";

export type DatabaseClientTestContract = {
  readonly getBundleById: (id: string) => Promise<Bundle | null>;
  readonly getBundles: (
    options: DatabaseClientTestQueryOptions,
  ) => Promise<DatabaseClientTestPage>;
  readonly getChannels: () => Promise<readonly ChannelRow[]>;
  readonly insertBundle: (bundle: Bundle) => Promise<void>;
  readonly updateBundleById: (
    id: string,
    update: Partial<Bundle>,
  ) => Promise<void>;
  readonly deleteBundleById: (id: string) => Promise<void>;
};

export type DatabaseClientTestQueryOptions = {
  readonly limit: number;
  readonly orderBy?: {
    readonly field: "id";
    readonly direction: "asc" | "desc";
  };
};

export type DatabaseClientTestPage = {
  readonly data: Bundle[];
  readonly pagination: {
    readonly total: number;
    readonly hasNextPage: boolean;
    readonly hasPreviousPage: boolean;
    readonly currentPage: number;
    readonly totalPages: number;
    readonly nextCursor?: string | null;
    readonly previousCursor?: string | null;
  };
};

export type DatabaseClientTestSuiteOptions<TPlugin> =
  DatabasePluginTestLifecycle<TPlugin> & {
    readonly createClient: (plugin: TPlugin) => DatabaseClientTestContract;
  };

export const setupDatabaseClientTestSuite = <TPlugin>(
  options: DatabaseClientTestSuiteOptions<TPlugin>,
): void => {
  setupDatabasePluginTestRunner(options, ({ getPlugin }) => {
    const getClient = (): DatabaseClientTestContract =>
      options.createClient(getPlugin());

    describe("aggregate client", () => {
      it("hydrates patch rows when a bundle is retrieved", async () => {
        const plugin = getPlugin();
        const client = options.createClient(plugin);
        const base = createBundleFixture("101");
        const bundle = {
          ...createBundleFixture("102"),
          patches: [
            {
              baseBundleId: base.id,
              baseFileHash: base.fileHash,
              patchFileHash: "b".repeat(64),
              patchStorageUri: "storage://patches/102.patch",
              byteSize: 3_000_002,
            },
          ],
        } satisfies Bundle;

        await client.insertBundle(base);

        try {
          await client.insertBundle(bundle);
        } catch (error) {
          expect(error).toMatchObject({
            name: "DatabasePatchInsertUnsupportedError",
            bundleId: bundle.id,
          });
          await expect(client.getBundleById(bundle.id)).resolves.toBeNull();
          return;
        }

        await expect(client.getBundleById(bundle.id)).resolves.toMatchObject({
          id: bundle.id,
          patches: bundle.patches,
        });
      });

      it("rejects oversized aggregate patch insertion and replacement", async () => {
        const client = getClient();
        const bases = Array.from(
          { length: MAX_BUNDLE_PATCHES + 1 },
          (_, index) => createBundleFixture(String(300 + index)),
        );
        for (const base of bases) await client.insertBundle(base);
        const owner = createBundleFixture("399");
        const patches = bases.map((base, index) => ({
          baseBundleId: base.id,
          baseFileHash: base.fileHash,
          byteSize: index + 1,
          patchFileHash: index.toString(16).padStart(64, "0"),
          patchStorageUri: `storage://patches/${index}.patch`,
        }));

        await expect(
          client.insertBundle({ ...owner, patches }),
        ).rejects.toMatchObject({ name: "DatabasePluginInputError" });
        await expect(client.getBundleById(owner.id)).resolves.toBeNull();

        await client.insertBundle(owner);
        await expect(
          client.updateBundleById(owner.id, { patches }),
        ).rejects.toMatchObject({ name: "DatabasePluginInputError" });
        await expect(client.getBundleById(owner.id)).resolves.toMatchObject(
          owner,
        );
      });

      it("paginates bundle aggregates using the row count", async () => {
        const bundles = [
          createBundleFixture("201"),
          createBundleFixture("202"),
          createBundleFixture("203"),
        ];
        for (const bundle of bundles) {
          await getClient().insertBundle(bundle);
        }

        const result = await getClient().getBundles({
          limit: 2,
          orderBy: { field: "id", direction: "desc" },
        });

        expect(result.data.map(({ id }) => id)).toEqual([
          bundles[2]?.id,
          bundles[1]?.id,
        ]);
        expect(result.pagination.total).toBe(3);
      });

      it("replaces patches only with atomic aggregate update support", async () => {
        const plugin = getPlugin();
        const client = options.createClient(plugin);
        const firstBase = createBundleFixture("401");
        const secondBase = createBundleFixture("402");
        const bundle = createBundleFixture("403");
        for (const fixture of [firstBase, secondBase, bundle]) {
          await client.insertBundle(fixture);
        }
        try {
          await client.updateBundleById(bundle.id, {
            patches: [
              {
                baseBundleId: secondBase.id,
                baseFileHash: secondBase.fileHash,
                patchFileHash: "d".repeat(64),
                patchStorageUri: "storage://patches/replacement.patch",
                byteSize: 3_000_003,
              },
            ],
          });
        } catch (error) {
          expect(error).toMatchObject({
            name: "DatabasePatchUpdateUnsupportedError",
            bundleId: bundle.id,
          });
          await expect(client.getBundleById(bundle.id)).resolves.toMatchObject({
            patches: [],
          });
          return;
        }

        const updated = await client.getBundleById(bundle.id);

        expect(updated?.patches).toEqual([
          {
            baseBundleId: secondBase.id,
            baseFileHash: secondBase.fileHash,
            patchFileHash: "d".repeat(64),
            patchStorageUri: "storage://patches/replacement.patch",
            byteSize: 3_000_003,
          },
        ]);
      });
    });
  });
};
