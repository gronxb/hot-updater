/**
 * The inline `build: bare({ ... })` of a profile's hot-updater.config.ts:
 * prefix, options, and suffix.
 */
export const BARE_BUILD_INLINE_PATTERN =
  /(build:\s*bare\(\{\s*)([^}\n]*?)(\s*\}\s*\))/;

/**
 * Sets the entry file the next deploy bundles: the brownfield widget's own
 * entry for a widget deploy, and bare's default (`index.js`) otherwise. Every
 * deploy rewrites it, so a main deploy after a widget deploy builds the
 * example again. Throws when the config has no inline `bare({ ... })`: a
 * widget deploy must never ship the example's bundle by mistake.
 */
export function setBareEntryFile(
  source: string,
  entryFile: string | null,
): string {
  if (!BARE_BUILD_INLINE_PATTERN.test(source)) {
    if (entryFile === null) return source;
    throw new Error(
      "Failed to locate an inline build: bare({ ... }) in hot-updater.config.ts",
    );
  }
  return source.replace(
    BARE_BUILD_INLINE_PATTERN,
    (_match, prefix: string, options: string, suffix: string) => {
      // The inline options hold no braces, so a comma ends each one.
      const kept = options
        .split(",")
        .map((option) => option.trim())
        .filter((option) => option && !/^entryFile\s*:/.test(option));
      if (entryFile !== null) {
        kept.push(`entryFile: ${JSON.stringify(entryFile)}`);
      }
      const nextOptions = kept.join(", ");
      return `${prefix}${nextOptions}${suffix}`;
    },
  );
}
