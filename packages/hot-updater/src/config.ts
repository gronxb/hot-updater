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

export { localSecrets, secret } from "@hot-updater/cli-tools";
export { infisical, type InfisicalOptions } from "./infisical";
export type {
  SecretRef,
  SecretsAdapter,
  SecretsContext,
} from "@hot-updater/plugin-core";
