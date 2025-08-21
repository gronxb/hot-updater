import type { NativeBuildIosScheme } from "@hot-updater/plugin-core";

export type EnrichedNativeBuildIosScheme = NativeBuildIosScheme &
  Required<Pick<NativeBuildIosScheme, "platform">> & {};
