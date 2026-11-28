import { isCommandLine } from "@hot-updater/cli-tools";

/**
 * What doctor prints for people where `--json` keeps the full sentence, for
 * agents and scripts: `--json`'s text doesn't change with this list.
 */
const SHORTER: readonly (readonly [RegExp, string])[] = [
  [
    /Pass init's saved inputs as <env file> to migrate and redeploy in one run:/u,
    "Upgrade with init's saved inputs as <env file>:",
  ],
  [/ ?A server of an earlier release answers 503[^.]*\.?/u, ""],
  [
    / and migrate its database as it deploys:[\s\S]*$/u,
    ", and migrate its database:",
  ],
  [
    /^If hot-updater\.config\.ts names the database hot-updater init saved, the first command migrates it and redeploys the server in one run\./u,
    "If this is the database init saved, run the first command.",
  ],
  [/, which migrates it and redeploys the server in one run/u, ""],
  [
    /keys remove` to remove public keys, or enable signing in hot-updater\.config\.ts/u,
    "keys remove`, or enable signing.",
  ],
  [/ Hot Updater never moves a schema back\./u, ""],
  [
    / Hot Updater's migrations create missing tables and change no existing one\./u,
    "",
  ],
  [
    /: `hot-updater init` deploys [^,]+(?:, [^,]+)*, and running it again sets the plugins in hot-updater\.config\.ts to those, so it would drop (it|them)\./u,
    ", and init would drop $1.",
  ],
  [/ and run doctor again, which then names init; or,/u, ", or,"],
];

/** `text` without what doctor doesn't print for people. */
export const humanText = (text: string): string =>
  SHORTER.reduce(
    (result, [long, short]) => result.replace(long, short),
    text,
  ).trim();

/**
 * A missing name's commands: one, with `<name>`, when they differ only in the
 * name, since each name takes the same action.
 */
const oneCommandEach = (
  names: readonly string[],
  commands: readonly string[],
): readonly string[] => {
  const shapes = new Set(
    commands.map((command, index) =>
      command
        .split(" ")
        .map((word) => (word === names[index] ? "<name>" : word))
        .join(" "),
    ),
  );
  return commands.length > 1 && shapes.size === 1 ? [...shapes] : commands;
};

/**
 * A warning that nothing reads a missing name yet: which names, that nothing
 * reads them, and the command that stores them, without saying it twice.
 */
export const unusedSecretsText = ({
  names,
  message,
  resolution,
}: {
  readonly names: readonly string[];
  readonly message: string;
  readonly resolution: string;
}): string =>
  [
    message.replace(", so nothing fails.", "."),
    ...oneCommandEach(
      names,
      resolution.split("\n").filter((line) => isCommandLine(line)),
    ),
  ].join("\n");
