import type { Bundle } from "@hot-updater/core";
import { describe, expect, it } from "vitest";

import type { DatabasePluginTestLifecycle } from "./databasePluginTestRunner";
import { setupDatabasePluginTestRunner } from "./databasePluginTestRunner";
import { createBundleFixture } from "./databaseTestFixtures";

export type DatabaseClientTestContract = {
  readonly getBundleById: (id: string) => Promise<Bundle | null>;
  readonly getBundles: (
    options: DatabaseClientTestQueryOptions,
  ) => Promise<DatabaseClientTestPage>;
  readonly getChannels: () => Promise<string[]>;
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

const supportsAtomicPatchUpdate = (plugin: unknown): boolean =>
  typeof plugin === "object" &&
  plugin !== null &&
  "transaction" in plugin &&
  typeof plugin.transaction === "function";

export const setupDatabaseClientTestSuite = <TPlugin>(
  options: DatabaseClientTestSuiteOptions<TPlugin>,
): void => {
  setupDatabasePluginTestRunner(options, ({ getPlugin }) => {
    const getClient = (): DatabaseClientTestContract =>
      options.createClient(getPlugin());

    describe("aggregate client", () => {
      it("hydrates patch rows when a bundle is retrieved", async () => {
        const base = createBundleFixture("101");
        const bundle = {
          ...createBundleFixture("102"),
          patches: [
            {
              baseBundleId: base.id,
              baseFileHash: base.fileHash,
              patchFileHash: "patch-hash-102",
              patchStorageUri: "storage://patches/102.patch",
            },
          ],
        } satisfies Bundle;

        await getClient().insertBundle(base);
        await getClient().insertBundle(bundle);

        await expect(
          getClient().getBundleById(bundle.id),
        ).resolves.toMatchObject({ id: bundle.id, patches: bundle.patches });
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

      it("removes a derived channel after its last bundle is deleted", async () => {
        const bundle = createBundleFixture("301", "staging");
        await getClient().insertBundle(bundle);

        await getClient().deleteBundleById(bundle.id);

        await expect(getClient().getChannels()).resolves.not.toContain(
          "staging",
        );
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
        const update = client.updateBundleById(bundle.id, {
          message: "replacement-message",
          patches: [
            {
              baseBundleId: secondBase.id,
              baseFileHash: secondBase.fileHash,
              patchFileHash: "replacement-hash",
              patchStorageUri: "storage://patches/replacement.patch",
            },
          ],
        });

        if (!supportsAtomicPatchUpdate(plugin)) {
          await expect(update).rejects.toMatchObject({
            name: "DatabasePatchUpdateUnsupportedError",
            bundleId: bundle.id,
          });
          await expect(client.getBundleById(bundle.id)).resolves.toMatchObject({
            message: bundle.message,
            patches: [],
          });
          return;
        }

        await update;
        const updated = await client.getBundleById(bundle.id);

        expect(updated?.message).toBe("replacement-message");
        expect(updated?.patches).toEqual([
          {
            baseBundleId: secondBase.id,
            baseFileHash: secondBase.fileHash,
            patchFileHash: "replacement-hash",
            patchStorageUri: "storage://patches/replacement.patch",
          },
        ]);
      });
    });
  });
};
