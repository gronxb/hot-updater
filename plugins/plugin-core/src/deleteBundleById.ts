import { getBundlePatches } from "@hot-updater/core";

import type {
  Bundle,
  DatabaseBundlePatch,
  DatabasePlugin,
  HotUpdaterContext,
} from "./types";

export const databaseDeleteInternals = Symbol(
  "@hot-updater/plugin-core.databaseDeleteInternals",
);

export interface DeleteBundleByIdInput {
  readonly bundle?: Bundle;
  readonly id: string;
}

export interface DatabaseDeleteInternals<TContext = unknown> {
  stageBundleDelete: (
    context: HotUpdaterContext<TContext> | undefined,
    bundle: Bundle,
  ) => void;
  stageBundlePatchDelete: (
    context: HotUpdaterContext<TContext> | undefined,
    patch: DatabaseBundlePatch,
  ) => void;
}

type DatabasePluginWithDeleteInternals<TContext> = DatabasePlugin<TContext> & {
  readonly [databaseDeleteInternals]?: DatabaseDeleteInternals<TContext>;
};

const bundlePatchDeleteRows = (bundle: Bundle): DatabaseBundlePatch[] =>
  getBundlePatches(bundle).map((patch, index) => ({
    ...patch,
    bundleId: bundle.id,
    id: `${bundle.id}:${patch.baseBundleId}`,
    index,
  }));

export async function deleteBundleById<TContext = unknown>(
  database: DatabasePlugin<TContext>,
  context: HotUpdaterContext<TContext> | undefined,
  input: DeleteBundleByIdInput,
): Promise<Bundle | null> {
  const bundle =
    input.bundle ?? (await database.bundles.get(context, { id: input.id }));

  if (!bundle) {
    return null;
  }
  if (bundle.id !== input.id) {
    throw new Error("Bundle deletion input id does not match bundle id.");
  }

  const internals = (database as DatabasePluginWithDeleteInternals<TContext>)[
    databaseDeleteInternals
  ];
  if (!internals) {
    throw new Error(
      "Bundle deletion requires a database plugin created by createDatabasePlugin.",
    );
  }

  internals.stageBundleDelete(context, bundle);
  for (const patch of bundlePatchDeleteRows(bundle)) {
    internals.stageBundlePatchDelete(context, patch);
  }
  return bundle;
}
