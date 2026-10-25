import { CREDENTIAL_ENV_NAMES } from "./credentialEnvNames";

/**
 * Variables that change how a process loads code or which credentials Hot
 * Updater uses, compared case-insensitively, as Windows and npm read them.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "BASH_ENV",
  "ENV",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "GRADLE_OPTS",
  "RUBYOPT",
  "RUBYLIB",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PERL5OPT",
  // Hot Updater's own: the credential overrides and remoteSigning's token.
  ...Object.values(CREDENTIAL_ENV_NAMES).flat(2),
  "HOT_UPDATER_SIGNING_TOKEN",
]);

const RESERVED_PREFIXES = [
  "LD_",
  "DYLD_",
  "GIT_",
  "NPM_CONFIG_",
  // The OAuth client the Google sign-in issues a Play key with.
  "HOT_UPDATER_GOOGLE_OAUTH_CLIENT_",
  // What infisical() signs in to Infisical with, such as INFISICAL_TOKEN.
  "INFISICAL_",
] as const;

/**
 * Whether `name` is a variable no secret may set: one a loader or
 * interpreter reads (`NODE_*` but `NODE_ENV`, `PATH`, `LD_*`, `DYLD_*`,
 * `BASH_ENV`, `ENV`, `GIT_*`, `npm_config_*`, the JVM's, Gradle's, Ruby's,
 * Python's, and Perl's options), or one Hot Updater reads its credentials
 * from. `secretEnv` refuses these names, and so does every environment the
 * CLI gives a child process from resolved secrets.
 */
export const isReservedVariableName = (name: string): boolean => {
  const upper = name.toUpperCase();
  return (
    RESERVED_NAMES.has(upper) ||
    (upper.startsWith("NODE_") && upper !== "NODE_ENV") ||
    RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
};

/**
 * Throws when `env`, an environment the CLI gives a child process from
 * resolved secrets, sets a reserved variable, naming it and `what` sets it.
 * Returns `env`.
 */
export const assertUnreservedEnv = <T extends Readonly<Record<string, string>>>(
  env: T,
  what: string,
): T => {
  const reserved = Object.keys(env).filter(isReservedVariableName);
  if (reserved.length > 0) {
    throw new Error(
      `${what} would set ${reserved.join(", ")}, which no secret may set: ${reserved.length === 1 ? "it changes" : "they change"} how a process loads code or which credentials Hot Updater uses.`,
    );
  }
  return env;
};
