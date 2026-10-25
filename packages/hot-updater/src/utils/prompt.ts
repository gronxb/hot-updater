import {
  CREDENTIAL_ENV_NAMES,
  type CredentialKind,
  nonInteractiveReason,
  p,
} from "@hot-updater/cli-tools";

/**
 * Whether the command can ask `message`. In CI or without a terminal to
 * answer in, it logs the question with how to re-run without it, such as
 * `Re-run with -y`, sets exit code 1, and returns false, rather than wait on
 * a prompt that nobody can answer.
 */
export const canPrompt = (
  message: string,
  rerun = "Re-run with -y",
): boolean => {
  if (nonInteractiveReason() === undefined) return true;
  p.log.error(`${message} ${rerun} in a non-interactive shell.`);
  process.exitCode = 1;
  return false;
};

const describeEnvNames = (kind: CredentialKind) => {
  const names = CREDENTIAL_ENV_NAMES[kind].map(([name, alternative]) =>
    alternative ? `${name} (or ${alternative})` : name,
  );
  return names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
};

/**
 * Whether the command may sign in to `account` to issue the credential the
 * vault lacks as `name`. A sign-in needs someone at a terminal, so it never
 * starts in CI (`CI` is set), even on a terminal a runner allocates, or
 * without a terminal. There it logs what is missing and where, the command
 * that signs in once on a machine where someone can, and the environment
 * variables that provide the credential without the vault, sets exit code
 * 1, and returns false.
 */
export const canSignIn = ({
  account,
  kind,
  name,
  vaultUrl,
  setupCommand,
}: {
  /** What the developer signs in to, such as "Apple Account". */
  account: string;
  /** The credential the sign-in issues. */
  kind: CredentialKind;
  /** The vault secret the build resolves. */
  name: string;
  /** The Console whose vault lacks it. */
  vaultUrl: string;
  /** The command that signs in once and stores the credential. */
  setupCommand: string;
}): boolean => {
  const reason = nonInteractiveReason();
  if (reason === undefined) return true;
  const item = name === kind ? kind : `${name} (${kind})`;
  p.log.error(
    `${item} is not in the vault at ${vaultUrl}, and Hot Updater signs in to your ${account} only at a terminal, never ${reason}. Run \`${setupCommand}\` once on a machine where you can sign in, and builds here read the stored ${kind}, or set ${describeEnvNames(kind)} to provide it without the vault.`,
  );
  process.exitCode = 1;
  return false;
};
