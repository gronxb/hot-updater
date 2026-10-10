import type { HotUpdaterConfigOptions } from "@hot-updater/cli-tools";
import type { ConfigInput } from "@hot-updater/plugin-core";

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
