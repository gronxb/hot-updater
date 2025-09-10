import type { NativeBuildOptions } from "@hot-updater/plugin-core";

export interface IosNativeRunOptions extends NativeBuildOptions {
  device?: string | boolean;
}
