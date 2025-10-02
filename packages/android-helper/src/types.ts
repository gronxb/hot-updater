import type { NativeBuildOptions } from "@hot-updater/plugin-core";

export type AndroidDevice = {
  deviceId: string | undefined;
  readableName: string;
  connected: boolean;
  type: "emulator" | "phone";
};

export type AndroidUser = {
  id: string;
  name: string;
};

export interface AndroidNativeRunOptions extends NativeBuildOptions {
  device?: string | boolean;
  port?: string;
  mainActivity?: string;
  user?: string;
}
