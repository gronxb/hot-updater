import { execa } from "execa";

/**
 * `--pull never` once CI's pull step (scripts/ci/pull-integration-images.mjs)
 * has pulled the group's images, so an image the group doesn't list fails by
 * name instead of pulling inside a hook, where a slow pull spends the hook's
 * whole budget without a line of output. Elsewhere, a missing image is
 * pulled as before.
 */
export const dockerPullFlags = (): string[] =>
  process.env.HOT_UPDATER_DOCKER_PULL === "never" ? ["--pull", "never"] : [];

/** The output of a command that may fail, for an error message. */
const outputOf = async (args: readonly string[], env?: NodeJS.ProcessEnv) => {
  const result = await execa("docker", args, {
    env,
    reject: false,
    timeout: 20_000,
    all: true,
  });
  return `$ docker ${args.join(" ")}\n${result.all ?? ""}`.trim();
};

/**
 * Throws `error` with what `diagnostics` print appended, so a setup that
 * fails says which container did what.
 */
export const failWithDocker = async (
  what: string,
  error: unknown,
  diagnostics: readonly (readonly string[])[],
  env?: NodeJS.ProcessEnv,
): Promise<never> => {
  const printed = await Promise.all(
    diagnostics.map((args) => outputOf(args, env)),
  );
  const message = error instanceof Error ? error.message : String(error);
  throw new Error([`${what} failed: ${message}`, ...printed].join("\n\n"), {
    cause: error,
  });
};

/**
 * `docker compose up -d --wait` for `services` of the project `compose`
 * names (its `-f` and `-p` arguments), bounded: the health wait ends after
 * `waitSeconds`, and the whole command, a pull included, before
 * `timeoutMs`. Both stay under the calling hooks' 180-second timeout, so a
 * stuck start fails with the services' state and logs rather than a bare
 * hook timeout. On CI, a whole first spec file, a cold pull of PostgreSQL
 * and MySQL included, takes 33 to 40 seconds.
 */
export const composeUp = async ({
  compose,
  services = [],
  env,
  waitSeconds = 90,
  timeoutMs = 120_000,
}: {
  compose: readonly string[];
  services?: readonly string[];
  env?: NodeJS.ProcessEnv;
  waitSeconds?: number;
  timeoutMs?: number;
}) => {
  try {
    await execa(
      "docker",
      [
        ...compose,
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        String(waitSeconds),
        ...dockerPullFlags(),
        ...services,
      ],
      { env, timeout: timeoutMs },
    );
  } catch (error) {
    await failWithDocker(
      "docker compose up",
      error,
      [
        [...compose, "ps", "-a"],
        [...compose, "logs", "--no-color", "--tail", "40", ...services],
      ],
      env,
    );
  }
};
