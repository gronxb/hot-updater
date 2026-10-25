export { envSecrets as env } from "@hot-updater/cli-tools";
export type { SecretsAdapter, SecretsContext } from "@hot-updater/plugin-core";
export {
  awsSecretsManager,
  type AwsSecretsManagerCredentials,
  type AwsSecretsManagerOptions,
} from "./awsSecretsManager";
export { githubActions, type GitHubActionsOptions } from "./githubActions";
export {
  infisical,
  type InfisicalAuth,
  type InfisicalSecretsOptions,
} from "./infisicalSecrets";
