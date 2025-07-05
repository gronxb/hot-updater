import type { SnakeCaseBundle, SnakeCaseNativeBuild } from "@hot-updater/core";

export interface Database {
  bundles: SnakeCaseBundle;
  native_builds: SnakeCaseNativeBuild;
}
