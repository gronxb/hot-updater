import type { ConfigInput } from "@hot-updater/plugin-core";
import type { HotUpdaterConfigOptions } from "@hot-updater/cli-tools";

export const defineConfig = (
  config: ConfigInput | ((options: HotUpdaterConfigOptions) => ConfigInput),
) => {
  return config;
};

export {
  createAndInjectFingerprintFiles,
  createFingerprintJSON,
  generateFingerprint,
  generateFingerprints,
  readLocalFingerprint,
} from "./utils/fingerprint";
