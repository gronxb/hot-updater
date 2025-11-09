import { getCwd, p } from "@hot-updater/cli-tools";
import type { NativeBuildIosScheme } from "@hot-updater/plugin-core";
import fs from "fs";
import path from "path";

const resolveExportOptionsPlist = (exportOptionsPlist?: string) => {
  const resolvedExportOptionsPlist = exportOptionsPlist
    ? path.isAbsolute(exportOptionsPlist)
      ? exportOptionsPlist
      : path.resolve(getCwd(), exportOptionsPlist)
    : undefined;

  if (
    resolvedExportOptionsPlist &&
    !fs.existsSync(resolvedExportOptionsPlist)
  ) {
    p.log.error(
      `exportOptionsPlist doesn't exist in ${resolvedExportOptionsPlist}`,
    );
    process.exit(1);
  }

  return resolvedExportOptionsPlist;
};

/**
 * Validated scheme filled nullish values with default values.
 */
export type EnrichedNativeBuildIosScheme = NativeBuildIosScheme &
  Required<
    Pick<
      NativeBuildIosScheme,
      "platform" | "installPods" | "configuration" | "verbose" | "destination"
    >
  >;
export const enrichNativeBuildIosScheme = async (
  scheme: NativeBuildIosScheme,
): Promise<EnrichedNativeBuildIosScheme> => {
  return {
    platform: "ios",
    installPods: true,
    configuration: "Release",
    verbose: false,
    destination: [],
    ...scheme,
    exportOptionsPlist: resolveExportOptionsPlist(scheme.exportOptionsPlist),
  };
};
