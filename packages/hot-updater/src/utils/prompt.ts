import { nonInteractiveReason, p } from "@hot-updater/cli-tools";

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
  p.log.error(`${message}\n${rerun} in a non-interactive shell.`);
  process.exitCode = 1;
  return false;
};

/**
 * Whether the command may sign in to `account` to issue the credential the
 * config's `secrets` adapter lacks. A sign-in needs someone at a terminal,
 * so it never starts in CI (`CI` is set), even on a terminal a runner
 * allocates, or without a terminal. There it logs that the credential is
 * missing, why it can't sign in, and the command that stores it
 * (`describeUnavailable`), sets exit code 1, and returns false.
 */
export const canSignIn = async ({
  account,
  describeUnavailable,
}: {
  /** What the developer signs in to, such as "Apple Account". */
  account: string;
  /** What is missing, and the command that stores it; asked only here. */
  describeUnavailable: () => Promise<{ missing: string; fix: string }>;
}): Promise<boolean> => {
  const reason = nonInteractiveReason();
  if (reason === undefined) return true;
  const { missing, fix } = await describeUnavailable();
  p.log.error(
    [missing, `Can't sign in to your ${account} ${reason}.`, fix].join("\n"),
  );
  process.exitCode = 1;
  return false;
};
