export { envSecrets as env } from "@hot-updater/cli-tools";
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
export type { SecretsAdapter, SecretsContext } from "@hot-updater/plugin-core";
