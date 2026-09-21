import type { RsbuildPlugin } from "@lynx-js/rspeedy";

export declare function compilerPageResourceEntries(
  resourceSet: string,
): string[];
export declare function compilerPageGraphPlugin(options: {
  resourceEntries: readonly string[];
}): RsbuildPlugin;
