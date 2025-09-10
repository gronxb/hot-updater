import type {
  ConfigInput,
  HotUpdaterConfigOptions,
} from "@hot-updater/plugin-core";

export const defineConfig = (
  config: ConfigInput | ((options: HotUpdaterConfigOptions) => ConfigInput),
) => {
  return config;
};

export {
  generateFingerprints,
  generateFingerprint,
  createFingerprintJson,
  createAndInjectFingerprintFiles,
  readLocalFingerprint,
} from "./utils/fingerprint";
