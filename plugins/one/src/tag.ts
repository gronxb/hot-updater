export interface HotUpdaterPatchesOptions {
  /**
   * The channel the native build embeds.
   * @default "production"
   */
  channel?: string;
  /**
   * The bundle signing public key file the native build embeds, relative to
   * the app root, such as the file `hot-updater keys export-public --output`
   * writes.
   */
  publicKeyPath?: string;
}

/**
 * The key a patch from `hotUpdaterPatches` carries its options under, so the
 * `one()` build adapter finds them in `native.app.patches`.
 */
export const HOT_UPDATER_PATCH = Symbol.for("@hot-updater/one/patches");

/** The options of the first patch in `patches` that `hotUpdaterPatches` made. */
export const findHotUpdaterPatchesOptions = (
  patches: unknown,
): HotUpdaterPatchesOptions | undefined => {
  if (!Array.isArray(patches)) return undefined;
  for (const patch of patches) {
    if (typeof patch === "object" && patch !== null) {
      const options: unknown = Reflect.get(patch, HOT_UPDATER_PATCH);
      if (typeof options === "object" && options !== null) {
        return options as HotUpdaterPatchesOptions;
      }
    }
  }
  return undefined;
};
