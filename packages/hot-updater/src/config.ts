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

export { envSecrets, secretEnv } from "@hot-updater/cli-tools";
export type { SecretsAdapter, SecretsContext } from "@hot-updater/plugin-core";
export {
  awsSecretsManager,
  type AwsSecretsManagerCredentials,
  type AwsSecretsManagerOptions,
} from "./awsSecretsManager";
export { githubActions, type GitHubActionsOptions } from "./githubActions";
export {
  googleSecretManager,
  type GoogleSecretManagerOptions,
} from "./googleSecretManager";
export {
  infisical,
  type InfisicalAuth,
  type InfisicalSecretsOptions,
} from "./infisicalSecrets";
