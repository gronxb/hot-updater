import type {
  ConfigInput,
  HotUpdaterConfigOptions,
} from "@hot-updater/plugin-core";

export const defineConfig = (
  config: ConfigInput | ((options: HotUpdaterConfigOptions) => ConfigInput),
) => {
  return config;
};

export { generateFingerprints } from "./utils/fingerprint";
