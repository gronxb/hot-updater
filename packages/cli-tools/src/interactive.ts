/**
 * Whether the environment is a CI run: `CI` is set to anything but empty,
 * `0`, or `false`. GitHub Actions, GitLab CI, CircleCI, Buildkite, Bitrise,
 * and Codemagic set it.
 */
export const isCI = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => {
  const value = env["CI"]?.trim().toLowerCase();
  return (
    value !== undefined && value !== "" && value !== "0" && value !== "false"
  );
};

/**
 * Why the CLI can't ask anything here, or undefined when it can: in CI,
 * where a runner may give the job a terminal nobody answers in, and without
 * a terminal on stdin. Prompts and sign-ins both check it.
 */
export const nonInteractiveReason = ({
  env = process.env,
  input = process.stdin,
}: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly input?: { readonly isTTY?: boolean };
} = {}): string | undefined => {
  if (isCI(env)) return "in CI (CI is set)";
  if (!input.isTTY) return "without a terminal";
  return undefined;
};
