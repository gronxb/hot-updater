import {
  type CredentialKind,
  credentialOverrideHint,
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

/**
 * Whether the command may sign in to `account` to issue the credential the
 * vault lacks. A sign-in needs someone at a terminal, so it never starts in
 * CI (`CI` is set), even on a terminal a runner allocates, or without a
 * terminal. There it logs what a build resolving the credential would say
 * (`describeUnavailable`: missing, so store it once, or out of the token's
 * scope), that the sign-in runs only at a terminal, and the environment
 * variables that provide the credential without the vault, sets exit code
 * 1, and returns false.
 */
export const canSignIn = async ({
  account,
  kind,
  describeUnavailable,
}: {
  /** What the developer signs in to, such as "Apple Account". */
  account: string;
  /** The credential the sign-in issues. */
  kind: CredentialKind;
  /** Why the vault can't give the credential, as its source words it; asked only here. */
  describeUnavailable: () => Promise<string>;
}): Promise<boolean> => {
  const reason = nonInteractiveReason();
  if (reason === undefined) return true;
  p.log.error(
    `${await describeUnavailable()} Hot Updater signs in to your ${account} to issue it only at a terminal, never ${reason}. ${credentialOverrideHint(kind)}`,
  );
  process.exitCode = 1;
  return false;
};
