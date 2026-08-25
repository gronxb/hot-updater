import type { BundleSigningPlugin } from "./types";

export type CreateBundleSigningPluginOptions = BundleSigningPlugin;

export const createBundleSigningPlugin = <
  const TOptions extends CreateBundleSigningPluginOptions,
>(
  options: TOptions,
): TOptions => ({ ...options });
