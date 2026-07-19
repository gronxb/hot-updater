import type { Bundle } from "@hot-updater/core";
import { describe, expect, it } from "vitest";

import type { DatabaseAdapterTestLifecycle } from "./databaseAdapterTestRunner";
import { setupDatabaseAdapterTestRunner } from "./databaseAdapterTestRunner";
import { createBundleFixture } from "./databaseTestFixtures";

export type DatabaseClientTestContract<TContext> = {
  readonly getBundleById: (
    id: string,
    context?: TContext,
  ) => Promise<Bundle | null>;
  readonly getBundles: (
    options: DatabaseClientTestQueryOptions,
    context?: TContext,
  ) => Promise<DatabaseClientTestPage>;
  readonly getChannels: (context?: TContext) => Promise<string[]>;
  readonly insertBundle: (bundle: Bundle, context?: TContext) => Promise<void>;
  readonly updateBundleById: (
    id: string,
    update: Partial<Bundle>,
    context?: TContext,
  ) => Promise<void>;
  readonly deleteBundleById: (id: string, context?: TContext) => Promise<void>;
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

export type DatabaseClientTestSuiteOptions<TAdapter, TContext> =
  DatabaseAdapterTestLifecycle<TAdapter, TContext> & {
    readonly createClient: (
      adapter: TAdapter,
    ) => DatabaseClientTestContract<TContext>;
  };

export const setupDatabaseClientTestSuite = <TAdapter, TContext>(
  options: DatabaseClientTestSuiteOptions<TAdapter, TContext>,
): void => {
  setupDatabaseAdapterTestRunner(options, ({ context, getAdapter }) => {
    const getClient = (): DatabaseClientTestContract<TContext> =>
      options.createClient(getAdapter());

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

        await getClient().insertBundle(base, context);
        await getClient().insertBundle(bundle, context);

        await expect(
          getClient().getBundleById(bundle.id, context),
        ).resolves.toMatchObject({ id: bundle.id, patches: bundle.patches });
      });

      it("paginates bundle aggregates using the row count", async () => {
        const bundles = [
          createBundleFixture("201"),
          createBundleFixture("202"),
          createBundleFixture("203"),
        ];
        for (const bundle of bundles) {
          await getClient().insertBundle(bundle, context);
        }

        const result = await getClient().getBundles(
          {
            limit: 2,
            orderBy: { field: "id", direction: "desc" },
          },
          context,
        );

        expect(result.data.map(({ id }) => id)).toEqual([
          bundles[2]?.id,
          bundles[1]?.id,
        ]);
        expect(result.pagination.total).toBe(3);
      });

      it("removes a derived channel after its last bundle is deleted", async () => {
        const bundle = createBundleFixture("301", "staging");
        await getClient().insertBundle(bundle, context);

        await getClient().deleteBundleById(bundle.id, context);

        await expect(getClient().getChannels(context)).resolves.not.toContain(
          "staging",
        );
      });

      it("replaces patch rows during a bundle update", async () => {
        const firstBase = createBundleFixture("401");
        const secondBase = createBundleFixture("402");
        const bundle = createBundleFixture("403");
        for (const fixture of [firstBase, secondBase, bundle]) {
          await getClient().insertBundle(fixture, context);
        }
        await getClient().updateBundleById(
          bundle.id,
          {
            patches: [
              {
                baseBundleId: secondBase.id,
                baseFileHash: secondBase.fileHash,
                patchFileHash: "replacement-hash",
                patchStorageUri: "storage://patches/replacement.patch",
              },
            ],
          },
          context,
        );

        const updated = await getClient().getBundleById(bundle.id, context);

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
