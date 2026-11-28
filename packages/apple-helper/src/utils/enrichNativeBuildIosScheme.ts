import fs from "fs";
import path from "path";

import {
  getCwd,
  p,
  type ResolvedNativeBuildIosScheme,
} from "@hot-updater/cli-tools";

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
export type EnrichedNativeBuildIosScheme = ResolvedNativeBuildIosScheme &
  Required<
    Pick<
      ResolvedNativeBuildIosScheme,
      "platform" | "installPods" | "configuration" | "destination" | "simulator"
    >
  > & { hotUpdaterSchemeName: string };
export const enrichNativeBuildIosScheme = async ({
  scheme,
  hotUpdaterSchemeName,
}: {
  scheme: ResolvedNativeBuildIosScheme;
  hotUpdaterSchemeName: string;
}): Promise<EnrichedNativeBuildIosScheme> => {
  return {
    platform: "ios",
    installPods: false,
    configuration: "Release",
    destination: [],
    simulator: false,
    ...scheme,
    exportOptionsPlist: resolveExportOptionsPlist(scheme.exportOptionsPlist),
    hotUpdaterSchemeName,
  };
};
