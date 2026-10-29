/** The widest line of a message the CLI prints, inside its 80-column frame. */
export const MESSAGE_WIDTH = 76;

/**
 * A message of `lines`, each at most `MESSAGE_WIDTH` columns, broken at
 * spaces, so a name, a path, or a list it embeds never widens a line. A
 * word longer than a line, such as a URL or a path, gets a line of its
 * own. Lines that fit, such as an indented command, stay as they are.
 */
export const fitMessage = (lines: readonly string[]): string =>
  lines
    .flatMap((line) => {
      if (line.length <= MESSAGE_WIDTH) return [line];
      const fitted: string[] = [];
      let current = "";
      for (const word of line.split(" ").filter(Boolean)) {
        if (current && current.length + 1 + word.length > MESSAGE_WIDTH) {
          fitted.push(current);
          current = word;
        } else {
          current = current ? `${current} ${word}` : word;
        }
      }
      return [...fitted, current];
    })
    .join("\n");
